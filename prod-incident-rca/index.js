'use strict';

const https = require('https');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const client  = new SecretManagerServiceClient();
const PROJECT = 'YOUR_GCP_PROJECT_ID';
const TEAM_ID = 'YOUR_TEAM_ID';
const DONE_STATE_ID = 'YOUR_DONE_STATE_ID';
const RCA_MARKER = '## 🤖 AI-Generated RCA';
const RECENCY_WINDOW_MS = 30 * 60 * 1000;

// Google Workspace config for Directory API
const WORKSPACE_ADMIN_EMAIL = 'YOUR_EMAIL@YOUR_DOMAIN';
const WORKSPACE_DOMAIN      = 'YOUR_DOMAIN';

// ─── SECRET MANAGER ───────────────────────────────────────────────────────────
let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const names = [
    'YOUR_LINEAR_API_KEY_SECRET',
    'YOUR_SLACK_WEBHOOK_SECRET',
    'YOUR_GEMINI_API_KEY_SECRET',
    'YOUR_GCHAT_WEBHOOK_SECRET',
    'YOUR_SMTP_USERNAME_SECRET',
    'YOUR_SMTP_PASSWORD_SECRET',
  ];
  const results = await Promise.all(
    names.map(name =>
      client.accessSecretVersion({
        name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
      }).then(([r]) => r.payload.data.toString('utf8').trim())
    )
  );
  _secrets = {
    linearApiKey: results[0],
    slackWebhook: results[1],
    geminiApiKey: results[2],
    gchatWebhook: results[3],
    smtpUsername: results[4],
    smtpPassword: results[5],
  };
  return _secrets;
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function post(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req  = https.request({
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

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── GOOGLE WORKSPACE DELEGATED TOKEN ────────────────────────────────────────
// Gets a token impersonating WORKSPACE_ADMIN_EMAIL via domain-wide delegation.
// Uses IAM signBlob (no private key needed — works with any SA on Cloud Run).
async function getWorkspaceDelegatedToken() {
  const http = require('http');

  // Step 1: Get default SA access token from metadata server
  const metaRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'metadata.google.internal',
      port: 80,
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });

  // Step 2: Get SA email from metadata server
  const saEmail = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'metadata.google.internal',
      port: 80,
      path: '/computeMetadata/v1/instance/service-accounts/default/email',
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    });
    req.on('error', reject);
    req.end();
  });

  console.log(`Building delegated token for SA: ${saEmail}`);

  // Step 3: Build JWT header + payload (unsigned)
  const b64url = obj =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const now         = Math.floor(Date.now() / 1000);
  const unsignedJwt = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss  : saEmail,
    sub  : WORKSPACE_ADMIN_EMAIL,
    scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    aud  : 'https://oauth2.googleapis.com/token',
    iat  : now,
    exp  : now + 3600,
  })}`;

  // Step 4: Sign JWT using IAM signBlob (avoids needing raw private key)
  const signRes = await post(
    'iam.googleapis.com',
    `/v1/projects/YOUR_GCP_PROJECT_ID/serviceAccounts/${encodeURIComponent(saEmail)}:signBlob`,
    { bytesToSign: Buffer.from(unsignedJwt).toString('base64') },
    { Authorization: `Bearer ${metaRes.access_token}` }
  );

  if (!signRes.signedBlob && !signRes.signature) {
    console.error('signBlob response:', JSON.stringify(signRes));
    throw new Error('Failed to sign JWT via IAM signBlob');
  }

  const signature = (signRes.signedBlob || signRes.signature)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const signedJwt = `${unsignedJwt}.${signature}`;

  // Step 5: Exchange signed JWT for access token
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`;
  const tokenRes  = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path    : '/token',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenBody),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(tokenBody);
    req.end();
  });

  if (!tokenRes.access_token) {
    console.error('Token exchange response:', JSON.stringify(tokenRes));
    throw new Error('Failed to get delegated Workspace access token');
  }

  console.log('Successfully obtained delegated Workspace token');
  return tokenRes.access_token;
}

// ─── FETCH RCA RECIPIENTS FROM GOOGLE WORKSPACE ──────────────────────────────
// Queries Directory API for all users whose custom attribute
// RCA Notifications.rca_group matches the given Linear label name.
async function fetchRcaRecipients(rcaLabelName) {
  console.log(`Fetching Workspace users with rca_group = "${rcaLabelName}"...`);

  const accessToken = await getWorkspaceDelegatedToken();
  const recipients  = [];
  let pageToken     = null;

  do {
    const pagePart = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const path     = `/admin/directory/v1/users?domain=${WORKSPACE_DOMAIN}&projection=full&maxResults=500${pagePart}`;

    const res = await get('admin.googleapis.com', path, {
      Authorization: `Bearer ${accessToken}`,
    });

    if (res.error) {
      console.error('Directory API error:', JSON.stringify(res.error));
      throw new Error(`Directory API error: ${res.error.message}`);
    }

    const users = res.users || [];
    console.log(`Directory API page: ${users.length} users fetched`);

    for (const user of users) {
      // Schema name is "RCA_Notifications", field is "rca_group" which is an array of {type, value}
      const rcaGroupValues = user.customSchemas?.['RCA_Notifications']?.rca_group;
      if (rcaGroupValues && Array.isArray(rcaGroupValues)) {
        // Check if any value matches the label name (e.g., "Engineering" or "RCA: Engineering")
        const hasMatch = rcaGroupValues.some(g => g.value === rcaLabelName || g.value === rcaLabelName.replace(/^RCA:\s*/, ''));
        if (hasMatch) {
          recipients.push(user.primaryEmail);
          console.log(`  ✓ ${user.primaryEmail} → rca_group values: ${rcaGroupValues.map(g => g.value).join(', ')}`);
        }
      }
    }

    pageToken = res.nextPageToken || null;
  } while (pageToken);

  console.log(`Total recipients for "${rcaLabelName}": ${recipients.length}`);
  return recipients;
}

// ─── LINEAR ───────────────────────────────────────────────────────────────────
async function linearQuery(query, variables, apiKey) {
  return post('api.linear.app', '/graphql', { query, variables: variables || {} }, { Authorization: apiKey });
}

const RCA_FOLLOWUP_MARKER = '## 🤖 AI-Generated RCA (Follow-up)';
const REOPEN_WINDOW_MS    = 6 * 60 * 60 * 1000; // 6 hours

async function getTicketsNeedingRca(apiKey) {
  const cutoff = new Date(Date.now() - RECENCY_WINDOW_MS).toISOString();
  const res = await linearQuery(`
    {
      issues(
        filter: {
          team: { id: { eq: "${TEAM_ID}" } }
          state: { id: { eq: "${DONE_STATE_ID}" } }
          updatedAt: { gte: "${cutoff}" }
        }
        first: 20
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title description priority
          createdAt updatedAt url
          assignee { name }
          state { name }
          labels { nodes { id name } }
          history { nodes { createdAt fromState { name } toState { name } } }
          comments { nodes { body createdAt user { name } } }
        }
      }
    }
  `, {}, apiKey);

  console.log('Linear response:', JSON.stringify(res).substring(0, 500));
  const issues = res?.data?.issues?.nodes || [];
  console.log(`Done issues in last 30min: ${issues.length}`);

  const result = [];

  for (const issue of issues) {
    const isGcpTicket = (issue.description || '').includes('Generated by GCP Incident Bot');
    if (!isGcpTicket) {
      console.log(`${issue.identifier}: Skipping — description does not contain "Generated by GCP Incident Bot"`);
      continue;
    }

    const comments = issue.comments?.nodes || [];
    const history  = issue.history?.nodes || [];

    const hasFirstRca    = comments.some(c => c.body.includes(RCA_MARKER) && !c.body.includes('Follow-up'));
    const hasFollowupRca = comments.some(c => c.body.includes(RCA_FOLLOWUP_MARKER));

    if (!hasFirstRca && !hasFollowupRca) {
      console.log(`${issue.identifier}: No RCA yet → 1st RCA needed`);
      issue._rcaType = 'first';
      result.push(issue);
      continue;
    }

    if (hasFirstRca && !hasFollowupRca) {
      const firstRcaComment = comments.find(c => c.body.includes(RCA_MARKER) && !c.body.includes('Follow-up'));
      const firstRcaTime    = new Date(firstRcaComment.createdAt).getTime();

      const reopenEvent = history.find(h => {
        const eventTime    = new Date(h.createdAt).getTime();
        const wasReopened  = h.fromState?.name === 'Done' &&
          ['In Progress', 'Todo', 'Backlog'].includes(h.toState?.name);
        const withinWindow = eventTime > firstRcaTime && eventTime <= firstRcaTime + REOPEN_WINDOW_MS;
        return wasReopened && withinWindow;
      });

      if (reopenEvent) {
        console.log(`${issue.identifier}: Reopened within 6hrs → Follow-up RCA needed`);
        issue._rcaType = 'followup';
        result.push(issue);
      } else {
        console.log(`${issue.identifier}: Has 1st RCA, not reopened within 6hrs → skipping`);
      }
      continue;
    }

    if (hasFollowupRca) {
      console.log(`${issue.identifier}: Already has follow-up RCA → skipping`);
    }
  }

  return result;
}

async function postLinearComment(issueId, body, apiKey) {
  return linearQuery(
    `mutation { commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(body)} }) { success } }`,
    {}, apiKey
  );
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function generateRca(issue, geminiApiKey) {
  const labels      = issue.labels?.nodes?.map(l => l.name).join(', ') || 'None';
  const assignee    = issue.assignee?.name || 'Unassigned';
  const createdAt   = new Date(issue.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const resolvedAt  = new Date(issue.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const durationMs  = new Date(issue.updatedAt) - new Date(issue.createdAt);
  const durationMin = Math.round(durationMs / 60000);
  const duration    = durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin} minutes`;

  const comments = (issue.comments?.nodes || [])
    .map(c => `[${new Date(c.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST] ${c.user?.name || 'System'}: ${c.body}`)
    .join('\n') || 'No comments recorded.';

  const isFollowup = issue._rcaType === 'followup';

  // For follow-up, filter out the initial RCA comment to save tokens
  let promptComments = comments;
  if (isFollowup) {
    const lines = comments.split('\n');
    const filtered = lines.filter(line => !line.includes('## 🤖 AI-Generated RCA') && !line.includes('## 🤖 AI RCA Generated'));
    promptComments = filtered.join('\n') || 'No relevant comments found.';
  }

  const prompt = isFollowup
    ? `You are a Senior SRE at YOUR_COMPANY, a B2B commerce platform running on GCP.
A production incident ticket was resolved, an RCA was generated, but the ticket was REOPENED within 6 hours and resolved again. Write a Follow-up RCA focusing on WHY the incident recurred.

INCIDENT DETAILS:
- Ticket: ${issue.identifier}
- Title: ${issue.title}
- Severity: ${labels}
- Assigned To: ${assignee}
- Initially Detected At: ${createdAt} IST
- Finally Resolved At: ${resolvedAt} IST
- Total Duration: ${duration}

INCIDENT DESCRIPTION:
${issue.description || 'No description available.'}

FULL TIMELINE (including reopen - excluding initial RCA):
${promptComments}

Write a Follow-up RCA using exactly these sections:

## Follow-up RCA Summary
## Recurrence Timeline
## Why Initial Fix Was Insufficient
## Root Cause (Confirmed)
## Resolution
## Action Items
## Lessons Learned

---
*Auto-generated by GCP Incident Bot using Gemini AI | Infra Ops Team (Follow-up RCA)*`
    : `You are a Senior SRE at YOUR_COMPANY, a B2B commerce platform running on GCP.
Write a professional, detailed Root Cause Analysis (RCA) for the following production incident.

INCIDENT DETAILS:
- Ticket: ${issue.identifier}
- Title: ${issue.title}
- Severity: ${labels}
- Assigned To: ${assignee}
- Detected At: ${createdAt} IST
- Resolved At: ${resolvedAt} IST
- Total Duration: ${duration}

INCIDENT DESCRIPTION:
${issue.description || 'No description available.'}

INCIDENT TIMELINE (comments):
${comments}

Write a thorough RCA using exactly these sections:

## RCA Summary
## Timeline
## Root Cause
## Impact
## Resolution
## Action Items
## Lessons Learned

---
*Auto-generated by GCP Incident Bot using Gemini AI | Infra Ops Team*`;

  const res = await post(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8000 },
    },
    {}
  );

  const text = res?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('Gemini error:', JSON.stringify(res));
    throw new Error('No response from Gemini');
  }
  return text;
}

// ─── SLACK ────────────────────────────────────────────────────────────────────
async function notifySlack(issue, rcaText, slackWebhook) {
  const slackUrl = new URL(slackWebhook);
  const summary  = rcaText.split('\n').slice(2, 6).join(' ').substring(0, 300);
  await post('hooks.slack.com', slackUrl.pathname + slackUrl.search, {
    attachments: [{
      color: '#36a64f',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `📄 ${issue._rcaType === 'followup' ? 'Follow-up RCA Ready' : 'RCA Ready'} — ${issue.identifier}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${issue.title}*\n${summary}...` } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'View Full RCA in Linear' }, url: issue.url, style: 'primary' },
        ]},
      ],
    }],
  }, {});
  console.log('Slack RCA notification sent');
}

// ─── GCHAT ────────────────────────────────────────────────────────────────────
async function notifyGChat(issue, rcaText, gchatWebhook) {
  const gchatUrl = new URL(gchatWebhook);
  const summary  = rcaText.split('\n').slice(2, 6).join(' ').substring(0, 300);
  await post('chat.googleapis.com', gchatUrl.pathname + gchatUrl.search, {
    text: `📄 *${issue._rcaType === 'followup' ? 'Follow-up RCA Ready' : 'RCA Ready'} — ${issue.identifier}*\n*${issue.title}*\n\n${summary}...\n\n🔗 View Full RCA: ${issue.url}`,
  }, {});
  console.log('GChat RCA notification sent');
}

// ─── BUILD GMAIL-COMPATIBLE HTML EMAIL ────────────────────────────────────────
function parseRcaSections(rcaText) {
  const sections = {};
  const lines = rcaText.split('\n');
  let currentSection = '';
  let currentContent = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      currentSection = sectionMatch[1].trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim();
  }
  return sections;
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildRcaEmail(issue, rcaText, isFollowup) {
  const labels     = issue.labels?.nodes?.map(l => l.name).filter(n => !n.startsWith('RCA:')).join(', ') || 'P2';
  const assignee   = issue.assignee?.name || 'Unassigned';
  const resolvedAt = new Date(issue.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const createdDate = new Date(issue.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
  const createdTime = new Date(issue.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const resolvedTime = new Date(issue.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const durationMs  = new Date(issue.updatedAt) - new Date(issue.createdAt);
  const durationMin = Math.round(durationMs / 60000);
  const durationStr = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`;

  const isP0 = labels.includes('P0');
  const isP1 = labels.includes('P1');
  const rcaTypeLabel = isFollowup ? 'Follow-up RCA' : 'Incident Resolved';
  const sectionIcon = isFollowup ? '🔄' : '📋';
  const title = escapeHtml(issue.title);
  const safeAssignee = escapeHtml(assignee);
  const url = issue.url || '#';

  const severityBadge = isP0 ? 'P0 Critical' : isP1 ? 'P1 High' : 'P2 Medium';

  const sections = parseRcaSections(rcaText);

  const formatText = (text) => text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px;">$1</code>');

  // RCA Summary
  const summaryContent = sections['Summary'] || sections['RCA Summary'] || '';
  const summaryHtml = summaryContent ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">📌 RCA Summary</h3>
                    <p style="margin:0;color:#475569;font-size:14px;line-height:1.7;">${formatText(summaryContent)}</p>
                  </td>
                </tr>
              </table>` : '';

  // Timeline
  const timelineContent = sections['Timeline'] || sections['Recurrence Timeline'] || '';
  let timelineRows = '';
  if (timelineContent) {
    timelineContent.split('\n').filter(l => l.trim()).forEach(line => {
      if (line.trim()) {
        timelineRows += `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(line.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`;
      }
    });
  }
  const timelineHtml = timelineRows ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">⏱ Timeline</h3>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">${timelineRows}</table>
                  </td>
                </tr>
              </table>` : '';

  // Root Cause
  const rootCauseContent = sections['Root Cause'] || sections['Root Cause (Confirmed)'] || '';
  let rootCauseIntro = '', rootCauseRows = '';
  if (rootCauseContent) {
    const lines = rootCauseContent.split('\n');
    const firstLine = lines[0] || '';
    if (!firstLine.match(/^[\*\-\d\.]/)) {
      rootCauseIntro = `<p style="margin:0 0 10px;color:#475569;font-size:14px;line-height:1.7;">${formatText(firstLine)}</p>`;
      rootCauseRows = lines.slice(1).filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('');
    } else {
      rootCauseRows = lines.filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('');
    }
  }
  const rootCauseHtml = rootCauseRows ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">🔍 Root Cause</h3>
                    ${rootCauseIntro}
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">${rootCauseRows}</table>
                  </td>
                </tr>
              </table>` : '';

  // Impact
  const impactContent = sections['Impact'] || '';
  const impactHtml = impactContent ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">💥 Impact</h3>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${impactContent.split('\n').filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('')}
                    </table>
                  </td>
                </tr>
              </table>` : '';

  // Resolution
  const resolutionContent = sections['Resolution'] || '';
  let resolutionIntro = '', resolutionRows = '';
  if (resolutionContent) {
    const lines = resolutionContent.split('\n');
    const firstLine = lines[0] || '';
    if (!firstLine.match(/^[\*\-\d\.]/)) {
      resolutionIntro = `<p style="margin:0 0 10px;color:#475569;font-size:14px;line-height:1.7;">${formatText(firstLine)}</p>`;
      resolutionRows = lines.slice(1).filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('');
    } else {
      resolutionRows = lines.filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('');
    }
  }
  const resolutionHtml = resolutionRows ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">✅ Resolution</h3>
                    ${resolutionIntro}
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">${resolutionRows}</table>
                  </td>
                </tr>
              </table>` : '';

  // Action Items
  const actionContent = sections['Action Items'] || '';
  const actionHtml = actionContent ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">📝 Action Items</h3>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${actionContent.split('\n').filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:8px 0 8px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('')}
                    </table>
                  </td>
                </tr>
              </table>` : '';

  // Lessons Learned
  const lessonsContent = sections['Lessons Learned'] || '';
  const lessonsHtml = lessonsContent ? `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td>
                    <h3 style="margin:0 0 14px;color:#1a1a2e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">💡 Lessons Learned</h3>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${lessonsContent.split('\n').filter(l => l.trim()).map(l => `<tr><td style="color:#475569;font-size:14px;line-height:1.7;padding:6px 0 6px 4px;border-bottom:1px solid #f1f5f9;">${formatText(l.trim().replace(/^[\*\-\d\.]\s*/, ''))}</td></tr>`).join('')}
                    </table>
                  </td>
                </tr>
              </table>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${rcaTypeLabel} - ${issue.identifier}</title>
</head>
<body style="margin:0;padding:40px 20px;background:#f0f2f5;font-family:'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5;">
    <tr>
      <td align="center" style="padding:40px 20px;">

        <table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">

          <tr>
            <td style="height:5px;background:linear-gradient(90deg,#ea4335 0%,#fbbc04 50%,#34a853 100%);font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <tr>
            <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:36px 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="width:52px;height:52px;background:rgba(255,255,255,0.2);border-radius:14px;text-align:center;vertical-align:middle;font-size:26px;">${sectionIcon}</td>
                        <td style="padding-left:14px;">
                          <p style="margin:0 0 4px;color:rgba(255,255,255,0.8);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;">Root Cause Analysis</p>
                          <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${rcaTypeLabel}</h1>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" valign="middle">
                    <span style="background:#fef2f2;border:2px solid #fecaca;padding:8px 16px;border-radius:24px;font-size:14px;font-weight:700;color:#dc2626;display:inline-block;">${severityBadge}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:20px 0 0;color:rgba(255,255,255,0.9);font-size:15px;line-height:1.6;">A production incident has been resolved. Review the detailed analysis below to understand what happened and the steps being taken to prevent recurrence.</p>
            </td>
          </tr>

          <tr>
            <td style="background:#f8fafc;padding:24px 40px;">
              <h2 style="margin:0 0 6px;color:#1e293b;font-size:18px;font-weight:600;">${title}</h2>
              <p style="margin:0;color:#64748b;font-size:13px;">
                <a href="${url}" style="color:#1a73e8;text-decoration:none;font-weight:500;">${issue.identifier}</a> · Resolved by <strong>${safeAssignee}</strong>
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
                <tr>
                  <td width="25%" style="padding-right:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;">
                      <tr><td style="padding:14px 8px;text-align:center;">
                        <p style="margin:0;color:#94a3b8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Duration</p>
                        <p style="margin:6px 0 0;color:#1e293b;font-size:18px;font-weight:700;">${durationStr}</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="25%" style="padding-right:6px;padding-left:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;">
                      <tr><td style="padding:14px 8px;text-align:center;">
                        <p style="margin:0;color:#94a3b8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Detected</p>
                        <p style="margin:6px 0 0;color:#1e293b;font-size:14px;font-weight:700;">${createdTime}</p>
                        <p style="margin:2px 0 0;color:#94a3b8;font-size:11px;">${createdDate}</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="25%" style="padding-right:6px;padding-left:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;">
                      <tr><td style="padding:14px 8px;text-align:center;">
                        <p style="margin:0;color:#94a3b8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Resolved</p>
                        <p style="margin:6px 0 0;color:#1e293b;font-size:14px;font-weight:700;">${resolvedTime}</p>
                        <p style="margin:2px 0 0;color:#94a3b8;font-size:11px;">${createdDate}</p>
                      </td></tr>
                    </table>
                  </td>
                  <td width="25%" style="padding-left:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
                      <tr><td style="padding:14px 8px;text-align:center;">
                        <p style="margin:0;color:#94a3b8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Status</p>
                        <p style="margin:6px 0 0;color:#1e293b;font-size:18px;font-weight:700;">Resolved</p>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr><td style="height:1px;background:#e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>

          <tr>
            <td style="padding:32px 40px;">
              ${summaryHtml}
              ${timelineHtml}
              ${rootCauseHtml}
              ${impactHtml}
              ${resolutionHtml}
              ${actionHtml}
              ${lessonsHtml}
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background:#1a1a2e;border-radius:12px;">
                    <a href="${url}" style="display:block;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:16px 24px;text-align:center;">View Full Ticket in Linear →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <p style="margin:0;color:#64748b;font-size:13px;"><strong style="color:#475569;">GCP Incident Bot</strong> · Infra Ops Team</p>
                    <p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">YOUR_COMPANY · ${resolvedAt}</p>
                  </td>
                  <td align="right" valign="middle">
                    <span style="background:#fef3c7;color:#b45309;font-size:11px;font-weight:600;padding:6px 12px;border-radius:16px;display:inline-block;">⏱ Monitoring Active · 6h</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─── SEND RCA EMAIL VIA SMTP ──────────────────────────────────────────────────
async function sendRcaEmail(issue, rcaText, isFollowup, smtpUsername, smtpPassword) {
  const rcaLabels = (issue.labels?.nodes || [])
    .map(l => l.name);

  if (!rcaLabels.length) {
    console.log(`${issue.identifier}: No labels on ticket — skipping email`);
    return;
  }

  console.log(`${issue.identifier}: RCA labels found: ${rcaLabels.join(', ')}`);

  const recipientSets = await Promise.all(
    rcaLabels.map(label => fetchRcaRecipients(label.replace(/^RCA:\s*/, "").trim()))
  );

  const allRecipients = [...new Set(recipientSets.flat())];

  if (!allRecipients.length) {
    console.log(`${issue.identifier}: No Workspace users found for labels [${rcaLabels.join(', ')}] — skipping email`);
    return;
  }

  console.log(`${issue.identifier}: Sending RCA email to: ${allRecipients.join(', ')}`);

  const rcaType = isFollowup ? 'Follow-up RCA' : 'RCA';
  const subject = `[${rcaType}] ${issue.identifier} — ${issue.title}`;
  const fullHtml = buildRcaEmail(issue, rcaText, isFollowup);
  const textBody = `${rcaText}\n\n--\nAuto-generated by GCP Incident Bot | Infra Ops Team\nView ticket: ${issue.url}`;

  const tls = require('tls');

  await new Promise((resolve, reject) => {
    const boundary = `rca_boundary_${Date.now()}`;
    const htmlBase64 = Buffer.from(fullHtml, 'utf-8').toString('base64');
    const textBase64 = Buffer.from(textBody, 'utf-8').toString('base64');
    
    const message = [
      `From: GCP Incident Bot <${smtpUsername}>`,
      `To: ${allRecipients.join(', ')}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      textBase64,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      htmlBase64,
      ``,
      `--${boundary}--`,
    ].join('\r\n');

    let step = 0;
    let socket;
    const steps = [
      () => socket.write(`EHLO smtp.gmail.com\r\n`),
      () => socket.write(`AUTH LOGIN\r\n`),
      () => socket.write(Buffer.from(smtpUsername).toString('base64') + '\r\n'),
      () => socket.write(Buffer.from(smtpPassword).toString('base64') + '\r\n'),
      () => socket.write(`MAIL FROM:<${smtpUsername}>\r\n`),
      ...allRecipients.map(r => () => socket.write(`RCPT TO:<${r}>\r\n`)),
      () => socket.write(`DATA\r\n`),
      () => socket.write(message + '\r\n.\r\n'),
      () => socket.write(`QUIT\r\n`),
    ];

    socket = tls.connect({ host: 'smtp.gmail.com', port: 465 }, () => {
      console.log('SMTP connected');
    });

    socket.on('data', data => {
      const response = data.toString();
      console.log('SMTP:', response.trim().substring(0, 100));
      if (response.startsWith('4') || response.startsWith('5')) {
        reject(new Error(`SMTP error: ${response.trim()}`));
        return;
      }
      if (step < steps.length) {
        steps[step]();
        step++;
      } else {
        resolve();
        socket.destroy();
      }
    });

    socket.on('error', err => reject(err));
    socket.setTimeout(15000, () => reject(new Error('SMTP timeout')));
  });

  console.log(`${issue.identifier}: RCA email sent successfully → ${allRecipients.join(', ')}`);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.prodIncidentRca = async (message, context) => {
  try {
    console.log('prod-incident-rca triggered');
    const secrets = await getSecrets();
    const tickets = await getTicketsNeedingRca(secrets.linearApiKey);
    console.log(`Tickets needing RCA: ${tickets.length}`);

    if (!tickets.length) {
      console.log('No tickets need RCA. Done.');
      return;
    }

    for (const issue of tickets) {
      try {
        console.log(`Generating RCA for: ${issue.identifier} — ${issue.title}`);
        const rca = await generateRca(issue, secrets.geminiApiKey);
        console.log(`Gemini RCA generated, length: ${rca.length}`);

        const marker     = issue._rcaType === 'followup' ? RCA_FOLLOWUP_MARKER : RCA_MARKER;
        const commentRes = await postLinearComment(
          issue.id,
          `${marker}\n\n${rca}`,
          secrets.linearApiKey
        );
        console.log('Linear comment result:', JSON.stringify(commentRes).substring(0, 200));

        await notifySlack(issue, rca, secrets.slackWebhook);
        await notifyGChat(issue, rca, secrets.gchatWebhook);

        await sendRcaEmail(
          issue, rca,
          issue._rcaType === 'followup',
          secrets.smtpUsername,
          secrets.smtpPassword
        );

        console.log(`RCA complete for: ${issue.identifier}`);

      } catch (err) {
        console.error(`RCA failed for ${issue.identifier}:`, err.message);
      }
    }

  } catch (err) {
    console.error('prod-incident-rca fatal error:', err.message, err.stack);
    throw err;
  }
};
