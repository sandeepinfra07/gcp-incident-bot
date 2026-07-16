'use strict';

const https = require('https');
const http = require('http');
const { Firestore } = require('@google-cloud/firestore');
const { PubSub } = require('@google-cloud/pubsub');

const PROJECT = 'YOUR_GCP_PROJECT_ID';
const pubsub = new PubSub();
const TEAM_ID = 'YOUR_TEAM_ID';
const STATE_IN_PROGRESS = 'YOUR_STATE_IN_PROGRESS_ID';
const LABEL_P1 = 'YOUR_LABEL_P1_ID';
const ASSIGNEE_SANDEEP = 'YOUR_ASSIGNEE_PRIMARY_ID';
const GEMINI_MODEL = 'gemini-2.5-flash';
const LOG_WINDOW_MINUTES = 60;
const COLLECTION = 'incident-conversations';

let _db = null;
let _accessToken = null;
let _tokenExpiry = 0;

function getDb() {
  if (!_db) _db = new Firestore({ projectId: PROJECT });
  return _db;
}

function getSecrets() {
  return {
    linearApiKey: process.env.LINEAR_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    gchatWebhook: process.env.GCHAT_WEBHOOK || '',
  };
}

function post(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getScopedToken(scopes) {
  return new Promise((resolve, reject) => {
    if (_accessToken && Date.now() < _tokenExpiry) return resolve(_accessToken);
    const qs = scopes ? `?scopes=${encodeURIComponent(scopes)}` : '';
    const req = http.get({
      hostname: 'metadata.google.internal', port: 80,
      path: `/computeMetadata/v1/instance/service-accounts/default/token${qs}`,
      headers: { 'Metadata-Flavor': 'Google' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const t = JSON.parse(d);
          _accessToken = t.access_token;
          _tokenExpiry = Date.now() + (t.expires_in - 60) * 1000;
          resolve(_accessToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function isValidProdService(name) {
  return /^prod-/.test(name) || /-prod$/.test(name);
}

function extractServiceName(text) {
  const matches = text.match(/(prod-[a-z0-9-]+|[a-z0-9-]+-prod)/gi);
  return matches ? matches[0].toLowerCase() : null;
}

async function getConversation(spaceId, threadId) {
  const db = getDb();
  const docId = `${spaceId}_${threadId}`;
  const doc = await db.collection(COLLECTION).doc(docId).get();
  return { docId, exists: doc.exists, data: doc.exists ? doc.data() : null };
}

async function saveConversation(docId, data) {
  const db = getDb();
  await db.collection(COLLECTION).doc(docId).set(data, { merge: true });
}

async function deleteConversation(docId) {
  const db = getDb();
  await db.collection(COLLECTION).doc(docId).delete();
}

function buildGeminiPrompt(conversation, latestMessage) {
  let sections = '';
  const f = conversation?.fields || {};
  for (const [key, val] of Object.entries(f)) {
    sections += `${key.toUpperCase()}: ${val || '(not yet provided)'}\n`;
  }

  const history = (conversation?.history || []).map(h => `${h.role}: ${h.text}`).join('\n');

  return `You are Incident Bot, a Senior SRE bot for YOUR_COMPANY running on GCP. Your job is to help users report production incidents.

CURRENTLY COLLECTED INFORMATION:
${sections}

CONVERSATION SO FAR:
${history}

USER'S LATEST MESSAGE: ${latestMessage}

INSTRUCTIONS:
1. Extract or update the following fields from the conversation:
   - SERVICE: The specific prod Cloud Run service name (must start with "prod-" or end with "-prod"). If user mentions a generic name, try to map it.
   - ERROR: Description of the error/symptoms the user is seeing
   - TIMEFRAME: When the issue started or was first noticed
   - CHANGES: Any recent deployments, config changes, or relevant context

2. Determine which required fields are still missing. Required: SERVICE and ERROR.

3. If user said "no" or similar without providing new info, acknowledge and re-ask.

4. Respond ONLY with a JSON object:
{
  "fields": { "service": "...", "error": "...", "timeframe": "...", "changes": "..." },
  "ready": true/false,
  "nextQuestion": "Natural follow-up question or empty string if ready",
  "summary": "One-line summary of the incident if ready, otherwise empty"
}`;
}

async function callGemini(prompt, geminiApiKey) {
  const res = await post(
    'generativelanguage.googleapis.com',
    `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1024 } },
    {}
  );
  const text = res?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('Gemini error:', JSON.stringify(res).substring(0, 500));
    return null;
  }
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error('Gemini parse error:', text.substring(0, 500));
    return null;
  }
}

async function analyzeLogsWithGemini(logs, summary, geminiApiKey) {
  const prompt = `You are a Senior SRE analyzing Cloud Logging data for a production incident.

Incident Summary: ${summary || 'N/A'}

Raw error logs from Cloud Logging (last ${LOG_WINDOW_MINUTES} minutes):
${logs || 'No error logs found.'}

Analyze the logs and provide:
1. Root cause - what is actually failing
2. Affected component/service
3. Error patterns (frequency, type)
4. Recommended immediate action

Keep the analysis concise and actionable. Respond in plain text, max 200 words.`;
  const res = await post(
    'generativelanguage.googleapis.com',
    `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1024 } },
    {}
  );
  return res?.candidates?.[0]?.content?.parts?.[0]?.text || 'No analysis available.';
}

async function fetchCloudRunLogs(serviceName) {
  try {
    const token = await getScopedToken('https://www.googleapis.com/auth/logging.read');
    const now = new Date();
    const start = new Date(now - LOG_WINDOW_MINUTES * 60 * 1000).toISOString();
    const filter = [
      'resource.type="cloud_run_revision"',
      `resource.labels.service_name="${serviceName}"`,
      'severity>=ERROR',
      `timestamp>="${start}"`,
    ].join(' && ');

    const body = JSON.stringify({ filter, orderBy: 'timestamp desc', pageSize: 20 });
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'logging.googleapis.com', path: '/v2/entries:list', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${token}` },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } }); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const entries = res?.entries || [];
    if (!entries.length) return null;
    return entries.slice(0, 10).map(e => {
      const ts = e.timestamp || '';
      const msg = e.jsonPayload?.message || e.textPayload || JSON.stringify(e.jsonPayload || '');
      return `[${ts}] ${msg}`;
    }).join('\n');
  } catch (err) {
    console.error('Log fetch error:', err.message);
    return null;
  }
}

async function createLinearTicket(title, description, apiKey) {
  const res = await post('api.linear.app', '/graphql', {
    query: `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url title } }
    }`,
    variables: {
      input: { teamId: TEAM_ID, title, description, priority: 2, stateId: STATE_IN_PROGRESS, assigneeId: ASSIGNEE_SANDEEP, labelIds: [LABEL_P1] },
    },
  }, { Authorization: apiKey });
  if (!res?.data?.issueCreate?.success) {
    console.error('Linear error:', JSON.stringify(res));
    throw new Error('Linear ticket creation failed');
  }
  return res.data.issueCreate.issue;
}

async function publishToDispatcher(incident, ticketId, ticketUrl, logAnalysis) {
  try {
    const message = {
      source: 'prod-chat-bot',
      chatBotTicket: { identifier: ticketId, url: ticketUrl, summary: incident.summary || '' },
      incident: {
        state: 'open',
        policy_name: `ChatBot-${incident.summary || incident.service || 'Incident'}`,
        url: ticketUrl,
        resource: {
          type: 'cloud_run_revision',
          labels: { service_name: incident.service || '', project_id: PROJECT },
        },
        summary: incident.summary || `Incident: ${incident.service}`,
        observed_value: incident.error || '',
        logAnalysis,
      },
    };
    await pubsub.topic('projects/YOUR_GCP_PROJECT_ID/topics/YOUR_PUBSUB_TOPIC').publishMessage({
      data: Buffer.from(JSON.stringify(message)),
    });
    console.log(`Published to YOUR_PUBSUB_TOPIC for ticket ${ticketId}`);
  } catch (err) {
    console.error('Failed to publish to dispatcher:', err.message);
  }
}

async function postChatMessage(spaceName, text, threadName) {
  try {
    const token = await getScopedToken('https://www.googleapis.com/auth/chat.bot');
    const body = threadName ? { text, thread: { name: threadName } } : { text };
    await post('chat.googleapis.com', `/v1/${spaceName}/messages`, body, {
      Authorization: `Bearer ${token}`,
    });
  } catch (err) {
    console.error('Chat API error:', err.message);
  }
}

function buildTicketDescription(incident, logAnalysis) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `## 🔴 Incident Reported via Chat Bot

### Summary
${incident.summary || 'No summary'}

### Details
| Field | Value |
|-------|-------|
| **Service** | ${incident.service || 'Unknown'} |
| **Error** | ${incident.error || 'Unknown'} |
| **Timeframe** | ${incident.timeframe || 'Unknown'} |
| **Recent Changes** | ${incident.changes || 'None reported'} |
| **Reported At** | ${now} IST |
| **Reported By** | ${incident.reporter || 'Unknown'} |

### Log Analysis
${logAnalysis || 'Log analysis not available'}

---
_Generated by Incident Bot_`;
}

async function respondInThread(spaceName, threadName, text) {
  await postChatMessage(spaceName, text, threadName);
}

function normalizeEvent(event) {
  if (event.commonEventObject && event.chat) {
    return {
      type: 'MESSAGE',
      space: event.chat.space || event.space,
      message: event.chat.message || event.message,
      user: event.chat.user || event.user,
    };
  }
  if (event.eventType) {
    return {
      type: event.eventType,
      space: event.chat?.space || event.space,
      message: event.chat?.message || event.message,
      user: event.chat?.user || event.user,
    };
  }
  return event;
}

async function processEvent(rawEvent) {
  const event = normalizeEvent(rawEvent);
  const eventType = event.type || '';
  console.log('Chat event type:', eventType);

  const spaceName = event.space?.name || '';
  const threadName = event.message?.thread?.name || '';
  const threadId = threadName || `${spaceName}_thread_${Date.now()}`;
  const senderName = event.user?.displayName || event.user?.email || 'Unknown';

  const msgText = event.message?.text;
  console.log('Event space:', spaceName, '| user:', senderName, '| msg keys:', event.message ? Object.keys(event.message) : 'NO MSG', '| text:', msgText);

  if (eventType === 'ADDED_TO_SPACE') {
    const welcome = '👋 Hello! I\'m **Incident Bot**. Mention me with `@Incident Bot` and describe your issue to report a production incident.';
    if (spaceName) await respondInThread(spaceName, threadName, welcome);
    return;
  }

  if (eventType === 'REMOVED_FROM_SPACE') return;

  if (eventType !== 'MESSAGE') return;

  const messageText = (event.message?.text || '').trim();
  if (!messageText) return;

  const { docId, exists, data: conv } = await getConversation(spaceName, threadId);
  const history = conv?.history || [];
  const fields = conv?.fields || { service: '', error: '', timeframe: '', changes: '' };

  const cleanText = messageText.replace(/@Incident\s*Bot/gi, '').trim();
  history.push({ role: 'user', text: cleanText, name: senderName, at: new Date().toISOString() });

  if (conv?.complete) {
    await respondInThread(spaceName, threadName, 'This incident has already been resolved and a ticket created. If you have a **new** issue, please start a fresh thread.');
    return;
  }

  const secrets = getSecrets();
  const prompt = buildGeminiPrompt({ fields, history: history.slice(0, -1) }, cleanText);
  const geminiResult = await callGemini(prompt, secrets.geminiApiKey);

  if (!geminiResult) {
    await respondInThread(spaceName, threadName, 'I\'m having trouble understanding. Could you please rephrase? You can say things like:\n- "payment service is down with 502 errors"\n- "prod-inventory-service throwing exceptions"\n- "users can\'t access the portal"');
    return;
  }

  const updatedFields = {
    service: geminiResult.fields?.service || fields.service,
    error: geminiResult.fields?.error || fields.error,
    timeframe: geminiResult.fields?.timeframe || fields.timeframe,
    changes: geminiResult.fields?.changes || fields.changes,
  };

  if (updatedFields.service && !isValidProdService(updatedFields.service)) {
    updatedFields.service = '';
    await saveConversation(docId, { fields: updatedFields, history, complete: false, spaceName, threadId, reporter: senderName, updatedAt: new Date().toISOString() });
    await respondInThread(spaceName, threadName, `⚠️ "${updatedFields.service}" doesn't look like a prod service. Prod services usually start with \`prod-\` or end with \`-prod\`. Could you confirm the exact service name? (e.g., \`prod-payment-service\`)`);
    return;
  }

  const ready = geminiResult.ready === true;
  const summary = geminiResult.summary || '';

  if (!ready) {
    const nextQ = geminiResult.nextQuestion || 'Could you provide more details about the issue?';
    await saveConversation(docId, { fields: updatedFields, history, complete: false, spaceName, threadId, reporter: senderName, updatedAt: new Date().toISOString() });
    await respondInThread(spaceName, threadName, nextQ);
    return;
  }

  await saveConversation(docId, { fields: updatedFields, history, complete: true, spaceName, threadId, reporter: senderName, step: 'investigating', updatedAt: new Date().toISOString() });
  await respondInThread(spaceName, threadName, '🔍 Investigating the issue... I\'ll check Cloud Logging and post the findings in a moment.');

  const serviceName = updatedFields.service;
  console.log(`Investigating: ${serviceName} | ${summary}`);

  const rawLogs = await fetchCloudRunLogs(serviceName);
  const logAnalysis = rawLogs
    ? await analyzeLogsWithGemini(rawLogs, summary, secrets.geminiApiKey)
    : '✅ No ERROR-level logs found in the last hour. The issue may be intermittent or at a different layer.';

  const incident = { ...updatedFields, summary, reporter: senderName };
  const description = buildTicketDescription(incident, logAnalysis);

  let ticketId = '';
  let ticketUrl = '';
  try {
    const ticket = await createLinearTicket(`[P1-High] ${summary || serviceName + ' issue'}`, description, secrets.linearApiKey);
    ticketId = ticket.identifier;
    ticketUrl = ticket.url;
    console.log(`Ticket created: ${ticketId}`);
    await saveConversation(docId, { complete: true, step: 'done', ticketId, ticketUrl, logAnalysis, updatedAt: new Date().toISOString() });
    await publishToDispatcher(incident, ticketId, ticketUrl, logAnalysis);
  } catch (err) {
    await saveConversation(docId, { complete: true, step: 'done', ticketError: err.message, updatedAt: new Date().toISOString() });
  }

  let resultText = `📋 **Incident Report — ${summary}**\n\n`;
  resultText += `*Service:* ${serviceName}\n`;
  resultText += `*Error:* ${updatedFields.error || 'N/A'}\n`;
  resultText += `*Timeframe:* ${updatedFields.timeframe || 'N/A'}\n`;
  if (updatedFields.changes) resultText += `*Changes:* ${updatedFields.changes}\n`;
  resultText += `\n*Log Analysis:*\n${logAnalysis}\n`;
  if (ticketId) {
    resultText += `\n✅ *Ticket Created:* ${ticketId} — ${ticketUrl}`;
  } else {
    resultText += `\n❌ *Failed to create ticket.* Manual intervention needed.`;
  }

  await respondInThread(spaceName, resultText, threadName);
}

exports.prodChatBot = async (req, res) => {
  try {
    const rawBody = req.body || {};
    const pubsubMessage = rawBody?.message?.data;
    let chatEvent;
    if (pubsubMessage) {
      chatEvent = JSON.parse(Buffer.from(pubsubMessage, 'base64').toString());
    } else if (rawBody.eventType || rawBody.type) {
      chatEvent = rawBody;
    } else {
      res.status(400).send('Bad Request');
      return;
    }
    res.status(200).send('OK');
    await processEvent(chatEvent);
  } catch (err) {
    console.error('prod-chat-bot error:', err.message, err.stack);
    if (!res.headersSent) res.status(200).send('OK');
  }
};
