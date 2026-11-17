'use strict';

var request = require('./httpClient');
var fs = require('fs');
var path = require('path');
var loggerMod = require('./logger');
var createRequestLogger = loggerMod.createRequestLogger;

// ---------------------------------------------------------------------------
// SFMC Configuration (from environment variables)
// ---------------------------------------------------------------------------
var SFMC_CONFIG = {
    authUrl: process.env.SFMC_AUTH_URL,
    restUrl: process.env.SFMC_REST_URL,
    clientId: process.env.SFMC_CLIENT_ID,
    clientSecret: process.env.SFMC_CLIENT_SECRET,
    accountId: process.env.SFMC_ACCOUNT_ID,
    successDeKey: process.env.SFMC_SUCCESS_DE_KEY,
    errorDeKey: process.env.SFMC_ERROR_DE_KEY,
    batchSize: 10   // flush immediately when 10 records accumulate
};

// A logger for startup/background work with no inbound request to attach to
// (config validation at boot, idle-flush timers, the 30s safety net).
var bgLog = createRequestLogger('digiwhiff-rcs-de', { requestId: 'background' });

// Validate all required env vars at startup. This is a hard gate, not a
// warning: a wrong-but-present SFMC_REST_URL (e.g. pointed at the auth
// subdomain instead of rest) previously passed silently and sent every DE
// call to a dead endpoint for hours before anyone noticed in the logs. Fail
// fast and loud instead — PM2 shows a crash/errored process, which is far
// harder to miss than a quietly-failing background flush.
(function validateConfig() {
    var envMap = {
        authUrl: 'SFMC_AUTH_URL', restUrl: 'SFMC_REST_URL',
        clientId: 'SFMC_CLIENT_ID', clientSecret: 'SFMC_CLIENT_SECRET',
        accountId: 'SFMC_ACCOUNT_ID', successDeKey: 'SFMC_SUCCESS_DE_KEY',
        errorDeKey: 'SFMC_ERROR_DE_KEY'
    };
    var missing = Object.keys(envMap).filter(function (k) { return !SFMC_CONFIG[k]; });
    if (missing.length > 0) {
        bgLog.error('STARTUP_CONFIG', 'FATAL: Missing required env vars', null, {
            missing: missing.map(function (k) { return envMap[k]; })
        });
        process.exit(1);
    }

    var urlErrors = [];
    if (SFMC_CONFIG.authUrl.indexOf('.auth.marketingcloudapis.com') === -1) {
        urlErrors.push('SFMC_AUTH_URL must point at the ".auth.marketingcloudapis.com" subdomain, got: ' + SFMC_CONFIG.authUrl);
    }
    if (SFMC_CONFIG.restUrl.indexOf('.rest.marketingcloudapis.com') === -1) {
        urlErrors.push('SFMC_REST_URL must point at the ".rest.marketingcloudapis.com" subdomain, got: ' + SFMC_CONFIG.restUrl);
    }
    if (SFMC_CONFIG.authUrl === SFMC_CONFIG.restUrl) {
        urlErrors.push('SFMC_AUTH_URL and SFMC_REST_URL must not be identical — got the same value for both');
    }

    if (urlErrors.length > 0) {
        bgLog.error('STARTUP_CONFIG', 'FATAL: SFMC URL configuration is invalid — refusing to start', null, {
            errors: urlErrors, authUrl: SFMC_CONFIG.authUrl, restUrl: SFMC_CONFIG.restUrl
        });
        process.exit(1);
    }

    bgLog.info('STARTUP_CONFIG', 'SFMC configuration loaded', {
        authUrl: SFMC_CONFIG.authUrl,
        restUrl: SFMC_CONFIG.restUrl,
        successDeKey: SFMC_CONFIG.successDeKey,
        errorDeKey: SFMC_CONFIG.errorDeKey,
        batchSize: SFMC_CONFIG.batchSize
    });
})();

// ---------------------------------------------------------------------------
// SFMC OAuth Token Cache
// ---------------------------------------------------------------------------
var tokenCache = { accessToken: null, expiresAt: 0 };

function getAccessToken(log, callback) {
    var now = Date.now();
    if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
        log.debug('DATABASE_OPERATION', 'Using cached SFMC access token', {
            expiresInSeconds: Math.round((tokenCache.expiresAt - now) / 1000)
        });
        return callback(null, tokenCache.accessToken);
    }

    if (!SFMC_CONFIG.authUrl) {
        log.error('DATABASE_OPERATION', 'SFMC token fetch aborted — SFMC_AUTH_URL is not set');
        return callback(new Error('SFMC_AUTH_URL environment variable is not configured'));
    }

    var requestBody = {
        grant_type: 'client_credentials',
        client_id: SFMC_CONFIG.clientId,
        client_secret: SFMC_CONFIG.clientSecret,
        account_id: SFMC_CONFIG.accountId
    };

    var endStep = log.startStep('EXTERNAL_API_CALL', 'Fetching new SFMC access token', {
        url: SFMC_CONFIG.authUrl, method: 'POST', requestBody: requestBody
    });

    request.post({
        url: SFMC_CONFIG.authUrl,
        json: true,
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
    }, function (err, res, body) {
        if (err) {
            endStep({ error: err, message: 'SFMC token request failed — network error', data: { url: SFMC_CONFIG.authUrl, requestBody: requestBody } });
            return callback(new Error('SFMC token request failed: ' + err.message));
        }

        if (res.statusCode !== 200) {
            endStep({
                level: 'error',
                message: 'SFMC token API returned non-200',
                data: { url: SFMC_CONFIG.authUrl, requestBody: requestBody, httpStatus: res.statusCode, responseBody: body }
            });
            return callback(new Error('SFMC token API HTTP ' + res.statusCode + ': ' + JSON.stringify(body)));
        }

        if (!body || !body.access_token) {
            endStep({ level: 'error', message: 'SFMC token response missing access_token', data: { url: SFMC_CONFIG.authUrl, requestBody: requestBody, responseBody: body } });
            return callback(new Error('SFMC token response missing access_token'));
        }

        tokenCache.accessToken = body.access_token;
        tokenCache.expiresAt = now + (body.expires_in * 1000);
        endStep({
            message: 'SFMC token refreshed successfully',
            data: { url: SFMC_CONFIG.authUrl, httpStatus: res.statusCode, responseBody: body, expiresIn: body.expires_in + 's' }
        });
        callback(null, tokenCache.accessToken);
    });
}

// ---------------------------------------------------------------------------
// Persistent RowID Counters
// ---------------------------------------------------------------------------
var COUNTER_FILE = path.join(__dirname, '..', 'data', 'rowid_counter.json');
var counters = { success: 0, error: 0 };

function loadCounters() {
    try {
        var dataDir = path.dirname(COUNTER_FILE);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

        if (fs.existsSync(COUNTER_FILE)) {
            var data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
            counters.success = data.success || 0;
            counters.error = data.error || 0;
            bgLog.info('STARTUP_CONFIG', 'RowID counters loaded from disk', {
                file: COUNTER_FILE, success: counters.success, error: counters.error
            });
        } else {
            saveCounters();
            bgLog.info('STARTUP_CONFIG', 'RowID counter file created', { file: COUNTER_FILE });
        }
    } catch (e) {
        bgLog.error('STARTUP_CONFIG', 'Failed to load RowID counters', e);
    }
}

function saveCounters() {
    try {
        fs.writeFileSync(COUNTER_FILE, JSON.stringify(counters, null, 2));
    } catch (e) {
        bgLog.error('DATABASE_OPERATION', 'Failed to save RowID counters', e);
    }
}

function getNextRowId(type) {
    counters[type]++;
    saveCounters();
    return String(counters[type]);
}

// ---------------------------------------------------------------------------
// In-memory Batch Buffers
// ---------------------------------------------------------------------------
var successBuffer = [];
var errorBuffer = [];

// ---------------------------------------------------------------------------
// Idle-flush Timers (one per buffer type)
//
// When a record is added and the batch is not yet full, a 2-second idle timer
// is started. Any new record RESETS the timer (debounce). When the timer fires
// without new activity, the partial batch is flushed immediately.
// When the batch reaches batchSize, the timer is cancelled and the batch is
// flushed right away — no waiting.
// ---------------------------------------------------------------------------
var IDLE_FLUSH_DELAY_MS = 2000;
var idleFlushTimers = { success: null, error: null };

function scheduleIdleFlush(type) {
    if (idleFlushTimers[type]) {
        clearTimeout(idleFlushTimers[type]);
    }

    idleFlushTimers[type] = setTimeout(function () {
        idleFlushTimers[type] = null;
        var buffer = type === 'success' ? successBuffer : errorBuffer;
        if (buffer.length > 0) {
            bgLog.info('DATABASE_OPERATION', '2s idle window expired — flushing partial batch', { type: type, count: buffer.length });
            flushBatch(type, buffer);
        }
    }, IDLE_FLUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Flush batch — drains the buffer and sends all records to SFMC DE in one call
// ---------------------------------------------------------------------------
function flushBatch(type, buffer, onDone) {
    onDone = onDone || function () {};
    if (buffer.length === 0) return onDone();

    var deKey = type === 'success' ? SFMC_CONFIG.successDeKey : SFMC_CONFIG.errorDeKey;
    var deName = type === 'success'
        ? 'DIGIWHIFF_WHATSAPP_SUCCESS_LOG_DE'
        : 'DIGIWHIFF_WHATSAPP_ERROR_LOG_DE';

    // Drain buffer atomically before the async token fetch so new records
    // arriving during the HTTP call go into the next batch.
    var records = buffer.splice(0, buffer.length);
    var log = bgLog;

    var endFlush = log.startStep('DATABASE_OPERATION', 'Flushing batch to SFMC DE', {
        type: type, deName: deName, deKey: deKey, recordCount: records.length
    });

    getAccessToken(log, function (err, token) {
        if (err) {
            endFlush({ error: err, message: 'Batch flush aborted — token error', data: { type: type, deName: deName, recordCount: records.length } });
            return onDone();
        }

        if (!SFMC_CONFIG.restUrl || !deKey) {
            endFlush({
                level: 'error',
                message: 'Batch flush aborted — SFMC_REST_URL or DE key not configured',
                data: { type: type, deName: deName, restUrl: SFMC_CONFIG.restUrl, deKey: deKey }
            });
            return onDone();
        }

        var url = SFMC_CONFIG.restUrl + '/hub/v1/dataevents/key:' + deKey + '/rowset';

        records.forEach(function (record) {
            log.info('EXTERNAL_API_CALL', 'SFMC DE rowset insert record', {
                type: type, deName: deName, deKey: deKey, url: url, method: 'POST',
                RowID: record.values.RowID,
                RequestPayload: record.values.RequestPayload,
                ResponsePayload: record.values.ResponsePayload,
                Status: record.values.Status
            });
        });

        request.post({
            url: url,
            json: true,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: records
        }, function (err, res, body) {
            if (err) {
                endFlush({ error: err, message: 'DE REST API call failed — network error', data: { type: type, deName: deName, url: url, requestBody: records } });
                return onDone();
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
                endFlush({
                    message: 'Batch inserted into DE successfully',
                    data: { type: type, deName: deName, deKey: deKey, url: url, requestBody: records, httpStatus: res.statusCode, recordCount: records.length, responseBody: body }
                });
            } else {
                endFlush({
                    level: 'error',
                    message: 'DE REST API returned error response',
                    data: { type: type, deName: deName, deKey: deKey, url: url, requestBody: records, httpStatus: res.statusCode, responseBody: body }
                });
            }
            onDone();
        });
    });
}

// Format the current time in IST (UTC+5:30) as DD/MM/YYYY HH:mm:ss.
function formatISTDate(date) {
    var ist = new Date(date.getTime() + (5 * 60 + 30) * 60000);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return pad(ist.getUTCDate()) + '/' + pad(ist.getUTCMonth() + 1) + '/' + ist.getUTCFullYear() +
        ' ' + pad(ist.getUTCHours()) + ':' + pad(ist.getUTCMinutes()) + ':' + pad(ist.getUTCSeconds());
}

// Flatten the NexG RCS request payload (templateid, bot_id, messageType,
// rcs_detail[0].{contactnumber,messageuuid,message_var,...}) into individual
// DE columns, so each field is queryable/reportable on its own alongside the
// raw RequestPayload/ResponsePayload JSON blobs.
function extractRcsFields(requestPayload) {
    var detail = (requestPayload && requestPayload.rcs_detail && requestPayload.rcs_detail[0]) || {};
    return {
        TemplateID: requestPayload && requestPayload.templateid || '',
        BotID: requestPayload && requestPayload.bot_id || '',
        MessageType: requestPayload && requestPayload.messageType || '',
        ContactNumber: detail.contactnumber || '',
        MessageUUID: detail.messageuuid || '',
        MessageVar: detail.message_var || '',
        ButtonVar: detail.button_var || '',
        CarouselTitleVar: detail.carsoul_title_var || '',
        CarouselDescVar: detail.carsoul_desc_var || '',
        CallToBtnVar: detail.calltobtn_var || '',
        VisitToBtnVar: detail.visittobtn_var || '',
        VisitToURLVar: detail.visittourl_var || ''
    };
}

// ---------------------------------------------------------------------------
// Add record to buffer, then decide: flush now or schedule idle flush
// ---------------------------------------------------------------------------
function addToBuffer(log, type, rowId, requestPayload, responsePayload, status) {
    var record = {
        keys: { RowID: rowId },
        values: {
            RequestPayload: typeof requestPayload === 'string' ? requestPayload : JSON.stringify(requestPayload),
            ResponsePayload: typeof responsePayload === 'string' ? responsePayload : JSON.stringify(responsePayload),
            Status: status,
            RowID: rowId
        }
    };

    // Error DE only, per its extended schema — flat RCS fields + IST timestamp.
    if (type === 'error') {
        var rcsFields = extractRcsFields(typeof requestPayload === 'object' ? requestPayload : {});
        Object.keys(rcsFields).forEach(function (key) {
            record.values[key] = rcsFields[key];
        });
        record.values.ISTDate = formatISTDate(new Date());
    }

    log.info('DATABASE_OPERATION', 'DE record constructed and buffered', {
        type: type, rowId: rowId, status: status,
        requestPayload: record.values.RequestPayload,
        responsePayload: record.values.ResponsePayload
    });

    var buffer = type === 'success' ? successBuffer : errorBuffer;
    buffer.push(record);

    if (buffer.length >= SFMC_CONFIG.batchSize) {
        if (idleFlushTimers[type]) {
            clearTimeout(idleFlushTimers[type]);
            idleFlushTimers[type] = null;
        }
        log.info('DATABASE_OPERATION', 'Batch size reached — triggering immediate flush', { type: type, count: buffer.length });
        flushBatch(type, buffer);
    } else {
        scheduleIdleFlush(type);
    }
}

// ---------------------------------------------------------------------------
// 30-second safety-net — last-resort flush for any records that were somehow
// not caught by the batch-full trigger or the idle timer.
// ---------------------------------------------------------------------------
setInterval(function () {
    if (successBuffer.length > 0) {
        bgLog.info('DATABASE_OPERATION', '30s safety-net flush — success buffer', { count: successBuffer.length });
        if (idleFlushTimers.success) { clearTimeout(idleFlushTimers.success); idleFlushTimers.success = null; }
        flushBatch('success', successBuffer);
    }
    if (errorBuffer.length > 0) {
        bgLog.info('DATABASE_OPERATION', '30s safety-net flush — error buffer', { count: errorBuffer.length });
        if (idleFlushTimers.error) { clearTimeout(idleFlushTimers.error); idleFlushTimers.error = null; }
        flushBatch('error', errorBuffer);
    }
}, 30000);

// ---------------------------------------------------------------------------
// Public API
//
// requestId (optional, last arg on logSuccess/logError) ties the DE write
// back to the originating execute request's correlation ID, so the whole
// chain — inbound request -> RCM call -> DE queue -> DE flush — can be
// traced with one requestId filter even though the flush itself is async
// and batched across multiple requests.
// ---------------------------------------------------------------------------
exports.resetCounters = function () {
    counters.success = 0;
    counters.error = 0;
    saveCounters();
};

// Flush any buffered DE records immediately — called on SIGTERM/SIGINT so a
// PM2 restart can't strand records that were queued but hadn't yet hit the
// 2s idle timer, 10-record batch size, or 30s safety-net (see incident: 3
// execute calls queued records into successBuffer, then a restart 780ms
// later killed the process before the 2s idle timer could flush them —
// those records were never sent to SFMC at all).
exports.flushAllOnShutdown = function (callback) {
    bgLog.info('DATABASE_OPERATION', 'Shutdown flush — draining DE buffers', {
        successBufferCount: successBuffer.length, errorBufferCount: errorBuffer.length
    });

    if (idleFlushTimers.success) { clearTimeout(idleFlushTimers.success); idleFlushTimers.success = null; }
    if (idleFlushTimers.error) { clearTimeout(idleFlushTimers.error); idleFlushTimers.error = null; }

    if (successBuffer.length === 0 && errorBuffer.length === 0) {
        return callback();
    }

    var pending = 0;
    function done() {
        pending--;
        if (pending <= 0) callback();
    }

    if (successBuffer.length > 0) { pending++; flushBatch('success', successBuffer, done); }
    if (errorBuffer.length > 0) { pending++; flushBatch('error', errorBuffer, done); }
};

exports.logSuccess = function (requestPayload, responsePayload, requestId) {
    var log = requestId ? createRequestLogger('digiwhiff-rcs-de', { requestId: requestId }) : bgLog;
    var rowId = getNextRowId('success');
    log.info('DATABASE_OPERATION', 'Queuing SUCCESS record for DE insert', {
        rowId: rowId, apiStatus: responsePayload && responsePayload.statusCode, mid: responsePayload && responsePayload.mid
    });
    addToBuffer(log, 'success', rowId, requestPayload, responsePayload, 'Success');
    return rowId;
};

exports.logError = function (requestPayload, responsePayload, requestId) {
    var log = requestId ? createRequestLogger('digiwhiff-rcs-de', { requestId: requestId }) : bgLog;
    var rowId = getNextRowId('error');
    log.info('DATABASE_OPERATION', 'Queuing ERROR record for DE insert', {
        rowId: rowId,
        apiStatus: responsePayload && responsePayload.statusCode,
        apiStatusDesc: responsePayload && responsePayload.statusDesc,
        errorCode: responsePayload && responsePayload.code
    });
    addToBuffer(log, 'error', rowId, requestPayload, responsePayload, 'Failed');
    return rowId;
};

// Retrieve rows from a Data Extension via the SFMC REST API.
// type: 'success' | 'error'
exports.fetchRecords = function (type, callback) {
    var deKey = type === 'success' ? SFMC_CONFIG.successDeKey : SFMC_CONFIG.errorDeKey;
    var deName = type === 'success'
        ? 'DIGIWHIFF_WHATSAPP_SUCCESS_LOG_DE'
        : 'DIGIWHIFF_WHATSAPP_ERROR_LOG_DE';
    var log = bgLog;

    if (!SFMC_CONFIG.restUrl || !deKey) {
        log.error('DATABASE_OPERATION', 'Fetch aborted — SFMC_REST_URL or DE key not configured', null, { type: type, deName: deName });
        return callback(new Error('SFMC_REST_URL or DE key not configured'));
    }

    getAccessToken(log, function (err, token) {
        if (err) {
            log.error('DATABASE_OPERATION', 'Fetch aborted — token error', err, { type: type, deName: deName });
            return callback(err);
        }

        var url = SFMC_CONFIG.restUrl + '/data/v1/customobjectdata/key/' + deKey + '/rowset';
        var endStep = log.startStep('EXTERNAL_API_CALL', 'Fetching rows from SFMC DE', { type: type, deName: deName, url: url, method: 'GET' });

        request.get({
            url: url,
            json: true,
            headers: { 'Authorization': 'Bearer ' + token }
        }, function (err, res, body) {
            if (err) {
                endStep({ error: err, message: 'DE fetch call failed — network error', data: { type: type, deName: deName, url: url } });
                return callback(err);
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                endStep({
                    level: 'error',
                    message: 'DE fetch returned error response',
                    data: { type: type, deName: deName, url: url, httpStatus: res.statusCode, responseBody: body }
                });
                return callback(new Error('SFMC DE fetch HTTP ' + res.statusCode + ': ' + JSON.stringify(body)));
            }

            var records = (body && body.items) || [];
            endStep({
                message: 'Rows fetched from SFMC DE',
                data: { type: type, deName: deName, url: url, httpStatus: res.statusCode, responseBody: body, recordCount: records.length }
            });
            callback(null, records);
        });
    });
};

// Load persisted counters on module load
loadCounters();
