var express = require('express');
var cluster = require('cluster');
var domain  = require('domain');
var os      = require('os');
var logger  = require('node-console-enhance');
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
    this.app.use(this.domainErrorMiddleware.bind(this));
    this.app.use(this.errorMiddleware.bind(this));
    this.callback.call(null, this.app, this.server, express);
    this.app.get('/health', this.healthMiddleware.bind(this));
};
Worker.prototype.domainMiddleware = function (request, response, next) {
    var d = domain.create();
    d.on('error', function (error) {
        console.error('WHAT', error);
        next(error);
        if (cluster.worker) {
            cluster.worker.disconnect();
        }
        d.dispose();
    }.bind(this));
    response.on('close', d.dispose.bind(d));
    d.add(request);
    d.add(response);
    return d.run(next);
};
Worker.prototype.domainErrorMiddleware = function (error, request, response, next) {
    console.error('Error Middleware', error);
    if (domain.active) {
        console.log('Caught domain error handler');
        domain.active.emit('error', error);
    } else {
        return next(error);
    }
};
Worker.prototype.errorMiddleware = function (error, request, response, next) {
    return response.send(500, {
        'message' : error.message,
        'stack'   : error.stack
    });
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
