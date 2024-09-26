const { ConnectionError, ERROR, SendError, PushError, FCM_SDK_ERRORS } = require('../data/error'),
    logger = require('../../../../../api/utils/log'),
    { Splitter } = require('./utils/splitter'),
    { util } = require('../std'),
    { Creds } = require('../data/creds'),
    { threadId } = require('worker_threads'),
    FORGE = require('node-forge'),
    firebaseAdmin = require("firebase-admin");

/**
 * Platform key
 */
const key = 'a';

/**
 * Virtual subplatforms. A virtual platform:
 *  - has its own token fields, is stored in db separately;
 *  - has its own compilation part;
 *  - has its own sending part;
 *  - has no distinct representation in UI, therefore it's virtual.
 *
 * Huawei push is only available on select Android devices, therefore it doesn't deserve a separate checkbox in UI from users perspective.
 * Yet notification payload, provider communication and a few other things are different, therefore it's a virtual platform. You can send to huawei directly using
 * API, but whenever you send to Android you'll also send to huawei if Huawei credentials are set.
 */
const virtuals = ['h'];

/**
 * Extract token & field from token_session request
 *
 * @param {object} qstring request params
 * @returns {string[]|undefined} array of [platform, field, token] if qstring has platform-specific token data, undefined otherwise
 */
function extractor(qstring) {
    if (qstring.android_token !== undefined && (!qstring.token_provider || qstring.token_provider === 'FCM')) {
        const token = qstring.android_token === 'BLACKLISTED' ? '' : qstring.android_token;
        return [key, FIELDS['0'], token, util.hashInt(token)];
    }
}

/**
 * Make an estimated guess about request platform
 *
 * @param {string} userAgent user-agent header
 * @returns {string} platform key if it looks like request made by this platform
 */
function guess(userAgent) {
    return userAgent.includes('Android') && key;
}

/**
 * Connection implementation for FCM
 */
class FCM extends Splitter {
    /**
     * Standard constructor
     * @param {string} log logger name
     * @param {string} type type of connection: ap, at, id, ia, ip, ht, hp
     * @param {Credentials} creds FCM server key
     * @param {Object[]} messages initial array of messages to send
     * @param {Object} options standard stream options
     * @param {number} options.pool.pushes number of notifications which can be processed concurrently, this parameter is strictly set to 500
     * @param {string} options.proxy.host proxy host
     * @param {string} options.proxy.port proxy port
     * @param {string} options.proxy.user proxy user
     * @param {string} options.proxy.pass proxy pass
     * @param {string} options.proxy.auth proxy require https correctness
     */
    constructor(log, type, creds, messages, options) {
        super(log, type, creds, messages, options);
        this.legacyApi = !creds._data.serviceAccountFile;

        this.log = logger(log).sub(`${threadId}-a`);
        if (this.legacyApi) {
            this.opts = {
                agent: this.agent,
                hostname: 'fcm.googleapis.com',
                port: 443,
                path: '/fcm/send',
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `key=${creds._data.key}`,
                },
            };
        }
        else {
            const serviceAccountJSON = FORGE.util.decode64(
                creds._data.serviceAccountFile.substring(creds._data.serviceAccountFile.indexOf(',') + 1)
            );
            const serviceAccountObject = JSON.parse(serviceAccountJSON);
            const appName = creds._data.hash; // using hash as the app name
            const firebaseApp = firebaseAdmin.apps.find(app => app.name === appName)
                ? firebaseAdmin.app(appName)
                : firebaseAdmin.initializeApp({
                    credential: firebaseAdmin.credential.cert(serviceAccountObject, this.agent),
                    httpAgent: this.agent
                }, appName);
            this.firebaseMessaging = firebaseApp.messaging();
        }

        this.log.i('Initialized');
    }

    /**
     * Compile & send messages
     *
     * @param {Object[]} data pushes to send, no more than 500 per function call as enforced by stream writableHighWaterMark
     * @param {integer} length number of bytes in data
     * @returns {Promise} sending promise
     */
    send(data, length) {
        // CONNECTION TEST data (push document)
        // [
        //     {
        //         _id: -0.4490833548652693,
        //         m: 'test',
        //         pr: {},
        //         t: '0.2124088209996502'
        //     }
        // ]
        // NORMAL data (push document)
        // [
        //     {
        //         _id: '663389a807613e6e79349392',
        //         a: '6600901a71159e99a3434253',
        //         m: '663389a949c58657a8e625b3',
        //         p: 'a',
        //         f: 'p',
        //         u: '1',
        //         t: 'dw_CueiXThqYI9owrQC0Pb:APA91bHanJn9RM-ZYnC-3wCMld5Nk3QaVJppS4HOKrpdV8kCXq7pjQlJjcd8_1xq9G6XaceZfrFPxbfehJ4YCEfMsfQVhZW1WKhnY3TbtO7HIQfYfbj35-sx_-BHAhQ5eSDuiCOZWUDP',
        //         pr: { la: 'en' },
        //         h: 'a535fbb5d4664c49'
        //     }
        // ]
        return this.with_retries(data, length, (pushes, bytes, attempt) => {
            this.log.d('%d-th attempt for %d bytes', attempt, bytes);
            const one = Math.ceil(bytes / pushes.length);
            let content = this.template(pushes[0].m).compile(pushes[0]);

            let printBody = false;
            const oks = [];
            const errors = {};
            /**
             * Get an error for given code & message, create it if it doesn't exist yet
             *
             * @param {number} code error code
             * @param {string} message error message
             * @returns {SendError} error instance
             */
            const errorObject = (code, message) => {
                let err = code + message;
                if (!(err in errors)) {
                    errors[err] = new SendError(message, code);
                }
                return errors[err];
            };
            if (!this.legacyApi) {
                // new fcm api doesn't allow objects or arrays inside "data" property
                if (content.data && typeof content.data === "object") {
                    for (let prop in content.data) {
                        switch (typeof content.data[prop]) {
                        case "object":
                            content.data[prop] = JSON.stringify(content.data[prop]);
                            break;
                        case "number":
                            content.data[prop] = String(content.data[prop]);
                            break;
                        }
                    }
                }

                const tokens = pushes.map(p => p.t);
                const messages = tokens.map(token => ({
                    token,
                    ...content,
                }));

                return this.firebaseMessaging
                    // EXAMPLE RESPONSE of sendEach
                    // {
                    //   "responses": [
                    //     {
                    //       "success": false,
                    //       "error": {
                    //         "code": "messaging/invalid-argument",
                    //         "message": "The registration token is not a valid FCM registration token"
                    //       }
                    //     }
                    //   ],
                    //   "successCount": 0,
                    //   "failureCount": 1
                    // }
                    .sendEach(messages)
                    .then(async result => {
                        const allPushIds = pushes.map(p => p._id);

                        if (!result.failureCount) {
                            this.send_results(allPushIds, bytes);
                            return;
                        }

                        // array of successfully sent push._id:
                        const sentSuccessfully = [];

                        // check for each message
                        for (let i = 0; i < result.responses.length; i++) {
                            const { success, error } = result.responses[i];
                            if (success) {
                                sentSuccessfully.push(allPushIds[i]);
                            }
                            else {
                                const sdkError = FCM_SDK_ERRORS[error.code];
                                // check if the sdk error is mapped to an internal error.
                                // set to default if its not.
                                let internalErrorCode = sdkError?.mapTo ?? ERROR.DATA_PROVIDER;
                                let internalErrorMessage = sdkError?.message ?? "Invalid error message";
                                errorObject(internalErrorCode, internalErrorMessage)
                                    .addAffected(pushes[i]._id, one);
                            }
                        }
                        // send results back:
                        for (let errorKey in errors) {
                            this.send_push_error(errors[errorKey]);
                        }
                        if (sentSuccessfully.length) {
                            this.send_results(sentSuccessfully, one * sentSuccessfully.length);
                        }
                    });
            }

            content.registration_ids = pushes.map(p => p.t);

            // CONNECTION TEST PAYLOAD (invalid registration token)
            // {
            //     "data": {
            //         "c.i": "663389aab53ebbf71a115edb",
            //         "message": "test"
            //     },
            //     "registration_ids": [
            //         "0.2124088209996502"
            //     ]
            // }
            // NORMAL PAYLOAD
            // {
            //     "data": {
            //         "c.i": "663389a949c58657a8e625b3",
            //         "title": "qwer",
            //         "message": "qwer",
            //         "sound": "default"
            //     },
            //     "registration_ids": [
            //         "dw_CueiXThqYI9owrQC0Pb:APA91bHanJn9RM-ZYnC-3wCMld5Nk3QaVJppS4HOKrpdV8kCXq7pjQlJjcd8_1xq9G6XaceZfrFPxbfehJ4YCEfMsfQVhZW1WKhnY3TbtO7HIQfYfbj35-sx_-BHAhQ5eSDuiCOZWUDP"
            //     ]
            // }
            return this.sendRequest(JSON.stringify(content)).then(resp => {
                // CONNECTION TEST RESPONSE (with error)
                // {
                //     "multicast_id": 2829871343601014000,
                //     "success": 0,
                //     "failure": 1,
                //     "canonical_ids": 0,
                //     "results": [
                //         {
                //             "error": "InvalidRegistration"
                //         }
                //     ]
                // }
                // NORMAL SUCCESSFUL RESPONSE
                // {
                //     "multicast_id": 5676989510572196000,
                //     "success": 1,
                //     "failure": 0,
                //     "canonical_ids": 0,
                //     "results": [
                //         {
                //             "message_id": "0:1714653611139550%68dc6e82f9fd7ecd"
                //         }
                //     ]
                // }
                try {
                    resp = JSON.parse(resp);
                }
                catch (error) {
                    this.log.e('Bad FCM response format: %j', resp, error);
                    throw PushError.deserialize(error, SendError);
                }

                if (resp.failure === 0 && resp.canonical_ids === 0) {
                    this.send_results(pushes.map(p => p._id), bytes);
                    return;
                }

                if (resp.results) {
                    resp.results.forEach((r, i) => {
                        if (r.message_id) {
                            if (r.registration_id) {
                                if (r.registration_id === 'BLACKLISTED') {
                                    errorObject(ERROR.DATA_TOKEN_INVALID, 'Blacklisted').addAffected(pushes[i]._id, one);
                                    printBody = true;
                                }
                                else {
                                    oks.push([pushes[i]._id, r.registration_id]);
                                }
                                // oks.push([pushes[i]._id, r.registration_id], one); ???
                            }
                            else {
                                oks.push(pushes[i]._id);
                            }
                        }
                        else if (r.error === 'NotRegistered') {
                            this.log.d('Token %s expired (%s)', pushes[i].t, r.error);
                            errorObject(ERROR.DATA_TOKEN_EXPIRED, r.error).addAffected(pushes[i]._id, one);
                        }
                        else if (r.error === 'InvalidRegistration' || r.error === 'MismatchSenderId' || r.error === 'InvalidPackageName') {
                            this.log.d('Token %s is invalid (%s)', pushes[i].t, r.error);
                            errorObject(ERROR.DATA_TOKEN_INVALID, r.error).addAffected(pushes[i]._id, one);
                        }
                        // these are identical to "else" block:
                        // else if (r.error === 'InvalidParameters') { // still hasn't figured out why this error is thrown, therefore not critical yet
                        //     printBody = true;
                        //     errorObject(ERROR.DATA_PROVIDER, r.error).addAffected(pushes[i]._id, one);
                        // }
                        // else if (r.error === 'MessageTooBig' || r.error === 'InvalidDataKey' || r.error === 'InvalidTtl') {
                        //     printBody = true;
                        //     errorObject(ERROR.DATA_PROVIDER, r.error).addAffected(pushes[i]._id, one);
                        // }
                        else {
                            printBody = true;
                            errorObject(ERROR.DATA_PROVIDER, r.error).addAffected(pushes[i]._id, one);
                        }
                    });
                    let errored = 0;
                    for (let k in errors) {
                        errored += errors[k].affectedBytes;
                        this.send_push_error(errors[k]);
                    }
                    if (oks.length) {
                        this.send_results(oks, bytes - errored);
                    }
                    if (printBody) {
                        this.log.e('Provider returned error %j for %j', resp, content);
                    }
                }
            }, ([code, error]) => {
                this.log.w('FCM error %d / %j', code, error);
                console.log("========== MAIN PROMISE ERROR");
                if (code === 0) {
                    if (error.message === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' ||
                        error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED' || error.code === 'EHOSTUNREACH' ||
                        error.code === 'EAI_AGAIN') {
                        this.log.w('FCM error %d / %j', bytes, pushes.map(p => p._id));
                        throw new ConnectionError(`FCM ${error.code}`, ERROR.CONNECTION_PROVIDER)
                            .setConnectionError(error.code, `${error.errno} ${error.code} ${error.syscall}`)
                            .addAffected(pushes.map(p => p._id), bytes);
                    }
                    let pe = PushError.deserialize(error, SendError);
                    pe.addAffected(pushes.map(p => p._id), bytes);
                    throw pe;
                }
                else if (code >= 500) {
                    throw new ConnectionError(`FCM Unavailable: ${code}`, ERROR.CONNECTION_PROVIDER).addAffected(pushes.map(p => p._id), bytes);
                }
                else if (code === 401) {
                    throw new ConnectionError(`FCM Unauthorized: ${code}`, ERROR.INVALID_CREDENTIALS).addAffected(pushes.map(p => p._id), bytes);
                }
                else if (code === 400) {
                    throw new ConnectionError(`FCM Bad message: ${code}`, ERROR.DATA_PROVIDER).addAffected(pushes.map(p => p._id), bytes);
                }
                else {
                    throw new ConnectionError(`FCM Bad response code: ${code}`, ERROR.EXCEPTION).addAffected(pushes.map(p => p._id), bytes);
                }
            });
        });
    }

}

/**
 * Create new empty payload for the note object given
 *
 * @param {Message} msg NMessageote object
 * @returns {object} empty payload object
 */
function empty(msg) {
    return {data: {'c.i': msg.id}};
}

/**
 * Finish data object after setting all the properties
 *
 * @param {object} data platform-specific data to finalize
 * @return {object} resulting object
 */
function finish(data) {
    if (!data.data.message && !data.data.sound) {
        data.data['c.s'] = 'true';
    }
    return data;
}

/**
 * Non-personalizable fields of Note which can be sent for Android
 * !NOTE! order matters!
 */
const fields = [
    'sound',
    'badge',
    'delayWhileIdle',
    'collapseKey',
    'url',
    'media',
];

/**
 * Mapping of Content properties to APN payload props
 */
const map = {
    /**
     * Sends sound
     * @param {Template} t template
     * @param {string} sound sound string
     */
    sound: function(t, sound) {
        if (sound) {
            t.result.data.sound = sound;
        }
    },

    /**
     * Sends badge
     * @param {Template} t template
     * @param {number} badge badge (0..N)
     */
    badge: function(t, badge) {
        t.result.data.badge = badge;
    },

    /**
     * Sends buttons
     * !NOTE! buttons & messagePerLocale are inter-dependent as buttons urls/titles are locale-specific
     *
     * @param {Template} t template
     * @param {number} buttons buttons (1..2)
     */
    buttons: function(t, buttons) {
        if (buttons) {
            t.result.data['c.b'] = buttons.map(b => ({t: b.title, l: b.url}));
        }
    },

    /**
     * Set title string
     *
     * @param {Template} t template
     * @param {String} title title string
     */
    title: function(t, title) {
        t.result.data.title = title;
    },

    /**
     * Set message string
     *
     * @param {Template} t template
     * @param {String} message message string
     */
    message: function(t, message) {
        t.result.data.message = message;
    },

    /**
     * Send collapse_key.
     *
     * @param {Template} template template
     * @param {boolean} ck collapseKey of the Content
     */
    collapseKey: function(template, ck) {
        if (ck) {
            template.collapse_key = ck;
        }
    },

    /**
     * Send timeToLive.
     *
     * @param {Template} template template
     * @param {boolean} ttl timeToLive of the Content
     */
    timeToLive: function(template, ttl) {
        if (ttl) {
            template.time_to_live = ttl;
        }
    },

    /**
     * Send notification-tap url
     *
     * @param {Template} template template
     * @param {string} url on-tap url
     */
    url: function(template, url) {
        template.result.data['c.l'] = url;
    },

    /**
     * Send media (picture, video, gif, etc) along with the message.
     * Sets mutable-content in order for iOS extension to be run.
     *
     * @param {Template} template template
     * @param {string} media attached media url
     */
    media: function(template, media) {
        template.result.data['c.m'] = media;
    },

    /**
     * Sends custom data along with the message
     *
     * @param {Template} template template
     * @param {Object} data data to be sent
     */
    data: function(template, data) {
        Object.assign(template.result.data, util.flattenObject(data));
    },

    /**
     * Sends user props along with the message
     *
     * @param {Template} template template
     * @param {[string]} extras extra user props to be sent
     * @param {Object} data personalization
     */
    extras: function(template, extras, data) {
        for (let i = 0; i < extras.length; i++) {
            let k = extras[i];
            if (data[k] !== null && data[k] !== undefined) {
                template.result.data['c.e.' + k] = data[k];
            }
        }
    },

    /**
     * Sends platform specific fields
     *
     * @param {Template} template template
     * @param {object} specific platform specific props to be sent
     */
    specific: function(template, specific) {
        if (specific) {
            if (specific.large_icon) {
                template.result.data['c.li'] = specific.large_icon;
            }
        }
    },
};

/**
 * Token types for FCM
 * A number comes from SDK, we need to map it into smth like tkip/tkid/tkia
 */
const FIELDS = {
    '0': 'p', // prod
};

/**
 * Token types for FCM
 * A number comes from SDK, we need to map it into smth like tkip/tkid/tkia
 */
const FIELDS_TITLES = {
    '0': 'FCM Token',
};

/**
 * Credential types for FCM
 */
const CREDS = {
    'fcm': class FCMCreds extends Creds {
        /**
         * Validation scheme of this class
         *
         * @returns {object} validateArgs scheme
         */
        static get scheme() {
            return Object.assign(super.scheme, {
                serviceAccountFile: { required: false, type: "String" },
                key: { required: false, type: 'String', 'min-length': 100},
                hash: { required: false, type: 'String' },
            });
        }

        /**
         * Check credentials for correctness, throw PushError otherwise
         *
         * @throws PushError in case the check fails
         * @returns {undefined}
         */
        validate() {
            let res = super.validate();
            if (res) {
                return res;
            }
            if (this._data.serviceAccountFile) {
                let {serviceAccountFile} = this._data;
                let mime = serviceAccountFile.indexOf(';base64,') === -1 ? null : serviceAccountFile.substring(0, serviceAccountFile.indexOf(';base64,'));
                if (mime !== "data:application/json") {
                    return ["Service account file needs to be valid json file with .json file extension"];
                }
                const serviceAccountJSON = FORGE.util.decode64(serviceAccountFile.substring(serviceAccountFile.indexOf(',') + 1));
                let serviceAccountObject;
                try {
                    serviceAccountObject = JSON.parse(serviceAccountJSON);
                }
                catch (error) {
                    return ["Service account file includes an invalid JSON data"];
                }
                if (typeof serviceAccountObject !== "object"
                    || Array.isArray(serviceAccountObject)
                    || serviceAccountObject === null
                    || !serviceAccountObject.project_id
                    || !serviceAccountObject.private_key
                    || !serviceAccountObject.client_email) {
                    return ["Service account json doesn't contain project_id, private_key and client_email"];
                }
                this._data.hash = FORGE.md.sha256.create().update(serviceAccountJSON).digest().toHex();
            }
            else if (this._data.key) {
                this._data.hash = FORGE.md.sha256.create().update(this._data.key).digest().toHex();
            }
            else {
                return ["Updating FCM credentials requires a service-account.json file"];
            }
        }

        /**
         * "View" json, that is some truncated/simplified version of credentials that is "ok" to display
         *
         * @returns {object} json without sensitive information
         */
        get view() {
            const fcmKey = this._data?.key
                ? `FCM server key "${this._data.key.substr(0, 10)} ... ${this._data.key.substr(this._data.key.length - 10)}"`
                : "";
            const serviceAccountFile = this._data?.serviceAccountFile
                ? "service-account.json"
                : "";
            return {
                _id: this._id,
                type: this._data?.type,
                key: fcmKey,
                serviceAccountFile,
                hash: this._data?.hash,
            };
        }
    },

};

module.exports = {
    key: 'a',
    virtuals,
    title: 'Android',
    extractor,
    guess,
    FIELDS,
    FIELDS_TITLES,
    CREDS,

    empty,
    finish,
    fields,
    map,
    connection: FCM,

};
