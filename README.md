# Digiwhiff RCS Activity

A Salesforce Marketing Cloud (SFMC) Journey Builder Custom Activity that sends RCS template messages through the **NexG RCS API**. Every send result is logged to SFMC Data Extensions and to AWS CloudWatch.

| | |
|---|---|
| **Package** | `digiwhiff-rcs-activity` v2.0.0 |
| **Runtime** | Node.js 18+, Express 4 |
| **Messaging provider** | NexG RCS API (Digiwhiff RCS / RCM) |
| **Hosting** | AWS server, run with PM2 |
| **Deployment** | Bitbucket Pipelines (SSH deploy on push to `main`) |

For a full walkthrough of the design, see the [Developer Document](Documents/docs/Digiwhiff_RCS_Custom_Activity_Developer_Document.docx). The architecture diagram is at [Documents/docs/DigiWhiff RCS Architecture Diagram.png](Documents/docs/DigiWhiff%20RCS%20Architecture%20Diagram.png).

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Journey Builder Integration](#journey-builder-integration)
5. [Configuration Screen (Frontend)](#configuration-screen-frontend)
6. [Execute Workflow (Backend)](#execute-workflow-backend)
7. [RCS API Integration](#rcs-api-integration)
8. [Data Extension Setup](#data-extension-setup)
9. [Configuration](#configuration)
10. [Deployment](#deployment)
11. [Usage Guide](#usage-guide)
12. [Endpoints](#endpoints)
13. [Logging & Monitoring](#logging--monitoring)
14. [Error Handling](#error-handling)
15. [Troubleshooting](#troubleshooting)
16. [Dependencies](#dependencies)
17. [Security Notes](#security-notes)

---

## Overview

Marketers add the activity to a journey, choose a recipient number and template ID, and add any template variables. Each field can come from a Data Extension column or be a static value. When a contact reaches the step, the app sends the message through NexG and queues the result for a success or error Data Extension. Every step is also logged to the console and CloudWatch.

The application has two parts:

- **Configuration screen:** a web page that opens inside Journey Builder. The marketer fills it in and clicks **Done**, and the choices are saved into the journey.
- **Execute service:** a Node.js server. For each contact that reaches the activity, Journey Builder calls it. It builds the NexG request, sends it, records the result and tells Journey Builder it is finished.

### Key Capabilities

- Sends RCS template messages through the NexG multi-send endpoint (`https://automate.nexgplatforms.com/api/v1/rcs/multi-send`)
- One universal template schema: fill in only the fields your template uses
- Per-field toggle between **Data Extension binding** and **static value**
- Up to 10 values for each variable group (message text, button, card title/description, call, website label/URL)
- Batched logging of every result to SFMC success and error Data Extensions
- Structured, step-tagged logs in the console and AWS CloudWatch, with secrets masked
- Persistent row-ID counters, with a reset endpoint
- Graceful shutdown that flushes pending logs and Data Extension records

### Design Decisions Worth Knowing

- **One universal template schema.** Every RCS template type (text, rich card, carousel and so on) uses the same payload shape. There is no separate screen per template type.
- **One endpoint.** The multi-send endpoint also handles single sends, so the app always calls it.
- **Batched Data Extension writes.** Results are buffered in memory and written to SFMC in groups, avoiding one SFMC API call per contact.
- **Handled errors do not stop the journey.** API-level failures go to the Error DE but the activity still answers `200`, so contacts keep moving. Only a network failure returns `500`.

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

### Technology

| Area | Technology |
|------|------------|
| Server | Node.js 18+, Express 4, body-parser |
| Frontend | Plain HTML, jQuery 1.9.1, RequireJS, Bootstrap 4.3.1, Font Awesome 5 (loaded from CDNs) |
| Journey Builder messaging | Postmonger |
| Outbound HTTP | In-house client, `lib/httpClient.js`, built on Node's `http`/`https` |
| Logging | Winston, winston-cloudwatch, AWS SDK v3 CloudWatch Logs client |
| Configuration | dotenv (`.env`) |
| Process manager | PM2 |
| CI/CD | Bitbucket Pipelines |

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
│   └── activity.js                 # save, publish, validate, execute handlers; NexG config
│
├── lib/
│   ├── httpClient.js               # Minimal http/https POST/GET client with lifecycle events
│   ├── logger.js                   # Winston logger: request IDs, secret masking, CloudWatch
│   ├── sfmcLogger.js               # SFMC token, row IDs, batched Data Extension writes
│   └── jwtDecoder.js               # JWT (HS256) helper (not currently used)
│
├── data/
│   └── rowid_counter.json          # Row-ID counters (created at runtime, git-ignored)
│
├── Documents/
│   ├── docs/                       # Developer Document (.docx) and architecture diagram
│   └── postman/                    # Postman collections for the NexG API
│
├── public/
│   ├── index.html                  # Custom Activity UI
│   ├── config.json                 # Journey Builder activity definition
│   ├── config/api-schemas.json     # Field definitions for the UI
│   ├── css/styles.css
│   ├── images/digiwhiff-icon.jpg
│   └── js/
│       ├── customActivity.js       # Postmonger events, save, restore of saved values
│       ├── schemaManager.js        # Builds the form from the schema, toggles, data collection
│       ├── validator.js            # Form validation
│       ├── postmonger.js
│       └── require.js
│
└── README.md
```

---

## Journey Builder Integration

### Activity definition: `public/config.json`

| Setting | Value |
|---------|-------|
| `workflowApiVersion` | `1.1` |
| `type` | `REST` |
| Display name | "Digiwhiff Custom API Integration" |
| Category | `message` |
| Icon | `images/digiwhiff-icon.jpg` |
| `applicationExtensionKey` | Key assigned by SFMC to the installed package component |
| Wizard steps | One: "Configure API Integration" |
| Modal size | 800 x 600 |

**Execute settings:** `POST`, timeout 100000 ms, 1 retry after 10000 ms, 5 concurrent requests, `useJwt: false`.

**Configuration endpoints** (`save`, `publish`, `validate`, `stop`) all use `POST`, `useJwt: false` and a 2000 ms timeout, on the same host under `/journeybuilder/`.

If the app moves to a new domain, update every URL in this file and re-save the package in SFMC (**Setup > Apps > Installed Packages**) so SFMC reads the new URLs.

> `config.json` registers a `/journeybuilder/stop` URL, but `app.js` has no route for it, so a stop call would get a 404. Add a handler if Journey Builder starts calling it.

### Activity lifecycle

| Stage | Who calls | What happens |
|-------|-----------|--------------|
| Configure | Marketer in the UI | The page loads in Journey Builder and Postmonger events fill the form |
| Save | Journey Builder | `POST /journeybuilder/save/`; the server logs the call and returns `200` |
| Validate | Journey Builder | `POST /journeybuilder/validate/`; logs and returns `200` |
| Publish | Journey Builder | `POST /journeybuilder/publish/`; logs and returns `200` |
| Execute | Journey Builder, once per contact | `POST /journeybuilder/execute/`; this is where the message is sent |

Save, validate and publish do no server-side checking. Real validation happens in the browser before the configuration is saved.

---

## Configuration Screen (Frontend)

### Files

| File | Job |
|------|-----|
| `public/index.html` | Page layout; loads libraries and starts RequireJS |
| `public/js/customActivity.js` | Postmonger events, saving, restoring saved values |
| `public/js/schemaManager.js` | Reads the schema, builds the form, handles toggles, collects form data |
| `public/js/validator.js` | Checks required fields, array sizes and URLs |
| `public/config/api-schemas.json` | Describes every field shown on the screen |

### Behaviour

1. The page opens and tells Journey Builder it is ready, then requests tokens, endpoints, the interaction and the trigger event definition (which supplies the entry-source DE fields).
2. The configuration section is locked until the marketer enters an **Input Data Extension Key** that is a valid GUID, such as `DD35583B-CCBE-46AF-9F4D-4028EAF64F6B`.
3. Once the key is valid, the form is built from the schema.
4. On **Done**, the form data is validated. Errors are shown at the top of the form and nothing is saved. Otherwise the values are converted to `inArguments` and sent back to Journey Builder.
5. When the activity is reopened, the saved `inArguments` refill the form, with each field restored to the mode (Data Extension or static) it had before.
6. If the Input Data Extension Key changes, every binding token on the screen is updated to the new key.

### Fields

**Base fields (always shown)**

| Field | Required | Description |
|-------|----------|-------------|
| `to` (Recipient Contact Number) | Yes | Phone number, for example `919XXXXXXXXX` |
| `templateId` (Template ID) | Yes | Template ID from RCM |

**Template variable fields (optional, up to 10 entries each)**

| UI label | Internal name | Sent to NexG as |
|----------|---------------|-----------------|
| Message Text Variable | `messageTextVariables` (saved as `parameterValue0`..`9`) | `message_var` |
| Button Variable | `buttonVariables` | `button_var` |
| Card Title Variable(s) | `carouselCardTitleVariables` | `carsoul_title_var` |
| Card Description Variable(s) | `carouselCardDescriptionVariables` | `carsoul_desc_var` |
| Call-to-Action (Call) Variable | `callButtonVariables` | `calltobtn_var` |
| Visit Website Button Variable | `visitWebsiteButtonVariables` | `visittobtn_var` |
| Visit Website URL Variable | `visitWebsiteUrlVariables` | `visittourl_var` |

### Data Extension binding or static value

Every field has a two-way switch:

- **Data Extension:** the value comes from a column of the journey's entry-source DE. The marketer types the column name and the UI builds the SFMC binding token (see [DE Reference Format](#de-reference-format)).
- **Static value:** a fixed value sent unchanged for every contact.

### Why variables are saved as numbered keys

SFMC only replaces a `{{...}}` token when it is the **whole value** of an `inArguments` key, never when it sits inside a longer string. So a list is not saved as one joined string. Each entry gets its own key:

```
buttonVariables0, buttonVariables1, buttonVariables2, ...
parameterValue0,  parameterValue1,  parameterValue2,  ...
```

After SFMC fills in each value, the server joins the non-empty entries with `", "` (for example `Bullet-350, CSV1`) before sending them to NexG.

### What gets saved (`inArguments[0]`)

| Key | Content |
|-----|---------|
| `to` | Phone number (binding or static) |
| `templateId` | Template ID (binding or static) |
| `parameterValue0`... | Message text variables |
| `buttonVariables0`... and the other groups | Indexed variable values |
| `contentType` | `TEMPLATE` |
| `apiTypeId` | `rcs` |
| `inputDataExtensionKey` | The GUID entered by the marketer |

The activity is also marked configured (`metaData.isConfigured = true`).

### Browser validation rules

- Required fields (`to`, `templateId`) must have a value. A DE binding counts as a value.
- Binding tokens are not otherwise checked, because they only have a real value at run time.
- Array fields cannot exceed their maximum (10 items).
- URL-type fields must be valid `http` or `https` URLs, unless they are bindings.

---

## Execute Workflow (Backend)

The core of the app is `exports.execute` in [routes/activity.js](routes/activity.js).

### Request tracking

Every request under `/journeybuilder` gets a `requestId`: the incoming `X-Request-Id` header if present, otherwise a new UUID. It is returned in the response header and added to every log line.

### Steps for one contact

| # | Log step | What happens |
|---|----------|--------------|
| 1 | `REQUEST_RECEIVED` | Raw request (method, URL, headers, body) is logged |
| 2 | `RECORD_PROCESSING_STARTED` | Processing begins for this contact |
| 3 | `REQUEST_VALIDATION` | `inArguments[0]` must exist, otherwise `400 Missing inArguments` |
| 4 | `REQUEST_VALIDATION` | Each data-bound field is checked and logged; any value still containing a raw `{{...}}` is flagged as unresolved (the send is still attempted) |
| 5 | `REQUEST_TRANSFORMATION` | NexG payload is built |
| 6 | `EXTERNAL_API_CALL` | Full request is logged, then sent to NexG with a 30 s timeout |
| 7 | `DATABASE_OPERATION` | Result is queued for the Success or Error DE |
| 8 | `RECORD_PROCESSING_COMPLETED`, `REQUEST_COMPLETE` | Final summary with timing, then the response is sent |

---

## RCS API Integration

### Endpoint

```
POST https://automate.nexgplatforms.com/api/v1/rcs/multi-send
```

### Authentication

The `Authorization` header carries the NexG API token as a raw value (no `Bearer` prefix). The token, bot ID, message type and endpoint are set in `RCM_API_CONFIG` at the top of [routes/activity.js](routes/activity.js), **not** in `.env`, so changing the token means editing the code and redeploying. See [Security Notes](#security-notes). Do not copy the token into documentation or logs; the logger masks it automatically.

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

If no numbered keys exist for a group, a plain (unnumbered) value from an older saved configuration is used instead.

### Response Handling

A response is a success only when `code` is `200` (compared as text) **and** `status` is `"success"`. Anything else (API error, empty or non-JSON body, network error) is a failure routed to the Error DE.

Fields read from the response: `code`, `status`, `description` (logged) and `data.results[0].messageid` (logged as the message ID). The full body is stored in the DE in every case.

| Situation | HTTP response to SFMC | Logged to |
|-----------|-----------------------|-----------|
| Success | `200` | Success DE |
| API-level error, or empty/non-JSON body | `200` | Error DE |
| Network error or timeout (30 s) | `500` | Error DE |
| Missing `inArguments` | `400` | Nothing |
| Unexpected exception | `500` | Nothing |

### HTTP client

[lib/httpClient.js](lib/httpClient.js) replaces the deprecated `request` package. It supports `post` and `get`, JSON bodies and timeouts, and can report low-level events (DNS lookup, TCP/TLS connect, request sent, response received, timeout). For the NexG call these are logged at debug level as `EXTERNAL_API_CALL_LIFECYCLE`, which helps tell "never left the server" from "sent but no reply" from "connection or TLS problem".

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

External keys come from `SFMC_SUCCESS_DE_KEY` and `SFMC_ERROR_DE_KEY`. The names `DIGIWHIFF_WHATSAPP_SUCCESS_LOG_DE` and `DIGIWHIFF_WHATSAPP_ERROR_LOG_DE` appear in logs for historical reasons; the actual DE is found by external key.

**Both Data Extensions:**

| Field | Description |
|-------|-------------|
| `RowID` | Primary key; auto-incrementing counter saved in `data/rowid_counter.json` |
| `RequestPayload` | JSON of the NexG request |
| `ResponsePayload` | JSON of the NexG response or error detail |
| `Status` | `Success` or `Failed` |

**Error Data Extension only (extra columns):**

`TemplateID`, `BotID`, `MessageType`, `ContactNumber`, `MessageUUID`, `MessageVar`, `ButtonVar`, `CarouselTitleVar`, `CarouselDescVar`, `CallToBtnVar`, `VisitToBtnVar`, `VisitToURLVar`, and `ISTDate` (IST time, `DD/MM/YYYY HH:mm:ss`).

The Error DE must contain all of these columns or the insert for that batch will be rejected.

### Row IDs

`RowID` values come from two counters (success and error), saved to `data/rowid_counter.json` after every increment so they continue after a restart. `POST /counter/reset` resets both to 0.

### How records are written

Records are buffered in memory and sent with `POST {SFMC_REST_URL}/hub/v1/dataevents/key:{DE_KEY}/rowset`. See [Data Extension batch flush](#data-extension-batch-flush) for the flush rules.

The app gets an SFMC OAuth token using the client-credentials flow (`SFMC_AUTH_URL`, client ID, client secret, account ID). The token is cached in memory and refreshed when less than 60 seconds remain.

---

## Configuration

### public/config.json

Registers the activity with Journey Builder. See [Journey Builder Integration](#journey-builder-integration).

### public/config/api-schemas.json

Defines the single "RCS Message" schema: base fields (`to`, `templateId`) and the optional variable groups. Change it only if the NexG template contract changes.

### Environment Variables (`.env`)

Settings are read from a `.env` file in the project root (via dotenv). **Never commit `.env`**; it is git-ignored.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP port |
| `SFMC_AUTH_URL` | Yes | | Token URL, e.g. `https://<subdomain>.auth.marketingcloudapis.com/v2/token`; must contain `.auth.marketingcloudapis.com` |
| `SFMC_REST_URL` | Yes | | REST base URL, e.g. `https://<subdomain>.rest.marketingcloudapis.com`; must contain `.rest.marketingcloudapis.com` |
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

**Set in code, not `.env`** (`RCM_API_CONFIG` in `routes/activity.js`): NexG endpoint, NexG authorization token, `bot_id`, `messageType`.

**Permissions:** the SFMC package needs rights to write DE rows and to read them (for `/de/records/*`). The AWS user needs `logs:DescribeLogStreams`, `logs:CreateLogStream` and `logs:PutLogEvents` on the log group.

### Startup checks

At startup the server:

1. Checks that every required `SFMC_*` variable is set; if not, it logs a fatal error and **exits**.
2. Checks that the auth URL contains `.auth.marketingcloudapis.com`, the REST URL contains `.rest.marketingcloudapis.com`, and the two differ; if not, it logs a fatal error and **exits**. (A wrong URL once made DE writes fail silently for hours.)
3. Tests the CloudWatch connection and logs the result. A CloudWatch problem is only logged; the app keeps running.

---

## Deployment

### Prerequisites

- Node.js 18+
- An SFMC account with Journey Builder and an installed package with an API Integration (server-to-server) component
- Two logging Data Extensions with the columns listed [above](#output-data-extensions-automatic-logging)
- A NexG RCS account: API token, bot ID and approved templates
- An AWS account with a CloudWatch log group (for central logging)
- A server with a public HTTPS domain, and SSH access to it

### Run locally

```bash
npm install
# create a .env with SFMC_AUTH_URL, SFMC_REST_URL, SFMC_CLIENT_ID,
# SFMC_CLIENT_SECRET, SFMC_ACCOUNT_ID, SFMC_SUCCESS_DE_KEY, SFMC_ERROR_DE_KEY
# (AWS_* and LOG_LEVEL are optional)
npm start
```

The server listens on port 3001 unless `PORT` is set. Journey Builder needs an HTTPS URL it can reach, so full testing normally happens on the deployed server or through a tunnel.

### Deploy

A push to `main` triggers `bitbucket-pipelines.yml`, which connects over SSH (using the `SERVER_USER`, `SERVER_IP` and `SERVER_PASS` repository variables) and runs `deploy.sh` in `/home/comsense/projects/digiwhiff-custom-activity/`. That script updates the code and restarts the app; it lives on the server, not in this repo.

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
| GET | static files | Everything under `public/` |
| POST | `/login`, `/logout` | Placeholders from the SFMC sample; `/login` redirects to `/` |
| POST | `/journeybuilder/save/`, `/validate/`, `/publish/` | Journey Builder lifecycle calls; log and return `200` |
| POST | `/journeybuilder/execute/` | Sends the RCS message for one contact |
| POST | `/counter/reset` | Resets success and error row-ID counters to 0 |
| GET | `/de/records/success`, `/de/records/error` | Returns `{ type, count, records }` from the success or error DE; any other type returns `400` |

`/counter/reset` and `/de/records/:type` have no authentication; restrict access at the network level.

---

## Logging & Monitoring

### Where logs go

| Destination | Format | Use |
|-------------|--------|-----|
| Console (PM2 logs) | One readable line per entry: `[timestamp] [LEVEL] [requestId] [STEP] message {data} (+duration ms)` | Quick checks on the server |
| AWS CloudWatch Logs | Structured JSON: `timestamp`, `level`, `requestId`, `step`, `flow`, `message`, `durationMs`, `data` | Searching with Logs Insights |

Keys, tokens and secrets are masked automatically. Follow one send in CloudWatch Logs Insights:

```
fields @timestamp, requestId, step, level, message, durationMs, data
| filter requestId = "<request id>"
| sort @timestamp asc
```

### Log steps

| Step | Meaning |
|------|---------|
| `STARTUP`, `STARTUP_CLOUDWATCH`, `STARTUP_CONFIG` | Server start and configuration checks |
| `REQUEST_RECEIVED` | A request arrived |
| `RECORD_PROCESSING_STARTED` / `RECORD_PROCESSING_COMPLETED` | Start and end of one contact |
| `REQUEST_VALIDATION` | Input checks |
| `REQUEST_TRANSFORMATION` | Building the NexG payload |
| `EXTERNAL_API_CALL` | Calls to NexG or SFMC |
| `EXTERNAL_API_CALL_LIFECYCLE` | Low-level connection events (debug level) |
| `DATABASE_OPERATION` | DE queueing, flushing and SFMC token work |
| `REQUEST_COMPLETE` | Total time for the request |
| `SHUTDOWN` | Graceful shutdown |
| `PROCESS_UNCAUGHT_EXCEPTION`, `PROCESS_UNHANDLED_REJECTION` | Safety-net logging |

### Data Extension batch flush

`lib/sfmcLogger.js` buffers records and flushes them to SFMC when the first of these happens:

1. **Batch full:** the buffer reaches 10 records
2. **Idle:** 2 seconds with no new record (timer resets on each record)
3. **Safety net:** every 30 seconds
4. **Shutdown:** on `SIGTERM`/`SIGINT`, with an 8 second cap

Success and error buffers are handled separately. A batch that fails to insert is logged but not retried.

### Graceful shutdown

On `SIGTERM`/`SIGINT` the app flushes the DE buffers and the CloudWatch queue before exiting, with an 8 second limit after which it exits anyway. This requires PM2 to be started with `--kill-timeout 10000`.

### Other safety nets

- Uncaught exceptions and unhandled promise rejections are logged and the process keeps running.
- CloudWatch transport errors are caught and printed to the console instead of crashing the process.

---

## Error Handling

| Problem | Behaviour |
|---------|-----------|
| Missing `inArguments` | Logged as an error, `400` returned |
| Unresolved `{{...}}` token in a field | Logged as a warning with the field name; the message is still attempted |
| Network error or timeout calling NexG | Recorded in the Error DE, `500` returned |
| NexG returns a failure code or status | Recorded in the Error DE, `200` returned |
| NexG returns an empty or non-JSON body | Recorded in the Error DE, `200` returned |
| Exception inside the response callback | Logged, `500` returned if no response has been sent yet |
| SFMC token or DE write fails | Logged; the records for that batch are dropped (not retried) |

A `500` makes Journey Builder retry the call once after 10 seconds (`retryCount: 1`, `retryDelay: 10000`). A retry can send the same message twice if the first attempt reached NexG but the reply was lost.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| UI form stays locked | Input DE key is empty or not a valid GUID |
| Empty `to` or `templateId` in logs | Wrong column name (case-sensitive), wrong DE key, or the DE is not the journey entry source |
| `Unresolved {{...}} token` warning | The binding points to a column or DE key SFMC cannot find |
| Records in the Error DE | Read `ResponsePayload`. Check the template ID exists and is approved, and the number format is `91XXXXXXXXXX` |
| Journey step errors and retries | Network failure or timeout (30 s) calling NexG gives a `500`. Check `EXTERNAL_API_CALL` logs. A retry can resend the message |
| No rows in the DEs | Look for `DATABASE_OPERATION` errors. Check the SFMC variables, DE keys, and that the Error DE has every column |
| App exits at startup with `FATAL` | Missing `SFMC_*` variable or wrong auth/REST URL |
| `CloudWatch connection FAILED` | Check AWS keys and IAM permissions. The app keeps running |
| Records lost after a restart | PM2 was started without `--kill-timeout 10000` |

### Debug Checklist

- [ ] Input DE key matches the entry source DE
- [ ] `to` holds a valid phone number and `templateId` exists in RCM and is approved
- [ ] Required `SFMC_*` and AWS variables are set
- [ ] App is running (`pm2 status`)
- [ ] The Error DE has all of its columns, up to `ISTDate`
- [ ] URLs in `public/config.json` match the live domain

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Web server and routing |
| `body-parser` | Parses JSON request bodies |
| `errorhandler` | Detailed error pages in development mode |
| `dotenv` | Loads `.env` |
| `jsonwebtoken` | JWT verification helper (used only by the unused `lib/jwtDecoder.js`) |
| `winston` | Logging |
| `winston-cloudwatch` | Sends Winston logs to CloudWatch |
| `@aws-sdk/client-cloudwatch-logs` | Checks the CloudWatch connection at startup |
| `uglify-js` | Listed but not used by the application code |

Browser libraries (from CDNs): jQuery 1.9.1, RequireJS 2.3.6, Bootstrap 4.3.1, Font Awesome 5.15.4 and the Inter font. Postmonger and RequireJS are also bundled in `public/js/`.

Run `npm audit` after installing; the dependency tree is currently free of known vulnerabilities (Express 4.22.3 or later is required for a patched `qs`).

---

## Security Notes

- The NexG token and `bot_id` are hard-coded in `routes/activity.js`. Anyone with repo access can read them. Consider moving them to `.env`.
- `.env` holds AWS and SFMC secrets and must stay out of git. If a secret was ever committed or shared, rotate it.
- `/counter/reset` and `/de/records/:type` are unauthenticated.
- `bitbucket-pipelines.yml` deploys with `sshpass` and `StrictHostKeyChecking=no`; SSH keys and a pinned host key would be safer.

---

*Last Updated: November 2026*
