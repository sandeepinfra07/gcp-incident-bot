'use strict';

const { PubSub } = require('@google-cloud/pubsub');

const pubsub = new PubSub();
const TARGET_TOPIC = 'projects/YOUR_GCP_PROJECT_ID/topics/YOUR_PUBSUB_TOPIC';

// ─── IN-MEMORY DEDUP CACHE ────────────────────────────────────────────────────
// Tracks recently forwarded incident_ids to prevent duplicate forwarding
// TTL: 10 minutes — GCP fires alerts every ~5 mins, this covers 2 cycles
const DEDUP_CACHE = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;

function isDuplicate(incidentId) {
  if (!incidentId) return false;
  const cachedAt = DEDUP_CACHE.get(incidentId);
  if (!cachedAt) return false;
  if (Date.now() - cachedAt > DEDUP_TTL_MS) {
    DEDUP_CACHE.delete(incidentId);
    return false;
  }
  return true;
}

function markForwarded(incidentId) {
  if (!incidentId) return;
  DEDUP_CACHE.set(incidentId, Date.now());
  // Clean up old entries to prevent memory leak
  for (const [id, ts] of DEDUP_CACHE.entries()) {
    if (Date.now() - ts > DEDUP_TTL_MS) DEDUP_CACHE.delete(id);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.prodAlertFilter = async (message, context) => {
  try {
    const raw = message.data
      ? JSON.parse(Buffer.from(message.data, 'base64').toString())
      : {};

    console.log('prod-alert-filter received:', JSON.stringify(raw));

    // Only process open incidents
    if (raw.incident?.state !== 'open') {
      console.log(`Skipping — state: ${raw.incident?.state}`);
      return;
    }

    // Only process Cloud Run log-based alerts
    if (raw.incident?.resource?.type !== 'cloud_run_revision') {
      console.log(`Skipping — resource type: ${raw.incident?.resource?.type}`);
      return;
    }

    const serviceName = raw.incident?.resource?.labels?.service_name || '';
    const incidentId  = raw.incident?.incident_id || '';
    console.log(`Evaluating service: ${serviceName} | incident_id: ${incidentId}`);

    const BLOCKED_SERVICES = ['sample-service'];
    if (BLOCKED_SERVICES.includes(serviceName)) {
      console.log(`Blocking excluded service: ${serviceName}`);
      return;
    }

    // Forward only prod-* prefix OR *-prod suffix
    const isProd = serviceName.startsWith('prod-') || serviceName.endsWith('-prod');
    if (!isProd) {
      console.log(`Dropping non-prod service: ${serviceName}`);
      return;
    }

    // Deduplication check — skip if already forwarded recently
    if (isDuplicate(incidentId)) {
      console.log(`Duplicate incident ${incidentId} for ${serviceName} — already forwarded, skipping`);
      return;
    }

    console.log(`Forwarding prod Cloud Run error for: ${serviceName} (incident: ${incidentId})`);
    await pubsub.topic(TARGET_TOPIC).publishMessage({
      data: Buffer.from(JSON.stringify(raw)),
    });

    markForwarded(incidentId);
    console.log(`Successfully forwarded to ${TARGET_TOPIC}`);

  } catch (err) {
    console.error('prod-alert-filter error:', err.message, err.stack);
    throw err;
  }
};
