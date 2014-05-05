var express = require('express');
var cluster = require('cluster');
var domain  = require('domain');
var os      = require('os');
var logger  = require('node-console-enhance');
var http_errors = require('node-http-errors');
function Worker (port, configure, callback) {
    logger.enable('Worker');
    this.domain    = domain.create();
    this.configure = configure;
    this.callback  = callback;
    this.closing   = false;
    this.socketID  = 0;
    this.domain.on('error', this.errorHandler.bind(this));
    this.domain.run(function () {
        this.run(port);
    }.bind(this));
    process.on('SIGINT',  this.sigintHandler.bind(this));
    process.on('SIGTERM', this.sigtermHandler.bind(this));
}
Worker.prototype.run = function workerRun (port) {
    this.app     = express();
    this.server  = this.app.listen(port || 8080);
    this.app.use(express.json());
    this.app.use(express.urlencoded());
    this.configure.call(null, this.app, this.server, express);
    this.app.use(this.closingMiddleware.bind(this));
    this.app.use(this.domainMiddleware.bind(this));
    this.app.use(this.app.router);
    this.callback.call(null, this.app, this.server, express);
    this.app.get('/health', this.healthMiddleware.bind(this));
    this.app.use(this.notFoundMiddleware.bind(this));
    this.app.use(this.domainErrorMiddleware.bind(this));
    this.app.use(this.errorMiddleware.bind(this));
};
Worker.prototype.notFoundMiddleware = function (request, response, next) {
    return next(new http_errors.NotFoundError(request.url));
};
Worker.prototype.domainMiddleware = function (request, response, next) {
    var d = domain.create();
    d.add(request);
    d.add(response);
    d.on('error', function (error) {
        d.exit();
        if (cluster.worker) {
            cluster.worker.disconnect();
        }
        return next(error);
    }.bind(this));
    response.on('close', d.exit.bind(d));
    return d.run(next);
};
Worker.prototype.domainErrorMiddleware = function (error, request, response, next) {
    if (domain.active) {
        return domain.active.emit('error', error);
    } else {
        return next(error);
    }
};
Worker.prototype.errorMiddleware = function (error, request, response, next) {
    console.error(error.stack || error.message || error);
    response.status(error.code || 500);
    if (request.xhr || request.accepts('json')) {
        return response.send({
            'status'  : error.status || 'Server Error',
            'code'    : error.code || 500,
            'message' : error.message,
            'stack'   : error.stack ? error.stack.split('\n') : []
        });
    }
    return response.type('txt').send(error.stack || error.message || error);
};
Worker.prototype.closingMiddleware = function closingMiddleware (request, response, next) {
    if (this.closing) {
        console.log('Server is restarting, connection close');
        response.setHeader('Connection', 'close');
        return response.send(502, 'Server is restarting');
    } else {
        return next();
    }
};
Worker.prototype.healthMiddleware = function healthMiddleware (request, response, next) {
    var health = {
        'pid'      : process.pid,
        'memory'   : process.memoryUsage(),
        'uptime'   : process.uptime(),
        'hostname' : os.hostname(),
        'node'     : process.version,
        'os'       : [os.type(), os.arch(), os.release()].join(' '),
        'load'     : os.loadavg()
    };
    if (cluster.worker) {
        health.cluster = cluster.worker.id;
    }
    return response.send(health);
};
Worker.prototype.errorHandler = function workerErrorHandler (error) {
    console.error('Worker Error', error.message, error.stack);
    this.exit();
};
Worker.prototype.exit = function workerExit () {
    console.info('Worker Exiting');
    this.closing = true;
    this.server.close(function () {
        console.log('Worker Server close');
        process.exit(0);
    });
    // make sure we close down within 30 seconds
    var timer = setTimeout(function() {
        console.log('Timedout');
        process.exit(1);
    }, 1 * 1000);
    // But don't keep the process open just for that!
    timer.unref();
};
Worker.prototype.sigintHandler = function workerSIGINT () {
    console.info('Worker SIGINT');
    if (!cluster.worker) {
        this.exit();
    }
};
Worker.prototype.sigtermHandler = function workerSIGTERM () {
    console.info('Worker SIGTERM');
    this.exit();
};
module.exports = Worker;
