// Hermetic harness for extension.js.
//
// Loads a fresh copy of extension.js with `vscode`, `http`, `https` and `child_process` replaced by
// scriptable fakes, so tests never need a real VS Code, a real proxy on :8080, PM2 or Windows tools.
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const manifest = require('../../package.json');

const EXTENSION_PATH = path.join(__dirname, '..', '..', 'extension.js');

// Captured before any test replaces the globals
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
const realSetImmediate = global.setImmediate;

class Memento {
    constructor(initial = {}) {
        this.map = new Map(Object.entries(initial));
    }
    get(key, defaultValue) {
        return this.map.has(key) ? this.map.get(key) : defaultValue;
    }
    update(key, value) {
        if (value === undefined) this.map.delete(key);
        else this.map.set(key, value);
        return Promise.resolve();
    }
}

// Let pending setImmediate callbacks (fake responses, fake exec callbacks) and their follow-ups run
async function settle(rounds = 25) {
    for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => realSetImmediate(resolve));
    }
}

async function waitFor(predicate, label = 'condition', timeoutMs = 2000) {
    const start = Date.now();
    while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
        await new Promise((resolve) => realSetTimeout(resolve, 5));
    }
}

/**
 * Behaviours for a fake HTTP(S) request (per path, or a function of the request record):
 *   { status, body }            normal response (status defaults to 200)
 *   { status, body, abort }     headers and partial body arrive, then the connection drops
 *   'refuse' (default)          ECONNREFUSED
 *   'timeout'                   emits 'timeout' only - like Node, the caller must destroy the request
 *   'hold'                      nothing happens until the test calls harness.release(record, behaviour)
 *   an Error                    emitted as the request's 'error'
 */
function createHarness({
    platform = 'linux',
    globalState = {},
    workspaceState = {},
    config = {},
    http = {},
    https = {},
    exec = () => null,      // (command) => stdout string; null or an Error makes the command fail
    pick,                   // (items, options) => the quick pick item to select
    fastTimers = false      // shrink setTimeout waits longer than 50 ms to 1 ms
} = {}) {
    const state = {
        statusBarItems: [],
        messages: [],
        quickPicks: [],
        commands: new Map(),
        requests: [],
        execs: [],
        intervals: [],
        listeners: { windowState: [], authSessions: [] },
        opened: [],
        logs: [],
        unhandledRejections: [],
        config: { ...config },
        routes: { http, https },
        exec,
        pick
    };

    // ---------- fake vscode ----------
    const disposable = () => ({ dispose() { } });
    const vscode = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        QuickPickItemKind: { Separator: -1, Default: 0 },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        Uri: { parse: (value) => ({ value, toString: () => value }) },
        window: {
            createStatusBarItem(alignment, priority) {
                const item = {
                    alignment, priority, text: '', tooltip: '', command: undefined, backgroundColor: undefined,
                    disposed: false, show() { }, hide() { }, dispose() { this.disposed = true; }
                };
                state.statusBarItems.push(item);
                return item;
            },
            async showQuickPick(items, options) {
                state.quickPicks.push({ items, options });
                return state.pick ? state.pick(items, options) : undefined;
            },
            showInformationMessage: async (message) => { state.messages.push(['info', message]); },
            showWarningMessage: async (message) => { state.messages.push(['warning', message]); },
            showErrorMessage: async (message) => { state.messages.push(['error', message]); },
            onDidChangeWindowState(listener) { state.listeners.windowState.push(listener); return disposable(); }
        },
        commands: {
            registerCommand(id, handler) { state.commands.set(id, handler); return disposable(); }
        },
        env: { openExternal: async (uri) => { state.opened.push(uri); return true; } },
        authentication: {
            onDidChangeSessions(listener) { state.listeners.authSessions.push(listener); return disposable(); }
        },
        workspace: {
            name: 'test-workspace',
            getConfiguration: (section) => ({
                get: (key, defaultValue) => {
                    const full = section ? `${section}.${key}` : key;
                    return full in state.config ? state.config[full] : defaultValue;
                }
            })
        }
    };

    // ---------- fake http / https ----------
    function respond(record, behaviour) {
        if (record.finished) return;
        const { req } = record;
        if (behaviour === undefined || behaviour === null) behaviour = 'refuse';
        if (behaviour === 'hold') { record.held = true; return; }
        record.held = false;
        if (behaviour === 'timeout') {
            req.emit('timeout');
            return;
        }
        if (behaviour === 'refuse' || behaviour instanceof Error) {
            record.finished = true;
            const error = behaviour instanceof Error
                ? behaviour
                : Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${record.port}`), { code: 'ECONNREFUSED' });
            req.emit('error', error);
            req.emit('close');
            return;
        }

        const { status = 200, body = '', abort = false } = behaviour;
        const res = new EventEmitter();
        res.statusCode = status;
        res.complete = false;
        res.resume = () => { record.resumed = true; return res; };
        res.setEncoding = () => res;
        record.finished = true;
        record.res = res;
        if (record.onResponse) record.onResponse(res);
        if (body) res.emit('data', body);
        if (abort) {
            // Node: no 'end', no request 'error'; the response only emits 'error' when someone listens for it
            res.aborted = true;
            res.emit('aborted');
            if (res.listenerCount('error') > 0) {
                res.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
            }
        } else {
            res.complete = true;
            res.emit('end');
        }
        res.emit('close');
        req.emit('close');
    }

    function requestFactory(kind) {
        return function request(options, onResponse) {
            const req = new EventEmitter();
            const record = {
                kind,
                method: options.method || 'GET',
                hostname: options.hostname,
                port: options.port,
                path: options.path,
                headers: { ...(options.headers || {}) },
                body: '',
                req,
                onResponse,
                hasTimeoutHandler: false,
                finished: false,
                destroyed: false,
                held: false
            };
            state.requests.push(record);
            req.write = (chunk) => { record.body += chunk; return true; };
            req.destroy = (error) => {
                if (record.finished) return req;
                record.finished = true;
                record.destroyed = true;
                realSetImmediate(() => {
                    req.emit('error', error || Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
                    req.emit('close');
                });
                return req;
            };
            req.end = (chunk) => {
                if (chunk) record.body += chunk;
                record.hasTimeoutHandler = req.listenerCount('timeout') > 0;
                realSetImmediate(() => {
                    const routes = state.routes[kind];
                    let behaviour = typeof routes === 'function' ? routes(record) : routes[record.path];
                    if (typeof behaviour === 'function') behaviour = behaviour(record);
                    respond(record, behaviour);
                });
                return req;
            };
            return req;
        };
    }

    // ---------- fake child_process ----------
    const childProcess = {
        exec(command, options, callback) {
            if (typeof options === 'function') { callback = options; options = {}; }
            state.execs.push({ command, options: options || {} });
            let result;
            try {
                result = state.exec(command, options || {});
            } catch (error) {
                result = error;
            }
            realSetImmediate(() => {
                if (!callback) return;
                if (result instanceof Error) callback(result, '', '');
                else if (result === undefined || result === null) callback(new Error(`Command failed: ${command}`), '', '');
                else callback(null, String(result), '');
            });
            return { pid: 0, kill() { } };
        }
    };

    // ---------- globals ----------
    const originalLog = console.log;
    console.log = (...args) => { state.logs.push(args.map(String).join(' ')); };

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });

    // Intervals never fire on their own; tests run them with tickIntervals()
    global.setInterval = (fn, ms, ...args) => {
        const handle = { fake: true, ms, cleared: false, run: () => fn(...args) };
        state.intervals.push(handle);
        return handle;
    };
    global.clearInterval = (handle) => {
        if (handle && handle.fake) { handle.cleared = true; return undefined; }
        return realClearInterval(handle);
    };
    if (fastTimers) {
        global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms > 50 ? 1 : ms, ...args);
    }

    const onUnhandledRejection = (reason) => {
        state.unhandledRejections.push(reason && reason.message ? reason.message : String(reason));
    };
    process.on('unhandledRejection', onUnhandledRejection);

    function restoreGlobals() {
        console.log = originalLog;
        Object.defineProperty(process, 'platform', platformDescriptor);
        global.setInterval = realSetInterval;
        global.clearInterval = realClearInterval;
        global.setTimeout = realSetTimeout;
        process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    // ---------- load a fresh extension.js against the fakes ----------
    const stubs = { vscode, http: { request: requestFactory('http') }, https: { request: requestFactory('https') }, child_process: childProcess };
    let ext;
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === EXTENSION_PATH && Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[EXTENSION_PATH];   // module-level state must not leak between tests
        ext = require(EXTENSION_PATH);
    } catch (error) {
        restoreGlobals();
        throw error;
    } finally {
        Module._load = originalLoad;
    }

    const context = {
        subscriptions: [],
        globalState: globalState instanceof Memento ? globalState : new Memento(globalState),
        workspaceState: workspaceState instanceof Memento ? workspaceState : new Memento(workspaceState),
        extension: { packageJSON: manifest }
    };

    let disposed = false;
    const harness = {
        ext,
        context,
        state,
        vscode,
        settle,
        waitFor,
        get quotaItem() { return state.statusBarItems.find((i) => i.command === 'antigravity.showQuotaInfo'); },
        get modelItem() { return state.statusBarItems.find((i) => i.command === 'antigravity.switchModel'); },
        get activeIntervals() { return state.intervals.filter((i) => !i.cleared); },
        activate() { ext.activate(context); return harness; },
        command(id) { return state.commands.get(id)(); },
        requests(kind, requestPath) {
            return state.requests.filter((r) => (!kind || r.kind === kind) && (!requestPath || r.path === requestPath));
        },
        execs(prefix = '') { return state.execs.filter((e) => e.command.startsWith(prefix)); },
        messages(level) { return state.messages.filter(([l]) => !level || l === level).map(([, message]) => message); },
        tickIntervals(ms) {
            for (const interval of state.intervals) {
                if (!interval.cleared && (ms === undefined || interval.ms === ms)) interval.run();
            }
        },
        fireWindowState(focused = true) { for (const listener of state.listeners.windowState) listener({ focused }); },
        fireAuthChange() { for (const listener of state.listeners.authSessions) listener({}); },
        release(record, behaviour) { respond(record, behaviour); },
        // Deactivate like VS Code does: deactivate() first, then every subscription
        shutdown() {
            ext.deactivate();
            for (const subscription of context.subscriptions) subscription.dispose();
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            try {
                harness.shutdown();
                await settle();     // let in-flight fake callbacks finish while output is still captured
            } finally {
                restoreGlobals();
            }
        }
    };
    return harness;
}

// Run `fn` with a harness and always clean up, even when an assertion throws
async function withHarness(options, fn) {
    const harness = createHarness(options);
    try {
        return await fn(harness);
    } finally {
        await harness.dispose();
    }
}

module.exports = { createHarness, withHarness, Memento, settle, waitFor, manifest };
