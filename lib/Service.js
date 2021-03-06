var Class  = require('js-class'),
    _      = require('underscore'),
    Errors = require('evo-elements').Errors,

    ManagementObject = require('./ManagementObject');

var Service = Class(ManagementObject, {
    constructor: function (network, id, props, options) {
        ManagementObject.prototype.constructor.call(this, 'service', id, props, options);
        this._network = network;
    },

    get network () {
        return this._network;
    },

    setup: function (callback) {
        if (!this.properties.role) {
            callback(Errors.noAttr('role'));
        } else {
            this.connectPlugin(
                'cells:network.service.' + this.properties.role,
                this.properties.name,
                function (err, svc) {
                    if (!err && svc) {
                        this._service = svc;
                        if (typeof(svc.update) == 'function') {
                            this.update = function () {
                                return svc.update.apply(svc, arguments);
                            };
                        }
                        svc.start(callback);
                    } else {
                        callback();
                    }
                }.bind(this)
            );
        }
    },

    dump: function () {
        return _.extend({
            role: this.properties.role,
            name: this.properties.name
        }, typeof(this._service.dump) == 'function' ? this._service.dump() : {});
    },

    _destruct: function (callback) {
        this._service.stop(function (err) {
            err && this.logger.logError(err, {
                level: 'warning',
                message: '[STOP.ERR] ' + err.message
            });
            callback();
        }.bind(this));
    }
});

module.exports = {
    exports: 'CRUD',

    refs: ['network'],

    create: function (id, props, refObjs, options, callback) {
        var service = new Service(refObjs.network[0], id, props, options);
        service.setup(function (err) {
            callback(err, service);
        });
    }
};
