'use strict';

var crypto = require('crypto');
var winston = require('winston');
var WinstonCloudWatch = require('winston-cloudwatch');
var CloudWatchLogsClient = require('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient;
var DescribeLogStreamsCommand = require('@aws-sdk/client-cloudwatch-logs').DescribeLogStreamsCommand;

var cloudWatchConfig = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-south-1',
    logGroupName: process.env.AWS_LOG_GROUP || 'comsense-internal',
    logStreamName: process.env.AWS_LOG_STREAM || 'digiwhiff-custom-activity-logs'
};

// ---------------------------------------------------------------------------
// Sensitive-field redaction
//
// Applied to every logged data object so secrets never reach console or
// CloudWatch, regardless of which call site produced them.
// ---------------------------------------------------------------------------
var SENSITIVE_KEY_NAMES = [
    'authorization', 'token', 'secret', 'password',
    'clientsecret', 'accesstoken', 'accesskeyid', 'secretaccesskey', 'apikey'
];

function isSensitiveKey(key) {
    var normalized = String(key).toLowerCase().replace(/[_-]/g, '');
    return SENSITIVE_KEY_NAMES.indexOf(normalized) !== -1;
}

function redact(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined || depth > 6) return value;

    if (Array.isArray(value)) {
        return value.map(function (item) { return redact(item, depth + 1); });
    }

    if (typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (key) {
            if (isSensitiveKey(key)) {
                out[key] = maskString(value[key]);
            } else {
                out[key] = redact(value[key], depth + 1);
            }
        });
        return out;
    }

    return value;
}

function maskString(val) {
    if (typeof val !== 'string' || val.length === 0) return '[REDACTED]';
    if (val.length <= 8) return '[REDACTED]';
    return val.slice(0, 4) + '...' + val.slice(-4) + ' [MASKED]';
}

// ---------------------------------------------------------------------------
// Console transport — human-readable one-liner per log entry
// Format: [timestamp] [LEVEL] [requestId] [step] message  {data}  (+123ms)
// ---------------------------------------------------------------------------
var consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(function (info) {
        var reqId = info.requestId ? '[' + info.requestId + '] ' : '';
        var step = info.step ? '[' + info.step + '] ' : '';
        var duration = info.durationMs !== undefined ? '  (+' + info.durationMs + 'ms)' : '';
        var data = info.data !== undefined ? '  ' + JSON.stringify(info.data) : '';
        return '[' + info.timestamp + '] [' + info.level.toUpperCase() + '] ' + reqId + step + info.message + data + duration;
    })
);

// ---------------------------------------------------------------------------
// CloudWatch transport — full structured JSON per log entry.
// Every field is queryable in CloudWatch Logs Insights, e.g.:
//   fields @timestamp, requestId, step, level, message, durationMs, data
//   | filter requestId = "..."
//   | sort @timestamp asc
// ---------------------------------------------------------------------------
var cloudWatchTransport = new WinstonCloudWatch({
    logGroupName: cloudWatchConfig.logGroupName,
    logStreamName: cloudWatchConfig.logStreamName,
    awsRegion: cloudWatchConfig.region,
    awsAccessKeyId: cloudWatchConfig.accessKeyId,
    awsSecretKey: cloudWatchConfig.secretAccessKey,
    jsonMessage: true,
    // Flush frequently and in small batches so a burst of request-lifecycle
    // logs (received -> validated -> external call -> response -> sent) is
    // never held back long enough to look "missing" to someone tailing logs.
    uploadRate: 1000,
    messageFormatter: function (info) {
        return JSON.stringify({
            timestamp: info.timestamp || new Date().toISOString(),
            level: info.level,
            requestId: info.requestId || null,
            step: info.step || null,
            flow: info.flow || 'digiwhiff-rcs',
            message: info.message,
            durationMs: info.durationMs !== undefined ? info.durationMs : null,
            data: info.data !== undefined ? info.data : null
        });
    }
});

// winston-cloudwatch emits 'error' on transient AWS failures (throttling,
// invalid sequence token, network blips). An EventEmitter 'error' with no
// listener is a fatal, uncaught exception in Node, which used to crash the
// whole process on every transient CloudWatch hiccup. Log it locally instead.
cloudWatchTransport.on('error', function (err) {
    // eslint-disable-next-line no-console
    console.error('[CloudWatch transport error - non-fatal]', err && err.message);
});

var logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
        cloudWatchTransport
    ]
});

logger.on('error', function (err) {
    // eslint-disable-next-line no-console
    console.error('[Logger transport error - non-fatal]', err && err.message);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — winston-cloudwatch batches log events in memory and
// flushes on a 1s timer (uploadRate). A PM2 restart/redeploy sends SIGTERM
// and can kill the process before that timer fires, silently dropping every
// buffered CloudWatch event (console/PM2 output is unaffected since stdout
// is written synchronously per line). kthxbye() drains the queue before exit.
//
// flushCloudWatch is exported (rather than registering process.on() here
// directly) so app.js can run it alongside sfmcLogger's DE-buffer flush and
// exit only once both are done — see app.js's SIGTERM/SIGINT handler.
// ---------------------------------------------------------------------------
function flushCloudWatch(callback) {
    cloudWatchTransport.kthxbye(callback);
}

// ---------------------------------------------------------------------------
// Global safety net — log and continue instead of dying on an unexpected
// error anywhere in the process. A crash here previously caused PM2 to
// silently restart the app mid-request, dropping/duplicating in-flight work.
// ---------------------------------------------------------------------------
process.on('uncaughtException', function (err) {
    logger.error('Uncaught exception — process kept alive', {
        step: 'PROCESS_UNCAUGHT_EXCEPTION',
        data: { message: err && err.message, stack: err && err.stack }
    });
});
process.on('unhandledRejection', function (reason) {
    var isError = reason instanceof Error;
    logger.error('Unhandled promise rejection — process kept alive', {
        step: 'PROCESS_UNHANDLED_REJECTION',
        data: { message: isError ? reason.message : String(reason), stack: isError ? reason.stack : undefined }
    });
});

// ---------------------------------------------------------------------------
// Request ID generation
// ---------------------------------------------------------------------------
function generateRequestId() {
    return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// RequestLogger — one instance per inbound request or per independent
// background operation (e.g. a DE batch flush). Carries the correlation ID
// and step timers so every log line for that unit of work is traceable and
// its duration is measured without every call site doing its own math.
//
// Usage:
//   var log = createRequestLogger('execute', { requestId: incomingId });
//   log.info('REQUEST_RECEIVED', 'Execute endpoint received', { ... });
//   var stepEnd = log.startStep('EXTERNAL_API_CALL');
//   ...
//   stepEnd({ httpStatus: 200 });               // logs completion + durationMs
//   log.error('EXTERNAL_API_CALL', 'RCM API call failed', err, { ... });
//   log.done({ outcome: 'success' });           // logs total request duration
// ---------------------------------------------------------------------------
function createRequestLogger(flow, options) {
    options = options || {};
    var requestId = options.requestId || generateRequestId();
    var startedAt = process.hrtime.bigint();

    function elapsedMs() {
        return Number((process.hrtime.bigint() - startedAt) / 1000000n);
    }

    function base(level, step, message, data) {
        logger.log(level, message, {
            requestId: requestId,
            step: step,
            flow: flow,
            data: data !== undefined ? redact(data) : undefined
        });
    }

    function withDuration(level, step, message, data, durationMs) {
        logger.log(level, message, {
            requestId: requestId,
            step: step,
            flow: flow,
            durationMs: durationMs,
            data: data !== undefined ? redact(data) : undefined
        });
    }

    return {
        requestId: requestId,

        debug: function (step, message, data) { base('debug', step, message, data); },
        info: function (step, message, data) { base('info', step, message, data); },
        warn: function (step, message, data) { base('warn', step, message, data); },

        // error(step, message, err, extraData) — err is an Error, a string, or omitted.
        error: function (step, message, err, extraData) {
            var errData = {};
            if (err instanceof Error) {
                errData.errorMessage = err.message;
                errData.stack = err.stack;
            } else if (typeof err === 'string') {
                errData.errorMessage = err;
            } else if (err !== undefined && err !== null) {
                errData.error = err;
            }
            var data = Object.assign({}, errData, extraData || {});
            base('error', step, message, data);
        },

        // startStep(step, message?, data?) — logs the step starting, returns a
        // function to call on completion; that call logs the same step's
        // outcome together with how long it took. Use for anything with a
        // measurable duration: external API calls, DB/DE operations, etc.
        startStep: function (step, message, data) {
            var stepStartedAt = process.hrtime.bigint();
            base('info', step, message || (step + ' started'), data);

            return function finishStep(outcome) {
                outcome = outcome || {};
                var durationMs = Number((process.hrtime.bigint() - stepStartedAt) / 1000000n);
                var level = outcome.level || (outcome.error ? 'error' : 'info');
                var finishMessage = outcome.message || (step + ' completed');
                var data = outcome.data;
                if (outcome.error) {
                    var errData = {};
                    if (outcome.error instanceof Error) {
                        errData.errorMessage = outcome.error.message;
                        errData.stack = outcome.error.stack;
                    } else {
                        errData.errorMessage = String(outcome.error);
                    }
                    data = Object.assign({}, errData, data || {});
                }
                withDuration(level, step, finishMessage, data, durationMs);
                return durationMs;
            };
        },

        // done(summary?) — call exactly once when the request/operation is
        // fully finished (response sent, or background job complete). Logs
        // total elapsed time so slow requests are visible without manually
        // computing start-to-end durations at every call site.
        done: function (summary) {
            withDuration('info', 'REQUEST_COMPLETE', 'Request lifecycle complete', summary, elapsedMs());
        },

        elapsedMs: elapsedMs
    };
}

// ---------------------------------------------------------------------------
// Express middleware — attaches a RequestLogger to every inbound HTTP
// request as req.log, propagating an inbound X-Request-Id header if the
// caller (e.g. a load balancer, or SFMC itself) already supplies one, so
// logs stay correlated across service boundaries.
// ---------------------------------------------------------------------------
function requestLoggerMiddleware(flow) {
    return function (req, res, next) {
        var incomingId = req.headers['x-request-id'];
        req.log = createRequestLogger(flow, { requestId: incomingId });
        res.setHeader('X-Request-Id', req.log.requestId);
        next();
    };
}

// ---------------------------------------------------------------------------
// CloudWatch connection verifier — called once at startup so a
// misconfigured log group/stream/region is surfaced immediately instead of
// discovered later as "logs are missing".
// ---------------------------------------------------------------------------
function verifyCloudWatchConnection(callback) {
    var cwLogs = new CloudWatchLogsClient({
        region: cloudWatchConfig.region,
        credentials: {
            accessKeyId: cloudWatchConfig.accessKeyId,
            secretAccessKey: cloudWatchConfig.secretAccessKey
        }
    });

    cwLogs.send(new DescribeLogStreamsCommand({
        logGroupName: cloudWatchConfig.logGroupName,
        logStreamNamePrefix: cloudWatchConfig.logStreamName,
        limit: 1
    }), function (err, data) {
        if (err) return callback(err, false);
        callback(null, data.logStreams && data.logStreams.length > 0);
    });
}

module.exports = {
    logger: logger,
    createRequestLogger: createRequestLogger,
    requestLoggerMiddleware: requestLoggerMiddleware,
    verifyCloudWatchConnection: verifyCloudWatchConnection,
    flushCloudWatch: flushCloudWatch,
    redact: redact
};
