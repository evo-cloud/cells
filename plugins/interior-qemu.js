var Class = require('js-class'),
    flow  = require('js-flow'),
    path  = require('path'),
    fs    = require('fs'),
    exec  = require('child_process').exec,
    spawn = require('child_process').spawn,
    sh    = require('../lib/ShellExec').sh;

var Qemu = Class({
    constructor: function (node, executable, params, monitor, logger) {
        this._node    = node;
        this._logger  = logger;
        this._monitor = monitor;

        if (!node.image) {
            throw new Error('Image is required');
        }

        var mount = node.image.findMount('qemu');
        mount || (mount = node.image.findMount('vmdk'));
        this._baseImage = mount && mount.mountpoint && mount.mountpoint.path;
        this._baseImage || (this._baseImage = mount && mount.format.file);
        this._baseImage || (this._baseImage = node.image.manifest.file);
        if (!this._baseImage) {
            throw new Error('Image not supported');
        }
        this._baseImage = path.resolve(node.image.basedir, this._baseImage);

        this._cmd = executable;

        var memory = params.memory || node.image.manifest.memory;
        memory && (this._cmd += ' -m ' + memory);

        this._cmd += ' -display none';

        this._nics = [];
        Array.isArray(params.nics) && params.nics.forEach(function (nic) {
            var connectivity = typeof(nic) == 'string' ? { network: nic } : nic;
            var network = node.network(connectivity.network);
            if (!network) {
                throw new Error('Network not found: ' + connectivity.network);
            }
            if (!network.adapter.device) {
                throw new Error('Interface unknown for network: ' + network.name);
            }
            var info = {
                network: network,
                bridge: network.adapter.device.name
            };

            if (!isNaN(nic['address-index'])) {
                var address = network.addressAt(nic['address-index']);
                if (!address) {
                    throw new Error('Network address invalid: ' + nic['address-index'] + ' in ' + network.name);
                } else {
                    info.mac = address.mac;
                }
            }
            var index = this._nics.length;
            info.script = path.join(node.workdir, 'ifup' + index + '.sh');
            info.params = '-netdev tap,id=nic' + index + ',script=' + info.script + ' -device ' + (nic['device'] || 'e1000');
            info.mac && (info.params += ',mac=' + info.mac);
            nic['pxe'] || (info.params += ',romfile=');
            info.params += ',netdev=nic' + index;

            this._nics.push(info);

            this._cmd += ' ' + info.params;
        }, this);

        this._disk = path.join(node.workdir, 'system' + path.extname(this._baseImage));
        this._cmd += ' -drive file=' + this._disk + ',media=disk,cache=unsafe,aio=native';

        var conf = node.image.manifest.qemu;
        conf && conf.params && (this._cmd += ' ' + conf.params);

        params.qemu && params.qemu.params && (this._cmd += ' ' + params.qemu.params);
    },

    get id () {
        return this._node.id;
    },

    load: function (opts, callback) {
        flow.steps()
            .chain()
            .next(flow.each(this._nics)
                      .do(function (nic, next) {
                            flow.steps()
                                .next(function (next) {
                                    fs.writeFile(nic.script, [
                                        '#!/bin/sh',
                                        'ifconfig $1 up',
                                        'brctl addif ' + nic.bridge + ' $1'
                                    ].join("\n"), next);
                                })
                                .next(function (next) {
                                    fs.chmod(nic.script, '0755', next);
                                })
                                .run(next);
                      })
            )
            .next(function (next) {
                sh(this._logger, 'qemu-img info ' + this._baseImage, next);
            })
            .next(function (stdout, stderr, next) {
                var format;
                if ((stdout || '').split("\n").some(function (line) {
                        var m = line.match(/^file format:\s+([^\s]+)/);
                        m && m[1] && (format = m[1]);
                        return !!format;
                    })) {
                    sh(this._logger, 'qemu-img create -f ' + format + ' -b ' + this._baseImage + ' ' + this._disk, next);
                } else {
                    next(new Error('Unknown base image format'));
                }
            })
            .with(this)
            .run(function (err) {
                callback(err);
            });
    },

    unload: function (opts, callback) {
        fs.unlink(this._disk, callback);
    },

    start: function (opts, callback) {
        this._logger.debug('QEMU spawn: ' + this._cmd);
        this._proc = spawn(process.env.SHELL || '/bin/sh', ['-c', this._cmd], {
                cwd: this._node.workdir,
                stdio: ['ignore', 'ignore', 'ignore']
            });
        this._proc
            .on('error', function (err) {
                this._logger.logError(err, {
                    message: 'QEMU error: ' + err.message
                });
                this._cleanup('stopped');
            }.bind(this))
            .on('exit', function (code, signal) {
                this._logger.debug('QEMU exit: ' + (code == null ? 'killed ' + signal : code));
                this._proc.removeAllListeners();
                delete this._proc;
                this._cleanup('stopped');
            }.bind(this));
        callback();
    },

    stop: function (opts, callback) {
        this._cleanup('stopped', callback);
    },

    dump: function () {
        return {
            pid: this._proc ? this._proc.pid : undefined
        };
    },

    _cleanup: function (state, done) {
        var complete = function () {
            delete this._proc;
            state != null && this._monitor('state', state);
            done && done();
        }.bind(this);
        if (this._proc) {
            this._logger.debug('QEMU terminate: ' + this.lxcName);
            this._proc.removeAllListeners();
            this._proc.kill('SIGTERM');
            done ? this._proc.on('exit', complete) : complete();
        } else {
            complete();
        }
    }
});


module.exports = function (data, node, info, callback) {
    var qemu = data.params['qemu'];
    var executable = qemu && qemu.bin;
    executable || (executable = data.params['arch'] ? 'qemu-system-' + data.params['arch'] : 'kvm');
    flow.each([executable + ' -version'])
        .do(exec)
        .run(function (err) {
            var interior;
            if (!err) {
                try {
                    interior = new Qemu(node, executable, data.params, data.monitor, data.logger);
                } catch (e) {
                    err = e;
                }
            }
            callback(err, interior);
        });
};
