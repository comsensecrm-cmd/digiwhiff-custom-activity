# Digiwhiff RCS Activity

A Salesforce Marketing Cloud (SFMC) Journey Builder Custom Activity that sends RCS template messages through the **NexG RCS API**. Every send result is logged to SFMC Data Extensions and to AWS CloudWatch.

For a full walkthrough of the design, see [Digiwhiff-RCS-Custom-Activity-Developer-Document.md](Digiwhiff-RCS-Custom-Activity-Developer-Document.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [RCS API Integration](#rcs-api-integration)
5. [Data Extension Setup](#data-extension-setup)
6. [Configuration](#configuration)
7. [Deployment](#deployment)
8. [Usage Guide](#usage-guide)
9. [Endpoints](#endpoints)
10. [Logging & Monitoring](#logging--monitoring)
11. [Troubleshooting](#troubleshooting)

---

## Overview

Marketers add the activity to a journey, choose a recipient number and template ID, and add any template variables. Each field can come from a Data Extension column or be a static value. When a contact reaches the step, the app sends the message through NexG and queues the result for a success or error Data Extension. Every step is also logged to the console and CloudWatch.

### Key Capabilities

- Sends RCS template messages through the NexG multi-send endpoint (`https://automate.nexgplatforms.com/api/v1/rcs/multi-send`)
- One universal template schema: fill in only the fields your template uses
- Per-field toggle between **Data Extension binding** and **static value**
- Up to 10 values for each variable group (message text, button, card title/description, call, website label/URL)
- Batched logging of every result to SFMC success and error Data Extensions
- Structured, step-tagged logs in the console and AWS CloudWatch, with secrets masked
- Persistent row-ID counters, with a reset endpoint
- Graceful shutdown that flushes pending logs and Data Extension records

---

## Architecture

```
+------------------------------------------------------------+
|                    SFMC Journey Builder                    |
|  Custom Activity UI (iframe)                               |
|  customActivity.js + schemaManager.js + validator.js       |
+------------------------------------------------------------+
            | save / validate / publish        | execute (per contact,
            | (config time)                    | values already resolved)
            v                                  v
+------------------------------------------------------------+
|            Node.js / Express server (AWS, PM2)             |
|  app.js -> routes/activity.js                              |
|  - Validates inArguments                                   |
|  - Builds the NexG payload                                 |
|  - Calls NexG, then queues the result                      |
+------------------------------------------------------------+
        |                     |                     |
        v                     v                     v
+--------------+   +----------------------+   +----------------+
| NexG RCS API |   | lib/sfmcLogger.js    |   | lib/logger.js  |
| (multi-send) |   | Batched writes to    |   | Winston:       |
|              |   | SFMC Data Extensions |   | console +      |
|              |   |                      |   | CloudWatch     |
+--------------+   +----------------------+   +----------------+
```

---

## Project Structure

```
digiwhiff-custom-activity/
├── app.js                          # Express server entry point, routes, graceful shutdown
├── package.json
├── bitbucket-pipelines.yml         # CI/CD: SSH deploy to the AWS server on push to main
│
├── routes/
│   ├── index.js                    # Serves the UI; login/logout placeholders
│   └── activity.js                 # save, publish, validate, execute handlers
│
├── lib/
│   ├── httpClient.js               # Minimal http/https POST/GET client (no external deps)
│   ├── logger.js                   # Winston logger: request IDs, secret masking, CloudWatch
│   ├── sfmcLogger.js               # SFMC token, row IDs, batched Data Extension writes
│   └── jwtDecoder.js               # JWT (HS256) helper (not currently used)
│
├── data/
│   └── rowid_counter.json          # Row-ID counters (created at runtime)
│
├── public/
│   ├── index.html                  # Custom Activity UI
│   ├── config.json                 # Journey Builder activity definition
│   ├── config/api-schemas.json     # Field definitions for the UI
│   ├── css/styles.css
│   ├── images/digiwhiff-icon.jpg
│   └── js/
│       ├── customActivity.js       # UI logic and Postmonger integration
│       ├── schemaManager.js        # Builds the form from the schema
│       ├── validator.js            # Form validation
│       ├── postmonger.js
│       └── require.js
│
└── README.md
```

---

## RCS API Integration

### Endpoint

```
POST https://automate.nexgplatforms.com/api/v1/rcs/multi-send
```

### Authentication

The `Authorization` header carries the NexG API token as a raw value (no `Bearer` prefix). The token, bot ID and endpoint are currently set in `RCM_API_CONFIG` at the top of [routes/activity.js](routes/activity.js). Do not copy the token into documentation or logs; the logger masks it automatically.

### Request Payload

```json
{
  "templateid": "text_karix_20260312",
  "bot_id": "<bot id>",
  "messageType": "template",
  "rcs_detail": [
    {
      "contactnumber": "917218980233",
      "messageuuid": "text_karix_20260312",
      "message_var": "John",
      "button_var": "[]",
      "carsoul_title_var": "",
      "carsoul_desc_var": "",
      "calltobtn_var": "",
      "visittobtn_var": "",
      "visittourl_var": ""
    }
  ]
}
```

The `carsoul_*` spelling is the NexG API's own and must not be changed.

### Field Mapping

| NexG field | Source |
|------------|--------|
| `bot_id`, `messageType` | Static, set in code |
| `templateid` and `rcs_detail[0].messageuuid` | `templateId` from the activity (same value for both) |
| `rcs_detail[0].contactnumber` | `to` |
| `rcs_detail[0].message_var` | `parameterValue0` ... `parameterValue9`, joined with `", "` |
| `rcs_detail[0].button_var` | `buttonVariables0..9`, joined; defaults to `[]` |
| `rcs_detail[0].carsoul_title_var` | `carouselCardTitleVariables0..9`, joined |
| `rcs_detail[0].carsoul_desc_var` | `carouselCardDescriptionVariables0..9`, joined |
| `rcs_detail[0].calltobtn_var` | `callButtonVariables0..9`, joined |
| `rcs_detail[0].visittobtn_var` | `visitWebsiteButtonVariables0..9`, joined |
| `rcs_detail[0].visittourl_var` | `visitWebsiteUrlVariables0..9`, joined |

Each variable is saved as its own numbered key because SFMC only resolves a `{{...}}` binding when it is the whole value of a key. The server joins the already-resolved values, for example `Bullet-350, CSV1`.

### Response Handling

A response is a success only when `code` is `200` and `status` is `"success"`. Anything else (API error, empty or non-JSON body, network error) is logged as a failure and routed to the error Data Extension.

| Situation | HTTP response to SFMC | Logged to |
|-----------|-----------------------|-----------|
| Success | `200` | Success DE |
| API-level error, or empty/non-JSON body | `200` | Error DE |
| Network error or timeout (30 s) | `500` | Error DE |
| Missing `inArguments` | `400` | Nothing |

---

## Data Extension Setup

### Input Data Extension (journey entry source)

| Field | Required | Description |
|-------|----------|-------------|
| Recipient number column | Yes | For example `917218980233` |
| Template ID column | Yes | Template ID from NexG RCS |
| Variable columns | No | Any columns you bind to message, button, card, call or website variables |

Column names are chosen by the marketer in the UI and are case-sensitive.

### Output Data Extensions (automatic logging)

External keys come from `SFMC_SUCCESS_DE_KEY` and `SFMC_ERROR_DE_KEY`.

**Both Data Extensions:**

| Field | Description |
|-------|-------------|
| `RowID` | Primary key; auto-incrementing counter saved in `data/rowid_counter.json` |
| `RequestPayload` | JSON of the NexG request |
| `ResponsePayload` | JSON of the NexG response or error detail |
| `Status` | `Success` or `Failed` |

**Error Data Extension only (extra columns):**

`TemplateID`, `BotID`, `MessageType`, `ContactNumber`, `MessageUUID`, `MessageVar`, `ButtonVar`, `CarouselTitleVar`, `CarouselDescVar`, `CallToBtnVar`, `VisitToBtnVar`, `VisitToURLVar`, and `ISTDate` (IST time, `DD/MM/YYYY HH:mm:ss`).

The Error DE must contain all of these columns or the insert will be rejected.

---

## Configuration

### public/config.json

Registers the activity with Journey Builder. If the app moves to a new domain, update every URL in this file (`execute`, `save`, `publish`, `validate`, `stop`) and re-save the package in SFMC. Current execute settings: timeout 100000 ms, 1 retry after 10000 ms, 5 concurrent requests, `useJwt: false`.

### public/config/api-schemas.json

Defines the single "RCS Message" schema: base fields (`to`, `templateId`) and the optional variable groups. Change it only if the NexG template contract changes.

### Environment Variables (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP port |
| `SFMC_AUTH_URL` | Yes | | Must contain `.auth.marketingcloudapis.com` |
| `SFMC_REST_URL` | Yes | | Must contain `.rest.marketingcloudapis.com` |
| `SFMC_CLIENT_ID` | Yes | | Installed package client ID |
| `SFMC_CLIENT_SECRET` | Yes | | Installed package client secret |
| `SFMC_ACCOUNT_ID` | Yes | | SFMC MID |
| `SFMC_SUCCESS_DE_KEY` | Yes | | External key of the success-log DE |
| `SFMC_ERROR_DE_KEY` | Yes | | External key of the error-log DE |
| `AWS_ACCESS_KEY_ID` | For CloudWatch | | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | For CloudWatch | | IAM secret key |
| `AWS_REGION` | No | `ap-south-1` | AWS region |
| `AWS_LOG_GROUP` | No | `comsense-internal` | CloudWatch log group |
| `AWS_LOG_STREAM` | No | `digiwhiff-custom-activity-logs` | CloudWatch log stream |
| `LOG_LEVEL` | No | `debug` | Minimum log level |

**Startup behaviour:** if any required `SFMC_*` variable is missing, or the auth/REST URLs are wrong or identical, the app logs a fatal error and **exits**. A CloudWatch problem is only logged as an error; the app keeps running.

---

## Deployment

### Prerequisites

- Node.js 18+
- SSH access to the AWS server
- An SFMC account with Journey Builder and an installed package with API access

### Deploy

A push to `main` triggers `bitbucket-pipelines.yml`, which connects over SSH (using the `SERVER_USER`, `SERVER_IP` and `SERVER_PASS` repository variables) and runs `deploy.sh` on the server. That script lives on the server, not in this repo.

Run the app under PM2 with a kill timeout so buffered logs and records can flush on restart:

```bash
pm2 start app.js --name digiwhiff-custom-activity --kill-timeout 10000
pm2 logs digiwhiff-custom-activity
pm2 status
```

### Install in SFMC

1. Go to **Setup > Apps > Installed Packages**
2. Create or edit a package
3. Add a **Journey Builder Activity** component
4. Enter the deployed app's base URL (it serves `config.json`)
5. Save. The activity appears under the **Messages** category

---

## Usage Guide

1. Add **Digiwhiff Custom API Integration** to a journey whose entry source is the input Data Extension.
2. Enter the **Input Data Extension Key** (GUID). The rest of the form stays locked until the key is a valid GUID.
3. Set **Recipient Contact Number** and **Template ID**. Each can be a Data Extension column or a static value.
4. Add the variables your template needs with **+ Add** (message text, button, card title/description, call, website label/URL). Each row can be a Data Extension column or a static value.
5. Click **Done**, then save and activate the journey.

### DE Reference Format

```
{{Event.DEAudience-<DE_KEY>."columnName"}}
```

Example:

```
{{Event.DEAudience-DD35583B-CCBE-46AF-9F4D-4028EAF64F6B."to"}}
```

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Configuration UI |
| POST | `/journeybuilder/save/`, `/validate/`, `/publish/` | Journey Builder lifecycle calls; log and return `200` |
| POST | `/journeybuilder/execute/` | Sends the RCS message for one contact |
| POST | `/counter/reset` | Resets success and error row-ID counters to 0 |
| GET | `/de/records/success`, `/de/records/error` | Returns rows from the success or error DE |

`/counter/reset` and `/de/records/:type` have no authentication; restrict access at the network level.

---

## Logging & Monitoring

### Application logs

Every request gets a `requestId` (the incoming `X-Request-Id` header if present, otherwise a new UUID). Logs go to the console and to CloudWatch as structured JSON. Keys, tokens and secrets are masked automatically. Follow one send in CloudWatch Logs Insights:

```
fields @timestamp, requestId, step, level, message, durationMs, data
| filter requestId = "<request id>"
| sort @timestamp asc
```

Main steps: `REQUEST_RECEIVED`, `RECORD_PROCESSING_STARTED`, `REQUEST_VALIDATION`, `REQUEST_TRANSFORMATION`, `EXTERNAL_API_CALL`, `EXTERNAL_API_CALL_LIFECYCLE` (debug), `DATABASE_OPERATION`, `RECORD_PROCESSING_COMPLETED`, `REQUEST_COMPLETE`. Startup and shutdown use `STARTUP`, `STARTUP_CLOUDWATCH`, `STARTUP_CONFIG` and `SHUTDOWN`.

### Data Extension batch flush

`lib/sfmcLogger.js` buffers records and flushes them to SFMC when the first of these happens:

1. **Batch full:** the buffer reaches 10 records
2. **Idle:** 2 seconds with no new record (timer resets on each record)
3. **Safety net:** every 30 seconds
4. **Shutdown:** on `SIGTERM`/`SIGINT`, with an 8 second cap

Success and error buffers are handled separately. A batch that fails to insert is logged but not retried.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| UI form stays locked | Input DE key is empty or not a valid GUID |
| Empty `to` or `templateId` in logs | Wrong column name (case-sensitive), wrong DE key, or the DE is not the journey entry source |
| `Unresolved {{...}} token` warning | The binding points to a column or DE key SFMC cannot find |
| Records in the Error DE | Read `ResponsePayload`. Check the template ID exists and is approved, and the number format is `91XXXXXXXXXX` |
| Journey step errors and retries | Network failure or timeout (30 s) calling NexG gives a `500`. Check `EXTERNAL_API_CALL` logs. Note that a retry can resend the message |
| No rows in the DEs | Look for `DATABASE_OPERATION` errors. Check the SFMC variables, DE keys, and that the Error DE has every column |
| App exits at startup with `FATAL` | Missing `SFMC_*` variable or wrong auth/REST URL |
| `CloudWatch connection FAILED` | Check AWS keys and IAM permissions (`logs:DescribeLogStreams`, `logs:CreateLogStream`, `logs:PutLogEvents`). The app keeps running |
| Records lost after a restart | PM2 was started without `--kill-timeout 10000` |

### Debug Checklist

- [ ] Input DE key matches the entry source DE
- [ ] `to` holds a valid phone number and `templateId` is correct
- [ ] Required `SFMC_*` and AWS variables are set
- [ ] App is running (`pm2 status`)
- [ ] URLs in `public/config.json` match the live domain

---

*Last Updated: November 2026*
