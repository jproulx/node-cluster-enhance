var express = require('express');
var cluster = require('cluster');
var domain  = require('domain');
var os      = require('os');
var logger  = require('node-console-enhance');
logger(console, 'Worker');
function Worker (port, callback) {
    this.domain   = domain.create();
    this.callback = callback;
    this.closing  = false;
    this.socketID = 0;
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
    this.app.use(this.domainMiddleware.bind(this));
    this.app.use(this.closingMiddleware.bind(this));
    this.app.use(this.errorMiddleware.bind(this));
    this.callback.call(null, this.app, this.server, express);
    this.app.get('/health', this.healthMiddleware.bind(this));
};
Worker.prototype.domainMiddleware = function (request, response, next) {
    var d = domain.create();
    d.on('error', function (error) {
        console.error('WHAT', error);
        d.dispose();
        if (cluster.worker) {
            cluster.worker.disconnect();
        }
        response.send(500, {
            'error' : error
        });
    }.bind(this));
    response.on('close',  d.dispose.bind(d));
    response.on('finish', d.dispose.bind(d));
    d.add(request);
    d.add(response);
    return d.run(next);
};
Worker.prototype.errorMiddleware = function (error, request, response, next) {
    console.log('Error Middleware');
    if (domain.active) {
        domain.active.emit('error', error);
    } else {
        return next(error);
    }
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
    console.log('Worker Error', arguments);
    this.exit();
};
Worker.prototype.exit = function workerExit () {
    console.log('Worker Exiting');
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
    console.log('Worker SIGINT', arguments);
    if (!cluster.worker) {
        this.exit();
    }
};
Worker.prototype.sigtermHandler = function workerSIGTERM () {
    console.log('Worker SIGTERM', arguments);
    this.exit();
};
module.exports = function setupWorker (config, callback) {
    return new Worker(config, callback);
};
