'use strict';

const { PubSub } = require('@google-cloud/pubsub');

const pubsub = new PubSub();
const PROJECT = 'YOUR_GCP_PROJECT_ID';

const DISK_MAP = {
  'YOUR_DISK_ID_1': 'sample-hr-service',
  'YOUR_DISK_ID_2': 'sample-inventory-service',
};

const DEDUP_CACHE = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;

function extractSnapshotInfo(logEntry) {
  const proto    = logEntry.protoPayload || {};
  const status   = proto.status || {};
  const resource = logEntry.resource?.labels || {};
  const diskId   = resource.disk_id || '';
  const diskName = DISK_MAP[diskId] || `disk-${diskId}`;
  const zone     = resource.zone || 'unknown';

  let errorMsg = status.message || 'Unknown error';
  const snapMatch = errorMsg.match(/snapshots\/([^\s.]+)/);
  const snapshotName = snapMatch ? snapMatch[1] : 'N/A';

  const timestamp = logEntry.timestamp || '';
  const timeIST = timestamp
    ? new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  return { diskName, diskId, zone, errorMsg, snapshotName, timestamp: timeIST };
}

function isDuplicate(insertId) {
  if (!insertId) return false;
  if (DEDUP_CACHE.has(insertId)) return true;
  DEDUP_CACHE.set(insertId, Date.now());
  for (const [id, ts] of DEDUP_CACHE.entries()) {
    if (Date.now() - ts > DEDUP_TTL_MS) DEDUP_CACHE.delete(id);
  }
  return false;
}

exports.prodSnapshotMonitor = async (message, context) => {
  try {
    const logEntry = message.data
      ? JSON.parse(Buffer.from(message.data, 'base64').toString())
      : {};

    console.log('Snapshot failure received, insertId:', logEntry.insertId);

    if (isDuplicate(logEntry.insertId)) {
      console.log(`Duplicate (insertId: ${logEntry.insertId}) — skipping`);
      return;
    }

    const info = extractSnapshotInfo(logEntry);
    console.log(`Disk: ${info.diskName} | Error: ${info.errorMsg.substring(0, 200)}`);

    // Publish to dispatcher — handles ticket creation, notifications, dedup, and RCA
    const dispatchMsg = {
      incident: {
        state: 'open',
        policy_name: `Snapshot-Failure-Error-${info.diskName}`,
        url: '',
        resource: {
          type: 'gce_disk',
          labels: { disk_id: info.diskId, disk_name: info.diskName, zone: info.zone, project_id: PROJECT },
        },
        metadata: {
          system_labels: { name: info.diskName },
        },
        summary: `Snapshot schedule failed for ${info.diskName}: ${info.errorMsg.substring(0, 200)}`,
        observed_value: info.errorMsg,
      },
    };
    try {
      await pubsub.topic('projects/YOUR_GCP_PROJECT_ID/topics/YOUR_PUBSUB_TOPIC').publishMessage({
        data: Buffer.from(JSON.stringify(dispatchMsg)),
      });
      console.log('Published to YOUR_PUBSUB_TOPIC for dispatcher to handle');
    } catch (err) {
      console.error('Failed to publish to dispatcher:', err.message);
    }

  } catch (err) {
    console.error('prod-snapshot-monitor error:', err.message, err.stack);
    throw err;
  }
};
