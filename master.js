var cluster = require('cluster');
var os      = require('os');
var logger  = require('node-console-enhance');
logger(console, 'Master');
function call () {
    var args     = Array.prototype.slice.apply(arguments);
    var callback = args.shift() || null;
    var context  = args.shift() || null;
    if (callback && typeof callback == 'function') {
        return callback.apply(context, args);
    }
}
module.exports = function setupCluster (config) {
    if (!config.exec) {
        throw new Error("Must define a worker 'exec' script");
    }
    cluster.on('setup', function () {
        console.log('Cluster Setup', arguments);
        return new Master(config);
    });
    var setup = {
        'exec' : config.exec,
        'args' : config.args
    };
    cluster.setupMaster(config);
};
function Master (config) {
    console.log('Started', process.pid);
    this.restarting = false;
    this.handlers = {
        'fork'       : this.forkHandler.bind(this),
        'online'     : this.onlineHandler.bind(this),
        'listening'  : this.listeningHandler.bind(this),
        'disconnect' : this.disconnectHandler.bind(this),
        'exit'       : this.exitHandler.bind(this)
    };
    this.handles = {
        'workers' : {},
        'reload'  : []
    };
    cluster.addListener('fork',       this.handlers.fork);
    cluster.addListener('online',     this.handlers.online);
    cluster.addListener('listening',  this.handlers.listening);
    cluster.addListener('disconnect', this.handlers.disconnect);
    cluster.addListener('exit',       this.handlers.exit);
    var length = os.cpus().length;
    while (length--) {
        this.fork();
    }
    process.on('SIGHUP',  this.restart.bind(this));
    process.on('SIGTERM', this.shutdown.bind(this));
}
Master.prototype.fork = function (callback) {
    var worker = cluster.fork();
    worker.on('listening', function () {
        console.log('Cluster Worker Listening', arguments);
        return call(callback, this);
    }.bind(this));
};
Master.prototype.forkHandler = function (worker) {
    console.log('Cluster Fork', worker.id);
    this.handles.workers[worker.id] = worker;
    worker.listenTimer = setTimeout(function () {
        console.error('Cluster timeout when establishing listener');
    }, 5 * 1000);
    worker.on('exit', function () {
        if (!worker.suicide) {
            console.log('Cluster Death, restarting', worker.id);
            this.fork();
        }
    }.bind(this));
};
Master.prototype.onlineHandler = function (worker) {
    console.log('Cluster Online', worker.id);
};
Master.prototype.listeningHandler = function (worker, address) {
    console.log('Cluster Listening', worker.id, address);
    if (worker.listenTimer) {
        clearTimeout(worker.listenTimer);
    }
};
Master.prototype.disconnectHandler = function (worker) {
    console.log('Cluster Disconnect', worker.id, worker.suicide);
};
Master.prototype.exitHandler = function (worker, code, signal) {
    console.log('Cluster Exit', worker.suicide, code, signal);
};
Master.prototype.restart = function () {
    console.log('Cluster Restart', this.restarting);
    if (!this.restarting) {
        this.restarting = true;
        this.each(function (worker) {
            this.handles.reload.push(worker.id);
        });
        this.reloadNextWorker(function () {
            console.log('Cluster Restart Finished');
            this.restarting = false;
        });
    }
};
Master.prototype.shutdown = function () {
    console.log('Cluster Shutdown');
    cluster.removeListener('exit', this.handlers.exit);
    this.each(function (worker) {
        return this.stopWorker(worker);
    });
};
Master.prototype.stopWorker = function (worker, callback) {
    if (this.handles.workers[worker.id]) {
        console.log('Cluster Worker Stop');
        var finish = function () {
            call(callback, this);
        }.bind(this);
        worker.timeout = setTimeout(finish, 10 * 1000);
        worker.on('exit', function () {
            if (worker.suicide) {
                console.log('Cluster Worker Stop caught', worker.id);
                if (worker.timeout) {
                    clearTimeout(worker.timeout);
                }
                finish();
            }
        }.bind(this));
        worker.disconnect();
        delete this.handles.workers[worker.id];
    } else {
        return call(callback, this);
    }
};
Master.prototype.reloadWorker = function (worker, callback) {
    console.log('Cluster Reload', worker.id);
    this.fork(function () {
        this.stopWorker(worker, function () {
            call(callback, this);
        });
    });
};
Master.prototype.reloadNextWorker = function (callback) {
    var workerID = this.handles.reload.shift();
    console.log('Cluster ReloadNextWorker', workerID);
    if (workerID) {
        var worker = this.handles.workers[workerID];
        return this.reloadWorker(worker, function () {
            this.reloadNextWorker(callback);
        });
    } else {
        return call(callback, this);
    }
};
Master.prototype.each = function (callback) {
    console.log('Cluster Each');
    for (var workerID in this.handles.workers) {
        call(callback, this, this.handles.workers[workerID]);
    }
};
