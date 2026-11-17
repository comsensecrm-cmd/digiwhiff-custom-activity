'use strict';

// Load environment variables from .env file
require('dotenv').config();

// Module Dependencies
// -------------------
var express = require('express');
var bodyParser = require('body-parser');
var errorhandler = require('errorhandler');
var http = require('http');
var path = require('path');
var routes = require('./routes');
var activity = require('./routes/activity');
var sfmcLogger = require('./lib/sfmcLogger');
var loggerModule = require('./lib/logger');
var logger = loggerModule.logger;
var verifyCloudWatchConnection = loggerModule.verifyCloudWatchConnection;
var requestLoggerMiddleware = loggerModule.requestLoggerMiddleware;
var flushCloudWatch = loggerModule.flushCloudWatch;

var app = express();

// Configure Express
app.set('port', process.env.PORT || 3001);
app.use(bodyParser.json({ type: 'application/json' }));
//app.use(bodyParser.urlencoded({ extended: true }));

//app.use(express.methodOverride());
//app.use(express.favicon());

app.use(express.static(path.join(__dirname, 'public')));

// Express in Development Mode
if ('development' == app.get('env')) {
  app.use(errorhandler());
}

// Attaches req.log (a request-scoped, correlation-ID-carrying logger) to
// every Journey Builder callback so the full lifecycle of a single request
// — received, validated, external call, response, sent — can be traced by
// filtering CloudWatch/console output on one requestId.
app.use('/journeybuilder', requestLoggerMiddleware('digiwhiff-rcs'));

app.use('/journeybuilder/execute/', function (req, res, next) {
  req.log.info('REQUEST_RECEIVED', 'Execute endpoint received', {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    body: req.body
  });
  next();
});

// HubExchange Routes
app.get('/', routes.index);
app.post('/login', routes.login);
app.post('/logout', routes.logout);

// Custom Hello World Activity Routes
app.post('/journeybuilder/save/', activity.save);
app.post('/journeybuilder/validate/', activity.validate);
app.post('/journeybuilder/publish/', activity.publish);
app.post('/journeybuilder/execute/', activity.execute);

// Counter Management Routes
app.post('/counter/reset', function (req, res) {
    sfmcLogger.resetCounters();
    res.json({ message: 'Counters reset to 0', success: 0, error: 0 });
});

// Data Extension Record Retrieval Routes
app.get('/de/records/:type', function (req, res) {
    var type = req.params.type;
    if (type !== 'success' && type !== 'error') {
        return res.status(400).json({ error: 'type must be "success" or "error"' });
    }
    sfmcLogger.fetchRecords(type, function (err, records) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ type: type, count: records.length, records: records });
    });
});

http.createServer(app).listen(app.get('port'), function () {
  var logGroup = process.env.AWS_LOG_GROUP || 'comsense-internal';
  var logStream = process.env.AWS_LOG_STREAM || 'digiwhiff-custom-activity-logs';

  logger.info('Express server listening on port ' + app.get('port'), { step: 'STARTUP', flow: 'digiwhiff-rcs' });

  // Verify CloudWatch connection on startup so a misconfigured log
  // group/stream/region is surfaced immediately instead of discovered later
  // as "logs are missing".
  verifyCloudWatchConnection(function (err, connected) {
    var meta = { step: 'STARTUP_CLOUDWATCH', flow: 'digiwhiff-rcs', data: { region: process.env.AWS_REGION || 'ap-south-1', logGroup: logGroup, logStream: logStream } };
    if (err) {
      logger.error('CloudWatch connection FAILED: ' + err.message, meta);
    } else if (connected) {
      logger.info('CloudWatch logging connected successfully', meta);
    } else {
      logger.warn('CloudWatch log stream not found — it will be created automatically on first log', meta);
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — a PM2 restart/redeploy sends SIGTERM. Both the
// CloudWatch transport (1s upload batching) and the SFMC DE write buffers
// (2s idle-flush / 10-record batch / 30s safety-net) hold data in memory
// that is lost if the process exits before their timers fire. Drain both
// before actually exiting so in-flight execute records aren't stranded.
// ---------------------------------------------------------------------------
var shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown signal received — flushing CloudWatch and DE buffers', { step: 'SHUTDOWN', flow: 'digiwhiff-rcs', data: { signal: signal } });

  // Hard cap below PM2's --kill-timeout (must be started with
  // `pm2 start app.js --kill-timeout 10000`, see README) — if SFMC or
  // CloudWatch hang, exit anyway rather than let PM2's SIGKILL cut in.
  var forceExitTimer = setTimeout(function () {
    logger.warn('Shutdown flush timed out — exiting anyway', { step: 'SHUTDOWN', flow: 'digiwhiff-rcs' });
    process.exit(0);
  }, 8000);

  sfmcLogger.flushAllOnShutdown(function () {
    flushCloudWatch(function () {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  });
}
process.on('SIGTERM', function () { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function () { gracefulShutdown('SIGINT'); });
