# GCP Incident Bot

A serverless incident management system built on Google Cloud Platform. Automatically creates Linear tickets, sends Slack/GChat notifications, generates AI-powered RCAs, and auto-closes resolved metric-based incidents.

## Architecture

```
GCP Alert → alert-filter → Pub/Sub → alert-dispatcher → Linear + Slack/GChat
                                                       ↕ (metric resolved → auto-close)
                                                       ↓ (resolved)
                                         incident-rca (cron) → RCA email/Slack/GChat
GChat Command → chat-bot (HTTP) → incident reporting + investigation
GCP Snapshot Alert → snapshot-monitor → Linear ticket
```

## Features

### 1. Alert Dispatcher
Listens to GCP Monitoring incident notifications via Pub/Sub and:
- **Creates Linear tickets** with severity classification (P0/P1/P2) based on alert policy name
- **AI triage checklist** generated via Gemini 2.5 Flash — provides actionable investigation steps
- **Fetches Cloud Logging error logs** for Cloud Run services to attach to tickets
- **Deduplication** — re-firing alerts add "still firing" comments to existing tickets instead of creating duplicates
- **Auto-closes metric-based tickets** when GCP resolves the incident (metric returns below threshold)
  - Applies `RCA: Engineering` label, moves to Done state, posts auto-closure comment
  - Log-based alerts require manual closure
- **Slack + Google Chat notifications** for all events (new incident, still firing, auto-closed)

### 2. Alert Filter
Pre-processes incoming GCP alerts:
- Filters by resource type and service naming patterns
- Blocks excluded services
- In-memory deduplication (10-min TTL)
- Forwards matching alerts to the dispatcher

### 3. Incident RCA
A scheduled function that auto-generates Root Cause Analysis for resolved incidents:
- Detects recently completed Linear tickets (configurable time window)
- Generates structured RCA via Gemini 2.5 Flash (what happened, impact, root cause, action items)
- Sends RCA via email (SMTP), Slack, and Google Chat
- Supports follow-up RCA if a ticket is reopened within the time window

### 4. Chat Bot
HTTP-triggered bot for Google Chat that handles:
- Slash commands for incident reporting
- Creates Linear tickets with severity classification
- Interactive investigation using Gemini
- Dialog-based ticket creation

### 5. Snapshot Monitor
Monitors GCP disk snapshot failures:
- Triggered by Pub/Sub on snapshot failure alerts
- Creates Linear tickets with resource details
- Deduplication to avoid repeated tickets

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Compute | Google Cloud Functions (Gen 2, Cloud Run) |
| Runtime | Node.js 22 |
| Alert Source | GCP Cloud Monitoring |
| Event Bus | Pub/Sub |
| Ticket System | Linear (GraphQL API) |
| AI | Gemini 2.5 Flash |
| Notifications | Slack, Google Chat |
| Emails | SMTP + Gmail App Password |
| Secrets | Secret Manager |
| Registry | Artifact Registry |

## Project Structure

```
gcp-incident-bot/
├── prod-alert-dispatcher/   # Main incident handler
│   ├── index.js
│   └── package.json
├── prod-alert-filter/       # Alert pre-processing
│   ├── index.js
│   └── package.json
├── prod-incident-rca/       # RCA generator
│   ├── index.js
│   └── package.json
├── prod-chat-bot/           # Google Chat slash command bot
│   ├── index.js
│   └── package.json
├── prod-snapshot-monitor/   # Snapshot failure monitor
│   ├── index.js
│   └── package.json
└── .gitignore
```

## Prerequisites

- A GCP project with Cloud Functions (Gen 2), Pub/Sub, Secret Manager, and Artifact Registry enabled
- A Linear workspace with API key
- Slack webhook URL and Google Chat webhook URL
- Gemini API key

## Setup

1. **Clone the repo**
2. **Create secrets in Secret Manager** — see the placeholder names in each function's source for required secrets
3. **Update the placeholders** — replace all `YOUR_*` values in the source code with your own:
   - `YOUR_GCP_PROJECT_ID` — your GCP project ID
   - `YOUR_TEAM_ID` — your Linear team UUID
   - `YOUR_DONE_STATE_ID` / `YOUR_STATE_IN_PROGRESS_ID` — Linear workflow state IDs
   - `YOUR_LABEL_P0_ID` / `YOUR_LABEL_P1_ID` / `YOUR_LABEL_P2_ID` / `YOUR_RCA_LABEL_ID` — Linear label IDs
   - `YOUR_ASSIGNEE_PRIMARY_ID` / `YOUR_ASSIGNEE_SECONDARY_ID` — Linear user IDs
   - `YOUR_GCP_REGION` — your GCP region (e.g., `us-central1`)
   - `YOUR_PUBSUB_TOPIC`, `YOUR_RCA_TOPIC`, etc. — your Pub/Sub topic names
   - Secret names in the `getSecrets()` function calls
4. **Deploy each function** using `gcloud functions deploy`

## Key Design Decisions

- **Auto-close only applies to metric-based alerts** (those using `conditionThreshold`). Log-based alerts require human judgement to close.
- **RCA: Engineering label** is added to all new tickets by default, ensuring every incident gets a proper RCA.
- **Deduplication** uses a 7-day search window for existing open tickets, with title matching on resource name and alert name prefix.
- **Triage checklists** are AI-generated per-incident, making them specific and actionable rather than generic.
- **Auto-closed tickets** get a comment clearly indicating automated action, so the audit trail is transparent.
