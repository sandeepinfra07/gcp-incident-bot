'use strict';

const https = require('https');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const client  = new SecretManagerServiceClient();
const PROJECT = 'YOUR_GCP_PROJECT_ID';

const TEAM_ID           = 'YOUR_TEAM_ID';
const STATE_IN_PROGRESS = 'YOUR_STATE_IN_PROGRESS_ID';
const LABELS = {
  P0: 'YOUR_LABEL_P0_ID',
  P1: 'YOUR_LABEL_P1_ID',
  P2: 'YOUR_LABEL_P2_ID',
};
const DONE_STATE_ID         = 'YOUR_DONE_STATE_ID';
const RCA_ENGINEERING_LABEL = 'YOUR_RCA_LABEL_ID';

const ASSIGNEES = {
  SANDEEP:  'YOUR_ASSIGNEE_PRIMARY_ID',
  JAYENDRA: 'YOUR_ASSIGNEE_SECONDARY_ID',
};

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const names = [
    'YOUR_LINEAR_API_KEY_SECRET',
    'YOUR_SLACK_WEBHOOK_SECRET',
    'YOUR_GCHAT_WEBHOOK_SECRET',
    'YOUR_GEMINI_API_KEY_SECRET',
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
    gchatWebhook: results[2],
    geminiApiKey: results[3],
  };
  return _secrets;
}

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

async function withRetry(fn, retries = 3, delayMs = 500, label = 'operation') {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) {
        console.error(`${label} failed after ${retries} attempts:`, err.message);
        throw err;
      }
      console.warn(`${label} attempt ${attempt} failed — retrying in ${delayMs}ms:`, err.message);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

function getSeverity(policyName) {
  const name = policyName || '';
  if (name.includes('Instance Down') || name.includes('Server Down') || name.includes('VM Down'))
    return { level: 'P0', label: 'P0-Critical', labelId: LABELS.P0, priority: 1, emoji: '🔴', assigneeId: ASSIGNEES.SANDEEP, slackColor: '#FF0000' };
  if (name.includes('- Critical') || name.includes('Cloud Run Error'))
    return { level: 'P0', label: 'P0-Critical', labelId: LABELS.P0, priority: 1, emoji: '🔴', assigneeId: ASSIGNEES.SANDEEP, slackColor: '#FF0000' };
  if (name.includes('- Error'))
    return { level: 'P1', label: 'P1-High', labelId: LABELS.P1, priority: 2, emoji: '🟠', assigneeId: ASSIGNEES.JAYENDRA, slackColor: '#FF8C00' };
  if (name.includes('- Warning'))
    return { level: 'P2', label: 'P2-Medium/Low', labelId: LABELS.P2, priority: 3, emoji: '🟡', assigneeId: ASSIGNEES.JAYENDRA, slackColor: '#FFD700' };
  return { level: 'P2', label: 'P2-Medium/Low', labelId: LABELS.P2, priority: 3, emoji: '🟡', assigneeId: ASSIGNEES.JAYENDRA, slackColor: '#FFD700' };
}

function getResourceInfo(incident) {
  const type       = incident?.resource?.type || '';
  const labels     = incident?.resource?.labels || {};
  const systemName = incident?.metadata?.system_labels?.name || '';
  const proj       = labels.project_id || PROJECT;
  const rawDbId    = labels.database_id || '';
  const cleanDbId  = rawDbId.includes(':') ? rawDbId.split(':').pop() : rawDbId;

  if (type === 'cloudsql_database' || rawDbId) {
    const name = cleanDbId || systemName || 'Unknown DB';
    return {
      resourceName: name,
      resourceTypeLabel: 'Cloud SQL',
      gcpConsoleUrl: `https://console.cloud.google.com/sql/instances/${name}/overview?project=${proj}`,
    };
  }
  if (type === 'cloud_run_revision' || labels.service_name) {
    const name = labels.service_name || systemName || 'Unknown Service';
    return {
      resourceName: name,
      resourceTypeLabel: 'Cloud Run',
      gcpConsoleUrl: `https://console.cloud.google.com/run/detail/YOUR_GCP_REGION/${name}?project=${proj}`,
    };
  }
  if (type === 'gce_disk') {
    const name = systemName || labels.disk_name || 'Unknown Disk';
    return {
      resourceName: name,
      resourceTypeLabel: 'GCE Disk',
      gcpConsoleUrl: `https://console.cloud.google.com/compute/disksDetail/zones/${labels.zone || 'YOUR_GCP_REGION'}/disks/${name}?project=${proj}`,
    };
  }
  if (type === 'gce_instance') {
    const zone = labels.zone || 'YOUR_GCP_REGION';
    const zoneName = zone.replace(/^[^\/]+\//, '');
    const name = systemName || labels.instance_name || 'Unknown Instance';
    return {
      resourceName: name,
      resourceTypeLabel: 'VM Instance',
      gcpConsoleUrl: `https://console.cloud.google.com/compute/instancesDetail/zones/${zoneName}/instances/${name}?project=${proj}`,
    };
  }
  return {
    resourceName: systemName || type || 'Unknown',
    resourceTypeLabel: type || 'Unknown Resource',
    gcpConsoleUrl: `https://console.cloud.google.com/home?project=${proj}`,
  };
}

function getSLA(level) {
  return { P0: { ack: '0 min', resolve: '1 hour' }, P1: { ack: '15 min', resolve: '2 hours' } }[level]
    || { ack: '30 min', resolve: '4 hours' };
}

function getAssigneeName(level) {
  return level === 'P0' ? 'YOUR_NAME' : 'YOUR_ASSIGNEE_NAME';
}

async function findExistingTicket(alertName, resourceName, apiKey) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const titleSearch = `[P0-Critical] ${alertName} — ${resourceName}`;
  const res = await withRetry(() => post('api.linear.app', '/graphql', {
    query: `{
      issues(
        filter: {
          team: { id: { eq: "${TEAM_ID}" } }
          state: { name: { in: ["In Progress", "Todo", "Backlog"] } }
          createdAt: { gte: "${cutoff}" }
          title: { containsIgnoreCase: "${resourceName}" }
        }
        first: 10
        orderBy: createdAt
      ) {
        nodes { id identifier title url state { name } }
      }
    }`,
    variables: {},
  }, { Authorization: apiKey }), 3, 500, 'Linear search');

  const issues = res?.data?.issues?.nodes || [];
  return issues.find(i =>
    i.title.includes(resourceName) &&
    i.title.includes(alertName.substring(0, 20))
  ) || null;
}

async function addStillFiringComment(issueId, incidentTime, observedValue, apiKey) {
  const body = `⚠️ **Alert Still Firing** — ${incidentTime} IST\n\nObserved Value: **${observedValue || 'N/A'}**\n\n_GCP re-fired this alert. Incident is still active — no new ticket created._`;
  await post('api.linear.app', '/graphql', {
    query: `mutation { commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(body)} }) { success } }`,
    variables: {},
  }, { Authorization: apiKey });
}

async function autoCloseTicket(issueId, apiKey) {
  const fetchRes = await withRetry(() => post('api.linear.app', '/graphql', {
    query: `{
      issue(id: "${issueId}") {
        id
        labelIds
      }
    }`,
    variables: {},
  }, { Authorization: apiKey }), 3, 500, 'Linear fetch issue');

  const currentLabels = fetchRes?.data?.issue?.labelIds || [];
  const mergedLabels = [...new Set([...currentLabels, RCA_ENGINEERING_LABEL])];

  await withRetry(() => post('api.linear.app', '/graphql', {
    query: `mutation {
      issueUpdate(id: "${issueId}", input: {
        labelIds: ${JSON.stringify(mergedLabels)},
        stateId: "${DONE_STATE_ID}"
      }) { success }
    }`,
    variables: {},
  }, { Authorization: apiKey }), 3, 500, 'Linear update labels + state');

  const body = '✅ Alert resolved — metric returned to normal. Auto-closed by GCP Incident Bot.';
  await withRetry(() => post('api.linear.app', '/graphql', {
    query: `mutation { commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(body)} }) { success } }`,
    variables: {},
  }, { Authorization: apiKey }), 3, 500, 'Linear auto-close comment');
}

async function generateAiTriage(alertName, resourceName, resourceTypeLabel, observedValue, threshold, summary, errorLogs, geminiApiKey) {
  const errorSection = errorLogs ? `\nERROR LOGS / DETAILS:\n${errorLogs}\n` : '';
  const prompt = `You are a Senior SRE at YOUR_COMPANY, a B2B commerce platform on GCP.
A production alert has fired. Generate a specific, actionable triage checklist for the on-call engineer.

INCIDENT DETAILS:
- Alert: ${alertName}
- Resource: ${resourceName}
- Resource Type: ${resourceTypeLabel}
- Observed Value: ${observedValue || 'N/A'}
- Threshold: ${threshold || 'N/A'}
- Summary: ${summary || 'N/A'}
${errorSection}
Generate exactly 5 triage checklist items for this incident.
Rules:
1. Each item MUST start with "- [ ] " on its own line
2. Separate each item with a newline character
3. Be specific — mention ${resourceName} and the exact metric
4. No generic steps — every step must be actionable for THIS alert
5. Output ONLY the 5 checklist items, no headers, no extra text

Example format:
- [ ] First specific action for ${resourceName}
- [ ] Second specific action
- [ ] Third specific action
- [ ] Fourth specific action
- [ ] Fifth specific action`;

  const res = await post(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } },
    {}
  );
  const text = res?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('Gemini triage error:', JSON.stringify(res));
    return `- [ ] Check GCP Logs Explorer for ${resourceName} errors\n- [ ] Check ${resourceTypeLabel} metrics in Cloud Monitoring\n- [ ] Identify root cause before making changes`;
  }
  const rawText = text.trim();
  let lines = rawText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length <= 1) {
    lines = rawText.split(/(?=\d+\.)/).map(l => l.trim()).filter(l => l.length > 0);
  }
  const items = lines
    .map(l => l.replace(/^[-*•]\s*\[[ x]\]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter(l => l.length > 0)
    .map(l => `- [ ] ${l}`);

  if (items.length < 5) {
    const existing = items.length;
    for (let i = 0; i < 5 - existing; i++) {
      items.push(`- [ ] Continue investigation for ${resourceName}`);
    }
  }
  if (items.length > 5) {
    items.length = 5;
  }
  return items.join('\n');
}

function buildDescription(alertName, resourceName, resourceTypeLabel, gcpConsoleUrl, incidentTime, incidentUrl, severity, observedValue, threshold, aiChecklist, errorLogs) {
  const sla = getSLA(severity.level);
  const errorSection = errorLogs ? `\n## 📋 Error Logs\n\`\`\`\n${errorLogs}\n\`\`\`` : '';

  return `# ${severity.emoji} ${severity.label} — ${alertName}

## 📌 Summary
| Field | Value |
|-------|-------|
| **Alert** | ${alertName} |
| **Resource** | ${resourceName} (${resourceTypeLabel}) |
| **Detected** | ${incidentTime} IST |
| **Observed Value** | ${observedValue || 'N/A'} |
| **Threshold** | ${threshold || 'N/A'} |
| **Ack SLA** | ${sla.ack} |
| **Resolve SLA** | ${sla.resolve} |

## 🔗 Links
- **GCP Console:** ${gcpConsoleUrl}
- **Incident URL:** ${incidentUrl || 'N/A'}

## 🛠️ Triage Checklist
${aiChecklist || '- [ ] Investigate the alert root cause'}

${errorSection}

---
_Generated by GCP Incident Bot_`;
}

function extractErrorDetails(incident) {
  const parts = [];
  if (incident.summary) parts.push(`Summary: ${incident.summary}`);
  if (incident.observed_value) parts.push(`Observed Value: ${incident.observed_value}`);
  if (incident.threshold_value) parts.push(`Threshold: ${incident.threshold_value}`);
  const docContent = incident.documentation?.content || '';
  if (docContent && incident?.resource?.type === 'cloud_run_revision') {
    parts.push(`\nAlert Documentation:\n${docContent}`);
  }
  return parts.length ? parts.join('\n') : null;
}

async function fetchCloudRunErrorLogs(serviceName, projectId) {
  try {
    const tokenRes = await new Promise((resolve, reject) => {
      const http = require('http');
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

    const accessToken = tokenRes.access_token;
    if (!accessToken) {
      console.error('Failed to get access token for Cloud Logging');
      return null;
    }

    const now = new Date();
    const thirtyMinsAgo = new Date(now - 30 * 60 * 1000).toISOString();

    const filter = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${serviceName}"`,
      `severity>=ERROR`,
      `timestamp>="${thirtyMinsAgo}"`,
    ].join(' && ');

    const body = JSON.stringify({
      filter,
      orderBy: 'timestamp desc',
      pageSize: 10,
    });

    const logsRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'logging.googleapis.com',
        path: '/v2/entries:list',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${accessToken}`,
        },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const entries = logsRes?.entries || [];
    if (!entries.length) return null;

    return entries.slice(0, 5).map(e => {
      const ts = e.timestamp || '';
      const msg = e.jsonPayload?.message || e.textPayload || '';
      return `[${ts}] ${msg}`;
    }).join('\n');
  } catch (err) {
    console.error('Cloud Logging fetch error:', err.message);
    return null;
  }
}

exports.prodAlertDispatcher = async (message, context) => {
  try {
    const raw = message.data
      ? JSON.parse(Buffer.from(message.data, 'base64').toString())
      : {};

    console.log('prod-alert-dispatcher received:', JSON.stringify(raw));

    // ── Auto-close metric-based alerts when incident resolves ──────────────────
    if (raw.incident?.state === 'closed') {
      if (raw.source === 'prod-chat-bot') {
        console.log('Chat bot incident closed — skipping');
        return;
      }

      const isMetricBased = raw.incident?.condition?.conditionThreshold != null;
      if (isMetricBased) {
        const secrets = await getSecrets();
        const alertName = raw.incident?.policy_name || 'Unknown Alert';
        const { resourceName, resourceTypeLabel } = getResourceInfo(raw.incident);

        console.log(`Attempting auto-close for metric-based alert: ${alertName} — ${resourceName}`);
        const existingTicket = await findExistingTicket(alertName, resourceName, secrets.linearApiKey);
        if (existingTicket) {
          console.log(`Auto-closing ticket ${existingTicket.identifier}...`);
          await autoCloseTicket(existingTicket.id, secrets.linearApiKey);

          const slackUrl = new URL(secrets.slackWebhook);
          await post('hooks.slack.com', slackUrl.pathname + slackUrl.search, {
            attachments: [{
              color: '#36a64f',
              blocks: [
                { type: 'header', text: { type: 'plain_text', text: '✅ ALERT RESOLVED — Auto-Closed' } },
                { type: 'section', fields: [
                  { type: 'mrkdwn', text: `*Alert:*\n${alertName}` },
                  { type: 'mrkdwn', text: `*Resource:*\n${resourceName} (${resourceTypeLabel})` },
                  { type: 'mrkdwn', text: `*Ticket:*\n<${existingTicket.url}|${existingTicket.identifier}>` },
                ]},
                { type: 'section', text: { type: 'mrkdwn', text: '✅ Alert resolved — metric returned to normal. Auto-closed by GCP Incident Bot.' } },
                { type: 'actions', elements: [
                  { type: 'button', text: { type: 'plain_text', text: '📋 Open Linear Ticket' }, url: existingTicket.url, style: 'primary' },
                ]},
              ],
            }],
          }, {}).catch(e => console.error('Slack auto-close notify error:', e.message));

          const gchatUrl = new URL(secrets.gchatWebhook);
          await post('chat.googleapis.com', gchatUrl.pathname + gchatUrl.search, {
            text: `✅ *ALERT RESOLVED — Auto-Closed*\n*Alert:* ${alertName}\n*Resource:* ${resourceName} (${resourceTypeLabel})\n*Ticket:* ${existingTicket.identifier} — ${existingTicket.url}\n\n_Alert resolved — metric returned to normal._`,
          }, {}).catch(e => console.error('GChat auto-close notify error:', e.message));

          console.log(`Auto-closed ${existingTicket.identifier} successfully`);
        } else {
          console.log(`No existing ticket found for ${alertName} — ${resourceName} — skipping auto-close`);
        }
      } else {
        console.log(`Skipping non-metric closed incident`);
      }
      return;
    }

    if (raw.incident?.state !== 'open') {
      console.log(`Skipping — state: ${raw.incident?.state}`);
      return;
    }

    // ── Chat bot originated incident ───────────────────────────────────────────
    if (raw.source === 'prod-chat-bot' && raw.chatBotTicket?.identifier) {
      console.log(`Chat bot incident — notifying for ticket ${raw.chatBotTicket.identifier}`);
      const secrets = await getSecrets();
      const incident = raw.incident;
      const alertName = incident?.policy_name || 'ChatBot Incident';
      const resourceName = incident?.resource?.labels?.service_name || 'Unknown';
      const resourceTypeLabel = 'Cloud Run';
      const gcpConsoleUrl = `https://console.cloud.google.com/run/detail/YOUR_GCP_REGION/${resourceName}?project=${PROJECT}`;
      const incidentTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const { identifier, url, summary } = raw.chatBotTicket;
      const severity = { level: 'P1', label: 'P1-High', labelId: LABELS.P1, priority: 2, emoji: '🟠', assigneeId: ASSIGNEES.SANDEEP, slackColor: '#FF8C00' };
      const assigneeName = 'YOUR_NAME';
      const sla = { ack: '15 min', resolve: '2 hours' };

      const slackUrl = new URL(secrets.slackWebhook);
      await post('hooks.slack.com', slackUrl.pathname + slackUrl.search, {
        attachments: [{
          color: severity.slackColor,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: `${severity.emoji}  INCIDENT REPORTED — ${severity.label}` } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Summary:*\n${summary || alertName}` },
              { type: 'mrkdwn', text: `*Service:*\n${resourceName} (${resourceTypeLabel})` },
              { type: 'mrkdwn', text: `*Reported:*\n${incidentTime} IST` },
              { type: 'mrkdwn', text: `*Ticket:*\n<${url}|${identifier}>` },
            ]},
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Assigned To:*\n${assigneeName}` },
              { type: 'mrkdwn', text: `*Resolve SLA:*\n${sla.resolve}` },
            ]},
            { type: 'actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: '📋 Open Linear Ticket' }, url, style: 'primary' },
            ]},
          ],
        }],
      }, {});
      console.log('Slack notified for chat bot incident');

      const gchatUrl = new URL(secrets.gchatWebhook);
      await post('chat.googleapis.com', gchatUrl.pathname + gchatUrl.search, {
        text: `${severity.emoji} *INCIDENT REPORTED — ${severity.label}*\n*Summary:* ${summary || alertName}\n*Service:* ${resourceName} (${resourceTypeLabel})\n*Reported:* ${incidentTime} IST\n*Assigned To:* ${assigneeName}\n*Resolve SLA:* ${sla.resolve}\n*Ticket:* ${identifier} — ${url}`,
      }, {});
      console.log('GChat notified for chat bot incident');
      return;
    }

    const secrets      = await getSecrets();
    const incident     = raw.incident;
    const alertName    = incident?.policy_name || 'Unknown Alert';
    const incidentUrl  = incident?.url || '';
    const incidentTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const severity    = getSeverity(alertName);
    const isUtilization = incident?.metric?.type?.includes('utilization');
    const observedValue = isUtilization ? incident?.observed_value : null;
    const threshold    = isUtilization ? incident?.threshold_value : null;

    const { resourceName, resourceTypeLabel, gcpConsoleUrl } = getResourceInfo(incident);
    console.log(`Resource resolved: ${resourceName} (${resourceTypeLabel})`);

    let errorDetails = extractErrorDetails(incident);

    // Fetch real Cloud Logging error logs for Cloud Run errors
    if (resourceTypeLabel === 'Cloud Run') {
      console.log(`Fetching real error logs from Cloud Logging for ${resourceName}...`);
      const realLogs = await fetchCloudRunErrorLogs(resourceName, incident?.resource?.labels?.project_id || PROJECT);
      if (realLogs) {
        errorDetails = `${errorDetails ? errorDetails + '\n\n' : ''}Recent ERROR logs from Cloud Logging:\n${realLogs}`;
        console.log('Real logs fetched successfully');
      }
    }
    console.log('Calling Gemini for AI triage checklist...');

    const aiChecklist = await generateAiTriage(
      alertName, resourceName, resourceTypeLabel,
      observedValue, threshold, incident?.summary,
      errorDetails, secrets.geminiApiKey
    );
    console.log('AI triage checklist generated, length:', aiChecklist.length);

    const description = buildDescription(
      alertName, resourceName, resourceTypeLabel, gcpConsoleUrl,
      incidentTime, incidentUrl, severity, observedValue, threshold,
      aiChecklist, resourceTypeLabel === 'Cloud Run' ? errorDetails : null
    );

    const title = `[${severity.label}] ${alertName} — ${resourceName}`;

    // ── Deduplication check ───────────────────────────────────────────────────
    console.log('Checking for existing ticket...');
    const existingTicket = await findExistingTicket(alertName, resourceName, secrets.linearApiKey);
    if (existingTicket) {
      console.log(`Duplicate detected — existing ticket: ${existingTicket.identifier}. Adding comment.`);
      await addStillFiringComment(existingTicket.id, incidentTime, observedValue, secrets.linearApiKey);

      // Still notify Slack/GChat but with a "still firing" message
      const slackUrl = new URL(secrets.slackWebhook);
      await post('hooks.slack.com', slackUrl.pathname + slackUrl.search, {
        attachments: [{
          color: '#FFA500',
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: `${severity.emoji} STILL FIRING — ${severity.label}` } },
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `*Alert:*\n${alertName}` },
              { type: 'mrkdwn', text: `*Resource:*\n${resourceName} (${resourceTypeLabel})` },
              { type: 'mrkdwn', text: `*Current Value:*\n${observedValue || 'N/A'}` },
              { type: 'mrkdwn', text: `*Existing Ticket:*\n<${existingTicket.url}|${existingTicket.identifier}>` },
            ]},
            { type: 'section', text: { type: 'mrkdwn', text: `⚠️ Incident still active — no new ticket created. Comment added to <${existingTicket.url}|${existingTicket.identifier}>.` } },
          ],
        }],
      }, {});

      const gchatUrl = new URL(secrets.gchatWebhook);
      await post('chat.googleapis.com', gchatUrl.pathname + gchatUrl.search, {
        text: `${severity.emoji} *STILL FIRING — ${severity.label}*\n*Alert:* ${alertName}\n*Resource:* ${resourceName} (${resourceTypeLabel})\n*Current Value:* ${observedValue || 'N/A'}\n⚠️ Incident still active — comment added to existing ticket ${existingTicket.identifier}: ${existingTicket.url}`,
      }, {});

      console.log('Deduplication handled — skipping new ticket creation');
      return;
    }

    console.log('Creating Linear ticket:', title);

    const linearRes = await withRetry(() => post('api.linear.app', '/graphql', {
      query: `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title }
        }
      }`,
      variables: {
        input: {
          teamId:      TEAM_ID,
          title,
          description,
          priority:    severity.priority,
          stateId:     STATE_IN_PROGRESS,
          assigneeId:  severity.assigneeId,
          labelIds:    [severity.labelId, RCA_ENGINEERING_LABEL],
        },
      },
    }, { Authorization: secrets.linearApiKey }), 3, 500, 'Linear ticket creation');

    if (!linearRes?.data?.issueCreate?.success) {
      console.error('Linear error:', JSON.stringify(linearRes));
      throw new Error('Linear ticket creation failed');
    }

    const issue        = linearRes.data.issueCreate.issue;
    const assigneeName = getAssigneeName(severity.level);
    const sla          = getSLA(severity.level);
    console.log('Linear ticket created:', issue.identifier);

    const slackUrl = new URL(secrets.slackWebhook);
    await post('hooks.slack.com', slackUrl.pathname + slackUrl.search, {
      attachments: [{
        color: severity.slackColor,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `${severity.emoji}  INCIDENT — ${severity.label}` } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Alert:*\n${alertName}` },
            { type: 'mrkdwn', text: `*Resource:*\n${resourceName} (${resourceTypeLabel})` },
            { type: 'mrkdwn', text: `*Detected:*\n${incidentTime} IST` },
            { type: 'mrkdwn', text: `*Ticket:*\n<${issue.url}|${issue.identifier}>` },
          ]},
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Assigned To:*\n${assigneeName}` },
            { type: 'mrkdwn', text: `*Resolve SLA:*\n${sla.resolve}` },
            { type: 'mrkdwn', text: `*Value:*\n${observedValue || 'N/A'} (threshold: ${threshold || 'N/A'})` },
          ]},
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: '📋 Open Linear Ticket' }, url: issue.url, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: '☁️ GCP Console' }, url: gcpConsoleUrl },
          ]},
        ],
      }],
    }, {});
    console.log('Slack notified');

    const gchatUrl = new URL(secrets.gchatWebhook);
    await post('chat.googleapis.com', gchatUrl.pathname + gchatUrl.search, {
      text: `${severity.emoji} *INCIDENT — ${severity.label}*\n*Alert:* ${alertName}\n*Resource:* ${resourceName} (${resourceTypeLabel})\n*Value:* ${observedValue || 'N/A'} (threshold: ${threshold || 'N/A'})\n*Detected:* ${incidentTime} IST\n*Assigned To:* ${assigneeName}\n*Resolve SLA:* ${sla.resolve}\n*Ticket:* ${issue.identifier} — ${issue.url}\n*GCP Console:* ${gcpConsoleUrl}`,
    }, {});
    console.log('GChat notified');

  } catch (err) {
    console.error('prod-alert-dispatcher error:', err.message, err.stack);
    throw err;
  }
};