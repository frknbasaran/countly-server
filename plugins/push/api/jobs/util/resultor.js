const { FRAME, FRAME_NAME } = require('../../send/proto'),
    { DoFinish } = require('./do_finish'),
    { ERROR, TriggerKind, State, Status, PushError, Result } = require('../../send/data');
/**
 * @typedef {import("mongodb").ObjectId} ObjectId
 */

/**
 * PushStat object (collection: push_stats)
 * @typedef  {Object}    PushStat
 * @property {ObjectId}  a - application id
 * @property {ObjectId}  m - message id from "messages" collection
 * @property {string}    u - uid from app_users{appId}
 * @property {string}    t - token from "push_{appId}" collection
 * @property {string=}   r - id returned from provider
 * @property {Date}      d - date this message sent to this user
 * @property {string=}   e - error message
 * @property {string}    p - platform: "a" for android, "i" for ios and "h" for huawei
 * @property {string}    f - token type: "p" for production
 */

/**
 * Stream responsible for handling sending results:
 * - buffer incoming results
 * - write them to db once in a while
 */
class Resultor extends DoFinish {
    /**
     * Constructor
     *
     * @param {Log} log logger
     * @param {MongoClient} db mongo client
     * @param {object} data map of {_id: {a, m, u, t, f}} (app id, uid, token, field) of the messages currently being sent
     * @param {function} check function which returns boolean in case no more data is expected and the stream can be closed
     */
    constructor(log, db, data, check) {
        super({objectMode: true});
        this.log = log.sub('resultor');
        this.data = data;
        this.db = db;
        this.limit = data.cfg.pool.pushes;
        this.check = check;

        // temporary storage to decrease number of database updates
        this.changed = {}; // {aid: {field: {uid: new token}}}
        this.processed = {}; // {mid: int}
        this.sentUsers = {}; // {aid: {mid: {users: [uid, uid, uid], 'a': 0, 'i': 2132}}}
        this.removeTokens = {}; // {aid: {field: [uid, uid, uid]}}
        this.errors = {}; // {mid: {platform: {InvalidToken: 0}}}
        this.noMessage = {}; // {mid: Result}
        this.fatalErrors = {}; // {mid: []}
        this.toDelete = []; // [push id, push id, ...]
        this.count = 0; // number of results cached
        this.last = null; // time of last data from

        /** @type {PushStat[]} */
        this.pushStats = [];

        this.data.on('app', app => {
            this.changed[app._id] = {};
            this.removeTokens[app._id] = {};
            this.sentUsers[app._id] = {};

            let { PLATFORM } = require('../../send/platforms');
            for (let p in PLATFORM) {
                Object.values(PLATFORM[p].FIELDS).forEach(f => {
                    this.changed[app._id][p + f] = {};
                    this.removeTokens[app._id][p + f] = [];
                });
            }
        });

        this.data.on('message', message => {
            this.log.d('Received message %j', message.json);
            this.processed[message._id] = 0;
            this.fatalErrors[message._id] = [];
            this.sentUsers[message.app][message._id] = {users: []};
            message.platforms.forEach(p => {
                this.sentUsers[message.app][message._id][p] = 0;
            });

            this.errors[message._id] = {};
            let { PLATFORM } = require('../../send/platforms');
            for (let p in PLATFORM) {
                this.errors[message._id][p] = {};
            }
        });
    }

    /**
     * Flush results once in a while to ensure timeout won't result in full resend
     */
    ping() {
        if (this.count) {
            this.do_flush();
        }
    }

    /**
     * Transform's transform impementation
     *
     * @param {object[]} chunk array of results [push id|[push id, new token]]
     * @param {string} encoding ignored
     * @param {function} callback callback
     */
    _transform(chunk, encoding, callback) {
        let {frame, payload: results} = chunk,
            { PLATFORM } = require('../../send/platforms');
        this.log.d('in resultor _transform', FRAME_NAME[frame]);
        if (frame & FRAME.CMD) {
            if (frame & FRAME.END) {
                this.do_flush(() => {
                    this.log.d('DONE');
                    callback();
                    this.destroy();
                });
            }
            else {
                callback(new PushError('Wrong CMD in resultor', ERROR.EXCEPTION));
            }
            return;
        }
        else if (frame & FRAME.RESULTS) {
            if (frame & FRAME.ERROR) {
                this.log.d('Error results %d %s %s %s affected %d %j left %d %j', results.type, results.name, results.message, results.date, results.affectedBytes, results.affected, results.leftBytes, results.left);
                [results.affected, results.left].forEach(arr => {
                    if (results.is(ERROR.DATA_TOKEN_EXPIRED) || results.is(ERROR.DATA_TOKEN_INVALID)) {
                        arr.forEach(id => {
                            if (id < 0) {
                                return;
                            }
                            let {a, p, f, u} = this.data.pushes[id];
                            this.removeTokens[a][p + f].push(u);
                        });
                    }
                    arr.forEach(id => {
                        this.log.d('Error %d %s for %s', results.type, results.name, id);
                        if (id < 0) {
                            return;
                        }
                        const p = this.data.pushes[id];
                        let {p: platform, m, pr} = p,
                            msg = this.data.message(m),
                            result,
                            rp, rl;

                        // additional fields to keep this in push_stats
                        if (msg && msg.saveStats) {
                            this.pushStats.push({ a: p.a, m: p.m, p: p.p, f: p.f, u: p.u, t: p.t, d: new Date, r: null, e: results.toString() });
                        }

                        if (msg) {
                            result = msg.result;
                            result.lastRun.processed++;
                            result.lastRun.errored++;
                        }
                        else {
                            result = this.noMessage[m] || (this.noMessage[m] = new Result());
                        }
                        rp = result.sub(platform, undefined, PLATFORM[platform].parent);
                        rl = rp.sub(pr.la || 'default');

                        result.processed++;
                        result.recordError(results.message, 1);
                        rp.recordError(results.message, 1);
                        rp.processed++;
                        rl.recordError(results.message, 1);
                        rl.processed++;

                        if (PLATFORM[platform].parent) {
                            rp = result.sub(PLATFORM[platform].parent),
                            rl = rp.sub(pr.la || 'default');
                            rp.recordError(results.message, 1);
                            rp.processed++;
                            rl.recordError(results.message, 1);
                            rl.processed++;
                        }

                        delete this.data.pushes[id];
                        this.toDelete.push(id);
                        this.data.decSending(m);
                    });
                    this.count += arr.length;
                });
            }
            else {
                results.forEach(res => {
                    let id, resultId, token;

                    if (Array.isArray(res)) {
                        this.log.d('New token for %s', id);
                        id = res[0];
                        token = res[1];
                    }
                    else {
                        id = res;
                    }

                    if (typeof id !== "string") {
                        resultId = id.r;
                        id = id.p;
                    }

                    let p = this.data.pushes[id];
                    if (!p) { // 2 or more resultors on one pool
                        return;
                    }

                    let msg = this.data.message(p.m),
                        result, rp, rl;

                    // additional fields to keep this in push_stats
                    if (msg && msg.saveStats) {
                        this.pushStats.push({ a: p.a, m: p.m, p: p.p, f: p.f, u: p.u, t: p.t, d: new Date, r: resultId, e: null });
                    }

                    this.data.decSending(p.m);

                    if (msg) {
                        result = msg.result;
                        result.lastRun.processed++;
                    }
                    else {
                        result = this.noMessage[p.m] || (this.noMessage[p.m] = new Result());
                    }
                    rp = result.sub(p.p, undefined, PLATFORM[p.p].parent);
                    rl = rp.sub(p.pr.la || 'default');

                    result.sent++;
                    result.processed++;

                    rp.sent++;
                    rp.processed++;
                    rl.sent++;
                    rl.processed++;

                    if (PLATFORM[p.p].parent) {
                        rp = result.sub(PLATFORM[p.p].parent),
                        rl = rp.sub(p.pr.la || 'default');
                        rp.sent++;
                        rp.processed++;
                        rl.sent++;
                        rl.processed++;
                    }

                    this.toDelete.push(id);
                    delete this.data.pushes[id];

                    this.sentUsers[p.a][p.m].users.push(p.u);
                    this.sentUsers[p.a][p.m][p.p]++;
                    if (token) {
                        this.changed[p.a][p.p + p.f][p.u] = token;
                    }

                    this.count++;
                });
                this.log.d('Added %d results', results.length);
            }
        }
        else if (frame & FRAME.ERROR) {
            let error = results.messageError(),
                mids = {};

            this.log.d('Error %d %s %s %s affected %d %j left %d %j', results.type, results.name, results.message, results.date, results.affectedBytes, results.affected, results.leftBytes, results.left);

            [results.affected, results.left].forEach(arr => {
                arr.forEach(id => {
                    if (id < 0) {
                        return;
                    }
                    this.log.d('Error %d %s for %s', results.type, results.name, id);
                    const p = this.data.pushes[id];
                    let {m, p: platform, pr} = p,
                        result, rp, rl;
                    let msg = this.data.message(m);

                    // additional fields to keep this in push_stats
                    if (msg && msg.saveStats) {
                        this.pushStats.push({ a: p.a, m: p.m, p: p.p, f: p.f, u: p.u, t: p.t, d: new Date, r: null, e: results.toString() });
                    }

                    mids[m] = (mids[m] || 0) + 1;
                    delete this.data.pushes[id];
                    this.toDelete.push(id);

                    if (msg) {
                        result = msg.result;
                    }
                    else {
                        result = this.noMessage[m] || (this.noMessage[m] = new Result());
                    }

                    result.processed++;
                    result.recordError(results.message, 1);

                    rp = result.sub(platform, undefined, PLATFORM[platform].parent);
                    rl = rp.sub(pr.la || 'default');

                    rp.processed++;
                    rp.recordError(results.message, 1);
                    rl.processed++;
                    rl.recordError(results.message, 1);

                    if (PLATFORM[platform].parent) {
                        rp = result.sub(PLATFORM[platform].parent),
                        rl = rp.sub(pr.la || 'default');
                        rp.processed++;
                        rp.recordError(results.message, 1);
                        rl.processed++;
                        rl.recordError(results.message, 1);
                    }
                });

                this.count += arr.length;
            });

            for (let mid in mids) {
                let m = this.data.message(mid),
                    result;
                if (m) {
                    result = m.result;
                }
                else {
                    result = this.noMessage[mid] || (this.noMessage[mid] = new Result());
                }

                let run = result.lastRun;
                if (run) {
                    run.processed += mids[mid];
                    run.errored += mids[mid];
                }

                result.pushError(error);
                this.data.decSending(mid, mids[mid]);
            }
        }

        if (this.flushed || this.count > this.limit) {
            this.do_flush(callback);
        }
        else {
            callback();
        }
    }

    /**
     * Actual flush function
     *
     * @param {function} callback callback
     */
    do_flush(callback) {
        this.log.d('in resultor do_flush');
        this.count = 0;

        let updates = {},
            promises = this.data.messages().map(m => {
                m.result.lastRun.ended = new Date();

                // if (await Message.hasPushRecords(m.id)) {
                if (this.data.isSending(m.id)) {
                    this.log.d('message %s is still in processing (%d out of %d)', m.id, m.result.processed, m.result.total);
                    return m.save();
                }
                this.log.d('message %s is done processing', m.id);
                let state, status, error;
                if (m.triggerAutoOrApi()) {
                    if (m.result.total === m.result.errored) {
                        state = State.Created | State.Error | State.Done;
                        status = Status.Stopped;
                        error = 'Failed to send all notifications';
                    }
                    else {
                        state = m.state & ~State.Streaming;
                        status = Status.Scheduled;
                    }
                }
                else if (m.triggerRescheduleable()) {
                    let resch = m.triggerRescheduleable();
                    if (m.result.total === m.result.errored) {
                        state = State.Created | State.Error | State.Done;
                        status = Status.Stopped;
                        error = 'Failed to send all notifications';
                    }
                    else if (m.result.total === m.result.processed) {
                        if (!resch.nextReference(resch.last)) { // TODO: this will probably result in skipping last reference if it's scheduled before last message in queue is sent
                            state = State.Created | State.Done;
                            status = Status.Sent;
                        }
                        else {
                            state = m.state & ~State.Streaming;
                            status = Status.Scheduled;
                        }
                    }
                    else { // shouldn't happen, but possible in some weird cases
                        state = m.state & ~State.Streaming;
                        status = Status.Scheduled;
                        // TODO: We're already scheduling the next message on jobs/schedule.js after creating push records.
                        // It shouldn't matter if all of the queue processed or not.
                        // m.schedule(this.log).then(() => {
                        //     this.log.i('Rescheduled %s from resultor', m.id);
                        // }, e => {
                        //     this.log.e('Rescheduling error for %s from resultor', m.id, e);
                        // });
                    }
                }
                else {
                    if (m.result.total === m.result.errored) {
                        state = State.Created | State.Error | State.Done;
                        status = Status.Failed;
                        error = 'Failed to send all notifications';
                    }
                    else if (m.result.total === m.result.processed) {
                        state = State.Created | State.Done;
                        status = Status.Sent;
                    }
                    else {
                        state = m.state & ~State.Streaming;
                        status = Status.Scheduled;
                    }
                }

                if (m.result.state !== state) {
                    this.log.d('saving message', m.id, m.result.json, 'state', state, 'status', status, 'error', error);
                    m.state = state;
                    m.status = status;
                    if (status === Status.Sent || status === Status.Failed) {
                        this.log.i('done sending message', m.id, state, status);
                        m.info.finished = new Date();
                    }
                    if (error) {
                        m.result.error = error;
                    }
                    return m.save();
                }
                else {
                    this.log.d('message %s is in processing (%d out of %d)', m.id, m.result.processed, m.result.total);
                    return m.save();
                }
            }).concat(Object.keys(this.noMessage).map(mid => {
                this.log.e('Message %s doesn\'t exist, ignoring result %j', mid, this.noMessage[mid]);

                let count = this.noMessage[mid].processed;
                delete this.noMessage[mid];
                return this.db.collection('messages').updateOne({_id: this.db.ObjectID(mid)}, {$inc: {errored: count, processed: count, 'errors.NoMessage': count}});
            }));

        if (this.toDelete.length) {
            promises.push(this.db.collection('push').deleteMany({_id: {$in: this.toDelete.map(this.db.ObjectID)}}));
            this.toDelete = [];
        }

        // changed tokens - set new ones
        for (let aid in this.changed) {
            let collection = 'push_' + aid;
            if (!updates[collection]) {
                updates[collection] = [];
            }
            for (let field in this.changed[aid]) {
                for (let uid in this.changed[aid][field]) {
                    updates[collection].push({
                        updateOne: {
                            filter: {_id: uid},
                            update: {
                                $set: {
                                    ['tk.' + field]: this.changed[aid][field][uid]
                                }
                            }
                        }
                    });
                }
                this.changed[aid][field] = {};
            }
        }

        // expired tokens - unset
        for (let aid in this.removeTokens) {
            let collectionPush = `push_${aid}`,
                collectionAppUsers = `app_users${aid}`;
            if (!updates[collectionPush]) {
                updates[collectionPush] = [];
            }
            if (!updates[collectionAppUsers]) {
                updates[collectionAppUsers] = [];
            }
            for (let field in this.removeTokens[aid]) {
                if (this.removeTokens[aid][field].length) {
                    updates[collectionPush].push({
                        updateMany: {
                            filter: {_id: {$in: this.removeTokens[aid][field]}},
                            update: {
                                $unset: {
                                    ['tk.' + field]: 1
                                }
                            }
                        }
                    });
                    updates[collectionAppUsers].push({
                        updateMany: {
                            filter: {uid: {$in: this.removeTokens[aid][field]}},
                            update: {
                                $unset: {
                                    ['tk' + field]: 1
                                }
                            }
                        }
                    });
                    this.removeTokens[aid][field] = [];
                }
            }
        }

        let now = Date.now();
        for (let aid in this.sentUsers) {
            let collection = 'push_' + aid;
            if (!updates[collection]) {
                updates[collection] = [];
            }
            for (let mid in this.sentUsers[aid]) {
                if (this.sentUsers[aid][mid].users.length) {
                    updates[collection].push({
                        updateMany: {
                            filter: {_id: {$in: this.sentUsers[aid][mid].users}},
                            update: {
                                $addToSet: {
                                    ['msgs.' + mid]: now
                                }
                            }
                        }
                    });
                    this.sentUsers[aid][mid].users = [];
                }
                let m = this.data.message(mid),
                    app = this.data.app(aid),
                    common = require('../../../../../api/utils/common');
                m.platforms.forEach(p => {
                    let sent = this.sentUsers[aid][mid][p];
                    if (sent) {
                        let a = !!m.triggerAuto(),
                            t = !!m.triggerFind(TriggerKind.API),
                            ap = a + p,
                            tp = t + p,
                            params = {
                                qstring: {
                                    events: [
                                        { key: '[CLY]_push_sent', count: sent, segmentation: {i: mid, a, t, p, ap, tp} }
                                    ]
                                },
                                app_id: app._id,
                                appTimezone: app.timezone,
                                time: common.initTimeObj(app.timezone)
                            };

                        this.log.d('Recording %d [CLY]_push_sent\'s: %j', sent, params);
                        require('../../../../../api/parts/data/events').processEvents(params);
                        //plugins.dispatch("/plugins/drill", {params: params, dbAppUser: params.app_user, events: params.qstring.events});

                        try {
                            this.log.d('Recording %d data points', sent);
                            require('../../../../server-stats/api/parts/stats').updateDataPoints(common.writeBatcher, app._id, 0, {"p": sent});
                        }
                        catch (e) {
                            this.log.d('Error during dp recording', e);
                        }
                        this.sentUsers[aid][mid][p] = 0;
                    }
                });
            }
        }

        for (let c in updates) {
            if (updates[c].length) {
                this.log.d('Running batch of %d updates for %s', updates[c].length, c);
                promises.push(this.db.collection(c).bulkWrite(updates[c]));
            }
        }

        if (this.pushStats.length) {
            promises.push(this.db.collection("push_stats").insertMany(this.pushStats));
            this.pushStats = [];
        }

        Promise.all(promises).then(() => {
            this.log.d('do_flush done');
            callback();
        }, err => {
            this.log.e('do_flush error', err);
            callback(err);
        });
    }

    /**
     * Flush & release resources
     *
     * @param {function} callback callback function
     */
    do_final(callback) {
        callback();
    }
}

module.exports = { Resultor };