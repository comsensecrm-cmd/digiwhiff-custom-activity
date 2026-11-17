'use strict';

var request = require('../lib/httpClient');
var sfmcLogger = require('../lib/sfmcLogger');

// --------------------------------------------------------------------------
// NexG RCS API Configuration
// --------------------------------------------------------------------------
const RCM_API_CONFIG = {
    // multi-send also handles single-template sends, so every request uses this one endpoint.
    endpoint: 'https://automate.nexgplatforms.com/api/v1/rcs/multi-send',
    authToken: '42f8e862670d4ed7b0a0146695c89d49',

    static: {
        messageType: 'template',
        botId: '84392637-0653-4ba0-957e-9a58f3dd915e'
    }
};

exports.logExecuteData = [];

function snapshotRequest(req) {
    return {
        body: req.body, headers: req.headers, trailers: req.trailers,
        method: req.method, url: req.url, params: req.params,
        query: req.query, route: req.route, cookies: req.cookies,
        ip: req.ip, path: req.path, host: req.hostname,
        fresh: req.fresh, stale: req.stale,
        protocol: req.protocol, secure: req.secure,
        originalUrl: req.originalUrl
    };
}

function logData(req) {
    exports.logExecuteData.push(snapshotRequest(req));
}

// A data-binding value Journey Builder failed to resolve still contains the
// raw {{...}} token instead of the real Data Extension value.
function isUnresolvedToken(value) {
    return typeof value === 'string' && value.indexOf('{{') !== -1 && value.indexOf('}}') !== -1;
}

// ---------------------------------------------------------------------------
// STEP: REQUEST_VALIDATION — every data-bound field, logged individually so
// a missing/unresolved binding is visible at the exact field, not just as a
// generic "bad payload" error further down the pipeline.
// ---------------------------------------------------------------------------
function validateBoundFields(log, formData) {
    var fieldsToTrace = [
        'to', 'templateId', 'url', 'buttonUrl'
    ];
    Object.keys(formData || {}).forEach(function (key) {
        if (/^(parameterValue|buttonVariables|carouselCardTitleVariables|carouselCardDescriptionVariables|callButtonVariables|visitWebsiteButtonVariables|visitWebsiteUrlVariables)\d+$/.test(key) && fieldsToTrace.indexOf(key) === -1) {
            fieldsToTrace.push(key);
        }
    });

    var unresolved = [];
    var fields = fieldsToTrace.map(function (fieldName) {
        var rawValue = formData ? formData[fieldName] : undefined;
        var isMissing = rawValue === undefined || rawValue === null || rawValue === '';
        var isUnresolved = isUnresolvedToken(rawValue);
        if (isUnresolved) unresolved.push(fieldName);
        return { field: fieldName, isMissing: isMissing, isUnresolvedToken: isUnresolved };
    });

    log.info('REQUEST_VALIDATION', 'Data-binding fields checked', {
        fields: fields,
        unresolvedFields: unresolved
    });

    if (unresolved.length > 0) {
        log.warn('REQUEST_VALIDATION', 'Unresolved {{...}} data-binding token(s) present — Journey Builder failed to substitute these fields', {
            unresolvedFields: unresolved,
            values: unresolved.reduce(function (acc, f) { acc[f] = formData[f]; return acc; }, {})
        });
    }

    return unresolved;
}

// Every NexG RCS variable field is collected in the UI under a readable internal name
// (buttonVariables, carouselCardTitleVariables, etc. — see api-schemas.json) as up to 10
// indexed keys (fieldNameN, same pattern as messageTextVariablesN) so each entry can be
// independently DE-bound or static and resolved by SFMC on its own — a {{...}} binding
// is only ever resolved when it's a whole inArguments value, never embedded mid-string.
// By the time this runs, SFMC has already substituted each key's real value; join them
// here into the single comma-separated string NexG expects (e.g. "Bullet-350, CSV1").
// Falls back to the plain fieldName value if present (e.g. an older saved config that
// predates the indexed-key format).
function resolveMultiValueField(formData, fieldName) {
    var indexed = [];
    for (var i = 0; i < 10; i++) {
        var val = formData[fieldName + i];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
            indexed.push(val);
        }
    }
    if (indexed.length > 0) return indexed.join(', ');
    return formData[fieldName] || '';
}

// Maps our internal, UI-facing inArguments field names onto the exact field names the
// NexG RCS API requires in rcs_detail (per RCS_MultiSend_API_Reference.md and the
// DigiWhiff Postman collection — these are the external API's own contract and must
// NOT be renamed on the outbound request).
var NEXG_FIELD_MAP = {
    buttonVariables: 'button_var',
    carouselCardTitleVariables: 'carsoul_title_var',
    carouselCardDescriptionVariables: 'carsoul_desc_var',
    callButtonVariables: 'calltobtn_var',
    visitWebsiteButtonVariables: 'visittobtn_var',
    visitWebsiteUrlVariables: 'visittourl_var'
};

// ---------------------------------------------------------------------------
// STEP: REQUEST_TRANSFORMATION — map SFMC inArguments field names onto the
// NexG RCS API's expected payload shape.
// ---------------------------------------------------------------------------
function buildApiPayload(log, formData) {
    var endStep = log.startStep('REQUEST_TRANSFORMATION', 'Mapping bound fields into NexG RCS payload shape');

    // templateId always comes from the marketer's own configuration (DE-bound or static).
    var templateId = formData.templateId || '';
    var endpoint = RCM_API_CONFIG.endpoint;

    // messageTextVariables is stored under the DE-schema-convention keys parameterValue0,
    // parameterValue1, … (independent of the field's own internal/UI name) — see
    // customActivity.js::convertToDataExtensionBindings().
    var rcsDetail = {
        contactnumber: formData.to || '',
        messageuuid: templateId,
        message_var: resolveMultiValueField(formData, 'parameterValue')
    };
    Object.keys(NEXG_FIELD_MAP).forEach(function (internalName) {
        rcsDetail[NEXG_FIELD_MAP[internalName]] = resolveMultiValueField(formData, internalName);
    });
    rcsDetail.button_var = rcsDetail.button_var || '[]';

    var rcmPayload = {
        templateid: templateId,
        bot_id: RCM_API_CONFIG.static.botId,
        messageType: RCM_API_CONFIG.static.messageType,
        rcs_detail: [rcsDetail]
    };

    endStep({ message: 'NexG RCS API payload built successfully', data: { payload: rcmPayload, endpoint: endpoint } });
    return { payload: rcmPayload, endpoint: endpoint };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
exports.edit = function (req, res) {
    logData(req);
    res.status(200).send('Edit');
};

exports.save = function (req, res) {
    req.log.info('REQUEST_RECEIVED', 'Save endpoint called', { body: req.body });
    logData(req);
    req.log.done({ outcome: 'ok' });
    res.status(200).send('Save');
};

exports.publish = function (req, res) {
    req.log.info('REQUEST_RECEIVED', 'Publish endpoint called', { body: req.body });
    logData(req);
    req.log.done({ outcome: 'ok' });
    res.status(200).send('Publish');
};

exports.validate = function (req, res) {
    req.log.info('REQUEST_RECEIVED', 'Validate endpoint called', { body: req.body });
    logData(req);
    req.log.done({ outcome: 'ok' });
    res.status(200).send('Validate');
};

// ---------------------------------------------------------------------------
// Execute — full request lifecycle: received -> validated -> transformed ->
// external API call -> response received -> DE write queued -> response sent.
// Every step below shares req.log's requestId, so the whole flow for one
// SFMC execute call can be pulled from CloudWatch by filtering on that ID.
// ---------------------------------------------------------------------------
exports.execute = function (req, res) {
    var log = req.log;
    var recordContext = { mobileNumber: undefined, interactionId: req.body && req.body.interactionId, rowId: undefined };

    // recordDone(step, outcome) — logs RECORD_PROCESSING_COMPLETED exactly
    // once per record, tagged with whatever rowId/mobileNumber/interactionId
    // are known at that point, so a single requestId filter in CloudWatch
    // shows the full start-to-finish lifecycle for this one record.
    function recordDone(outcome) {
        log.info('RECORD_PROCESSING_COMPLETED', 'Record processing completed', Object.assign({
            mobileNumber: recordContext.mobileNumber,
            interactionId: recordContext.interactionId,
            rowId: recordContext.rowId
        }, outcome || {}));
    }

    try {
        // STEP: REQUEST_RECEIVED already logged by the app.js middleware.

        log.info('RECORD_PROCESSING_STARTED', 'Record processing started', {
            mobileNumber: recordContext.mobileNumber,
            interactionId: recordContext.interactionId
        });

        if (!req.body || !req.body.inArguments || !req.body.inArguments[0]) {
            log.error('REQUEST_VALIDATION', 'Execute called with missing or empty inArguments', null, { body: req.body });
            recordDone({ outcome: 'error', httpStatus: 400 });
            log.done({ outcome: 'error', httpStatus: 400 });
            return res.status(400).send('Missing inArguments');
        }

        var requestBody = req.body.inArguments[0];
        recordContext.mobileNumber = requestBody.to;

        log.info('REQUEST_VALIDATION', 'Input Data Extension record details', {
            mobileNumber: recordContext.mobileNumber,
            interactionId: recordContext.interactionId,
            templateId: requestBody.templateId,
            allFields: requestBody // sensitive keys (authorization/token/secret/etc.) are redacted automatically by the logger
        });

        validateBoundFields(log, requestBody);

        var built = buildApiPayload(log, requestBody);
        var rcmPayload = built.payload;
        var rcmEndpoint = built.endpoint;

        var rcmRequestHeaders = {
            'Content-Type': 'application/json',
            'Authorization': RCM_API_CONFIG.authToken // masked automatically by the logger's redact()
        };

        log.info('EXTERNAL_API_CALL', 'Complete request body and headers for NexG RCM API', {
            mobileNumber: recordContext.mobileNumber,
            interactionId: recordContext.interactionId,
            endpoint: rcmEndpoint,
            httpMethod: 'POST',
            headers: rcmRequestHeaders,
            requestBody: rcmPayload
        });

        var apiRequestStartedAt = new Date().toISOString();

        var endExternalCall = log.startStep('EXTERNAL_API_CALL', 'Calling NexG RCM API', {
            mobileNumber: recordContext.mobileNumber,
            interactionId: recordContext.interactionId,
            endpoint: rcmEndpoint,
            httpMethod: 'POST',
            requestStartedAt: apiRequestStartedAt
        });

        request.post({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': RCM_API_CONFIG.authToken
            },
            url: rcmEndpoint,
            body: rcmPayload,
            json: true,
            timeout: 30000,
            onEvent: function (eventName, data) {
                // Low-level socket/DNS/TLS/dispatch lifecycle — helps distinguish
                // "never dispatched" from "dispatched but no response" from
                // "connected but TLS/DNS failed" when diagnosing hangs/timeouts.
                log.debug('EXTERNAL_API_CALL_LIFECYCLE', eventName, { event: eventName, detail: data });
            }
        }, function (error, apiResponse, apiBody) {
            try {
                if (error) {
                    var networkErrDurationMs = endExternalCall({
                        error: error,
                        data: {
                            errorCode: error.code || 'UNKNOWN',
                            endpoint: rcmEndpoint,
                            httpStatus: apiResponse ? apiResponse.statusCode : undefined,
                            responseHeaders: apiResponse ? apiResponse.headers : undefined,
                            rawResponseBody: error.rawBody
                        }
                    });

                    log.info('DATABASE_OPERATION', 'Routing to Error DE (network failure)', { deType: 'error' });
                    recordContext.rowId = sfmcLogger.logError(rcmPayload, { error: error.message, code: error.code || 'NETWORK_ERROR', rawResponseBody: error.rawBody }, log.requestId);

                    logData(req);
                    recordDone({
                        outcome: 'error', httpStatus: 500, deStatus: 'Error DE',
                        apiExecutionMs: networkErrDurationMs,
                        errorMessage: error.message, errorCode: error.code, stack: error.stack
                    });
                    log.done({ outcome: 'error', httpStatus: 500 });
                    return res.status(500).send('RCM API call failed: ' + error.message);
                }

                if (!apiBody) {
                    var emptyDurationMs = endExternalCall({
                        level: 'warn',
                        message: 'RCM API returned empty or non-JSON response body',
                        data: { httpStatus: apiResponse.statusCode, responseHeaders: apiResponse.headers }
                    });
                    recordContext.rowId = sfmcLogger.logError(rcmPayload, { error: 'Empty or non-JSON RCM API response', httpStatus: apiResponse.statusCode }, log.requestId);
                    logData(req);
                    recordDone({
                        outcome: 'empty_response', httpStatus: 200, deStatus: 'Error DE',
                        apiResponseStatusCode: apiResponse.statusCode, apiExecutionMs: emptyDurationMs
                    });
                    log.done({ outcome: 'empty_response', httpStatus: 200 });
                    return res.status(200).send('Execute completed');
                }

                var resultEntry = (apiBody.data && apiBody.data.results && apiBody.data.results[0]) || {};

                var apiExecutionMs = endExternalCall({
                    message: 'RCM send-message API response received',
                    data: {
                        httpStatus: apiResponse.statusCode,
                        apiCode: apiBody.code,
                        apiStatus: apiBody.status,
                        description: apiBody.description,
                        messageId: resultEntry.messageid || '',
                        responseBody: apiBody
                    }
                });

                // Only code "200" / status "success" is a true success — anything else is an API-level error.
                var isSuccess = String(apiBody.code) === '200' && apiBody.status === 'success';

                log.info('DATABASE_OPERATION', 'Queuing record into ' + (isSuccess ? 'Success' : 'Error') + ' DE buffer', {
                    de: isSuccess ? 'DIGIWHIFF_WHATSAPP_SUCCESS_LOG_DE' : 'DIGIWHIFF_WHATSAPP_ERROR_LOG_DE',
                    mobileNumber: recordContext.mobileNumber,
                    isSuccess: isSuccess,
                    reason: isSuccess
                        ? 'code is "200" and status is "success"'
                        : 'code "' + apiBody.code + '" / status "' + apiBody.status + '" is not success — treated as error'
                });

                if (isSuccess) {
                    recordContext.rowId = sfmcLogger.logSuccess(rcmPayload, apiBody, log.requestId);
                } else {
                    recordContext.rowId = sfmcLogger.logError(rcmPayload, apiBody, log.requestId);
                }

                logData(req);
                recordDone({
                    outcome: isSuccess ? 'success' : 'error',
                    httpStatus: 200,
                    deStatus: isSuccess ? 'Success DE' : 'Error DE',
                    templateId: requestBody.templateId,
                    apiResponseStatusCode: apiResponse.statusCode,
                    apiCode: apiBody.code,
                    apiExecutionMs: apiExecutionMs,
                    messageId: resultEntry.messageid || ''
                });
                log.done({
                    outcome: isSuccess ? 'success' : 'error',
                    httpStatus: 200,
                    to: requestBody.to,
                    templateId: requestBody.templateId,
                    apiCode: apiBody.code,
                    messageId: resultEntry.messageid || ''
                });
                res.status(200).send('Execute completed');

            } catch (callbackErr) {
                // Safety net: an uncaught throw here would otherwise silently kill
                // the response (SFMC sees a timeout) with nothing further logged.
                log.error('EXTERNAL_API_CALL', 'Unhandled exception inside RCM API response callback', callbackErr, {
                    endpoint: rcmEndpoint
                });
                recordDone({ outcome: 'exception', httpStatus: 500, errorMessage: callbackErr.message, stack: callbackErr.stack });
                if (!res.headersSent) {
                    res.status(500).send('Execute failed: ' + callbackErr.message);
                }
                log.done({ outcome: 'exception', httpStatus: 500 });
            }
        });

    } catch (execErr) {
        // Safety net: any synchronous exception before the async RCM API call
        // is issued (e.g. bad payload construction).
        log.error('REQUEST_VALIDATION', 'Unhandled exception in execute handler', execErr);
        recordDone({ outcome: 'exception', httpStatus: 500, errorMessage: execErr.message, stack: execErr.stack });
        if (!res.headersSent) {
            res.status(500).send('Execute failed: ' + execErr.message);
        }
        log.done({ outcome: 'exception', httpStatus: 500 });
    }
};
