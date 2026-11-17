'use strict';

// Minimal drop-in replacement for the deprecated `request` package, covering
// only the subset of the API this project uses:
//   httpClient.post({ url, headers, body, json, timeout }, function (err, res, body) {})
// `res` mimics request's response object with a `statusCode` property, and
// `body` is parsed JSON when `json: true` was passed (matching `request`'s behavior).

var http = require('http');
var https = require('https');

// Optional low-level lifecycle logger — pass options.onEvent(eventName, data) to
// observe socket/DNS/TLS/dispatch timing for a single call without affecting
// callers that don't opt in.
function request(method, options, callback) {
    var parsedUrl = new URL(options.url);
    var isHttps = parsedUrl.protocol === 'https:';
    var transport = isHttps ? https : http;
    var onEvent = typeof options.onEvent === 'function' ? options.onEvent : function () {};

    var payload = method === 'GET' ? undefined : (options.json ? JSON.stringify(options.body) : options.body);
    var headers = options.headers || {};

    if (payload !== undefined && payload !== null) {
        headers['Content-Length'] = Buffer.byteLength(payload);
    }

    var requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: headers,
        timeout: options.timeout
    };

    var req = transport.request(requestOptions, function (res) {
        onEvent('response_headers_received', { statusCode: res.statusCode, headers: res.headers });

        var chunks = [];
        var bytesReceived = 0;
        res.on('data', function (chunk) {
            chunks.push(chunk);
            bytesReceived += chunk.length;
        });
        res.on('end', function () {
            var rawBody = Buffer.concat(chunks).toString('utf8');
            onEvent('response_body_complete', { bytesReceived: bytesReceived, rawBody: rawBody });

            var parsedBody = rawBody;
            if (options.json) {
                try {
                    parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
                } catch (e) {
                    onEvent('response_json_parse_error', { error: e.message, rawBody: rawBody });
                    e.rawBody = rawBody;
                    return callback(e, res, undefined);
                }
            }
            callback(null, res, parsedBody);
        });
    });

    req.on('socket', function (socket) {
        onEvent('socket_assigned', { reused: socket.reused === true });
        socket.on('lookup', function (err, address, family) {
            onEvent('dns_lookup', { error: err ? err.message : null, address: address, family: family });
        });
        socket.on('connect', function () {
            onEvent('tcp_connected', {});
        });
        socket.on('secureConnect', function () {
            onEvent('tls_connected', { authorized: socket.authorized, protocol: socket.getProtocol && socket.getProtocol() });
        });
    });

    req.on('error', function (err) {
        onEvent('request_error', { code: err.code, message: err.message });
        callback(err, undefined, undefined);
    });

    if (options.timeout) {
        req.on('timeout', function () {
            onEvent('request_timeout', { timeoutMs: options.timeout });
            req.destroy();
            var timeoutError = new Error('ETIMEDOUT');
            timeoutError.code = 'ETIMEDOUT';
            callback(timeoutError, undefined, undefined);
        });
    }

    if (payload !== undefined && payload !== null) {
        req.write(payload);
    }
    req.end();
    onEvent('request_dispatched', { hostname: requestOptions.hostname, path: requestOptions.path, payloadBytes: payload ? Buffer.byteLength(payload) : 0 });
}

function post(options, callback) {
    request('POST', options, callback);
}

function get(options, callback) {
    request('GET', options, callback);
}

module.exports = { post: post, get: get };
