'use strict';

var _ = require('lodash');
var Async = require('async');
var Boom = require('boom');
var Fs = require('fs');
var Hoek = require('hoek');
var Path = require('path');

var _applyPoints = ['onRequest',
    'onPreAuth',
    'onPostAuth',
    'onPreHandler',
    'onPostHandler',
    'onPreResponse'];

var hasValidApplyPoint = function (policy) {

    return !policy.applyPoint || _applyPoints.indexOf(policy.applyPoint) !== -1;
};

var data = {
    names: [],
    setHandlers: {}
};

/* adding arrays, to hold the policies */
_applyPoints.forEach(function (applyPoint) {

    data[applyPoint] = {};
});

var runPolicies = function (policiesToRun, request, reply) {

    var checkPolicy = function (policy, next) {

        policy(request, reply, function (err, canContinue, message) {

            if (err) {
                // You can provide a custom hapi error object here
                return next(err);
            }
            if (canContinue) {
                return next(null, true);
            }
            return next(Boom.forbidden(message));
        });
    };

    // Use eachSeries to get quick fails and ordering
    Async.eachSeries(policiesToRun, checkPolicy, function (err) {

        if (!reply._replied) {
            if (err) {
                return reply(err);
            }

            reply.continue();
        }
    });
};

/* generate handlers, one handler for each application point */
var handlers = {};
_applyPoints.forEach(function (applyPoint) {

    handlers[applyPoint] = function (request, reply) {

        var applyPointPolicies = data[applyPoint];
        var routePolicies = Hoek.reach(request, 'route.settings.plugins.policies');
        if (!routePolicies) {
            return reply.continue();
        }

        var repliedWithError = false;
        var policiesToRun = routePolicies.reduce(function (tmpList, routePolicy) {

            // Already replied
            if (repliedWithError) {
                return;
            }

            if (typeof routePolicy === 'string') {

                // Look for missing policies.  Probably due to misspelling.
                if (data.names.indexOf(routePolicy) === -1) {
                    repliedWithError = true;
                    return reply(Boom.notImplemented('Missing policy: ' + routePolicy));
                }

                if (applyPointPolicies[routePolicy]) {
                    tmpList.push(applyPointPolicies[routePolicy]);
                }

            } else if (typeof routePolicy === 'function') {

                if (!hasValidApplyPoint(routePolicy)) {
                    repliedWithError = true;
                    return reply(Boom.badImplementation('Trying to use incorrect applyPoint for the dynamic policy: ' + routePolicy.applyPoint));
                }

                var effectiveApplyPoint = routePolicy.applyPoint || request.server.plugins.mrhorse.defaultApplyPoint;

                if (effectiveApplyPoint === applyPoint) {
                    tmpList.push(routePolicy);
                }
            } else {

                repliedWithError = true;
                return reply(Boom.badImplementation('Policy not specified by name or by function.'));
            }

            return tmpList;
        }, []);

        // Already replied
        if (repliedWithError) {
            return;
        }

        runPolicies(policiesToRun, request, reply);
    };
});

var loadPolicies = function (server, options, next) {

    var match = null;
    var re = /(.+)\.js$/;

    options.defaultApplyPoint = options.defaultApplyPoint || 'onPreHandler'; // default application point

    var policyFiles = Fs.readdirSync(options.policyDirectory);
    if (policyFiles.length === 0) {
        return next();
    }

    var addPolicy = function (filename, addPolicyNext) {

        // Only looking for .js files in the policies folder
        match = filename.match(re);
        if (match) {
            // Does this policy already exist
            if (data.names.indexOf(match[1]) !== -1) {
                server.log(['error'], 'Trying to add a duplicate policy: ' + match[1]);
                return addPolicyNext(new Error('Trying to add a duplicate policy: ' + match[1]));
            }

            data.names.push(match[1]);

            // Add this policy function to the data object
            var policy = require(Path.join(options.policyDirectory, filename));

            // Check if the apply point is correct
            if (!hasValidApplyPoint(policy)) {
                server.log(['error'], 'Trying to set incorrect applyPoint for the policy: ' + policy.applyPoint);
                return addPolicyNext(new Error('Trying to set incorrect applyPoint for the policy: ' + policy.applyPoint));
            }

            // going further, filling the policies vs application points list
            if (policy.applyPoint === undefined || policy.applyPoint) {
                var applyPoint = policy.applyPoint || options.defaultApplyPoint;

                server.log(['info'], 'Adding a new PRE policy called ' + match[1]);
                data[applyPoint][match[1]] = policy;

                // connect the handler if this is the first pre policy
                if (!data.setHandlers[applyPoint]) {
                    server.ext(applyPoint, handlers[applyPoint]);
                    data.setHandlers[applyPoint] = true;
                }
            }
        }

        addPolicyNext();
    };

    Async.eachSeries(policyFiles, addPolicy, function (err) {

        next(err);
    });
};

var reset = function reset () {

    data = {
        names: [],
        setHandlers: {}
    };

    /* adding arrays to hold the policies */
    _applyPoints.forEach(function (applyPoint) {

        data[applyPoint] = {};
    });
};

exports.register = function register (server, options, next) {

    options.defaultApplyPoint = options.defaultApplyPoint || 'onPreHandler'; // default application point

    Hoek.assert(_applyPoints.indexOf(options.defaultApplyPoint) !== -1, 'Specified invalid defaultApplyPoint: ' + options.defaultApplyPoint);

    server.expose('loadPolicies', loadPolicies);
    server.expose('data', data);
    server.expose('reset', reset);
    server.expose('defaultApplyPoint', options.defaultApplyPoint);

    if (options.policyDirectory !== undefined) {
        loadPolicies(server, options, function (err) {

            next(err);
        });
    }
    else {
        next();
    }
};

exports.register.attributes = {
    pkg: require('../package.json')
};
