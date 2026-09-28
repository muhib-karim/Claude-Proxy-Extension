// Activation smoke tests: load extension.js against a minimal fake `vscode` module and a fake
// proxy HTTP server on localhost:8080 (the port the extension talks to).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const manifest = require('../package.json');

const PROXY_PORT = 8080;

class Memento {
    constructor(initial = {}) {
        this.map = new Map(Object.entries(initial));
    }
    get(key, defaultValue) {
        return this.map.has(key) ? this.map.get(key) : defaultValue;
    }
    update(key, value) {
        this.map.set(key, value);
        return Promise.resolve();
    }
}

function createFakeVscode() {
    const disposable = () => ({ dispose() { } });
    const fake = {
        commands: new Map(),
        statusBarItems: [],
        messages: [],
        quickPicks: [],
        quickPickHandler: () => undefined,
        config: {},
    };
    fake.api = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        QuickPickItemKind: { Separator: -1, Default: 0 },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        Uri: { parse: (value) => ({ value, toString: () => value }) },
        window: {
            createStatusBarItem(alignment, priority) {
                const item = { alignment, priority, text: '', tooltip: '', show() { }, dispose() { } };
                fake.statusBarItems.push(item);
                return item;
            },
            async showQuickPick(items, options) {
                fake.quickPicks.push({ items, options });
                return fake.quickPickHandler(items, options);
            },
            showInformationMessage: async (msg) => { fake.messages.push(['info', msg]); },
            showWarningMessage: async (msg) => { fake.messages.push(['warning', msg]); },
            showErrorMessage: async (msg) => { fake.messages.push(['error', msg]); },
            onDidChangeWindowState: disposable,
        },
        commands: {
            registerCommand(id, fn) {
                fake.commands.set(id, fn);
                return disposable();
            },
        },
        env: { openExternal: async () => true },
        authentication: { onDidChangeSessions: disposable },
        workspace: {
            name: 'test-workspace',
            getConfiguration: () => ({ get: (key, defaultValue) => (key in fake.config ? fake.config[key] : defaultValue) }),
        },
    };
    return fake;
}

// Load a fresh copy of extension.js (module-level state is reset) wired to the fake vscode API
function loadExtension(fakeApi) {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return fakeApi;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const extensionPath = require.resolve('../extension.js');
        delete require.cache[extensionPath];
        return require(extensionPath);
    } finally {
        Module._load = originalLoad;
    }
}

function createContext({ globalState = {}, workspaceState = {} } = {}) {
    return {
        subscriptions: [],
        globalState: new Memento(globalState),
        workspaceState: new Memento(workspaceState),
        extension: { packageJSON: manifest },
    };
}

// Track setInterval/clearInterval so tests can prove deactivation stops every timer
function trackIntervals() {
    const active = new Set();
    const originalSet = global.setInterval;
    const originalClear = global.clearInterval;
    global.setInterval = (...args) => {
        const handle = originalSet(...args);
        active.add(handle);
        return handle;
    };
    global.clearInterval = (handle) => {
        active.delete(handle);
        return originalClear(handle);
    };
    return {
        active,
        restore() {
            for (const handle of active) originalClear(handle);
            global.setInterval = originalSet;
            global.clearInterval = originalClear;
        },
    };
}

function shutdown(ext, context) {
    for (const sub of context.subscriptions) sub.dispose();
    ext.deactivate();
}

async function waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

const ACCOUNT_LIMITS = {
    totalAccounts: 2,
    accounts: [
        {
            email: 'alpha@example.com',
            status: 'ok',
            limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.2 },
                'gemini-3-flash': { remainingFraction: 0.9 },
            },
        },
        {
            email: 'beta@example.com',
            status: 'ok',
            limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.8 },
                'gemini-3-flash': { remainingFraction: 0.5 },
            },
        },
    ],
};

function startFakeProxy() {
    return new Promise((resolve, reject) => {
        const state = { requests: [], sessionModelStatus: 200 };
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                state.requests.push({ method: req.method, url: req.url, body });
                res.setHeader('Content-Type', 'application/json');
                if (req.url === '/health') return res.end('{"status":"ok"}');
                if (req.url === '/active-model') return res.end(JSON.stringify({ model: 'gemini-3-flash' }));
                if (req.url === '/account-limits') return res.end(JSON.stringify(ACCOUNT_LIMITS));
                if (req.url === '/session-model' && req.method === 'POST') {
                    res.statusCode = state.sessionModelStatus;
                    return res.end(state.sessionModelStatus === 200 ? '{"ok":true}' : '{"error":"boom"}');
                }
                res.statusCode = 404;
                res.end('{}');
            });
        });
        server.once('error', reject);
        server.listen(PROXY_PORT, () => {
            state.close = () => new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
            });
            resolve(state);
        });
    });
}

test('activate registers every contributed command and deactivate clears all timers', async () => {
    const timers = trackIntervals();
    const fake = createFakeVscode();
    const ext = loadExtension(fake.api);
    const context = createContext();
    try {
        ext.activate(context);

        const contributed = manifest.contributes.commands.map((c) => c.command).sort();
        assert.deepEqual([...fake.commands.keys()].sort(), contributed);
        assert.equal(fake.statusBarItems.length, 2);
        assert.equal(timers.active.size, 2, 'proxy poll + account poll intervals');

        // Proxy is opt-in: disabled by default, so the model item shows the disabled state
        const modelItem = fake.statusBarItems.find((i) => i.command === 'antigravity.switchModel');
        await waitFor(() => modelItem.text === '$(debug-stop) Disabled');

        shutdown(ext, context);
        assert.equal(timers.active.size, 0, 'all intervals cleared after deactivate');
    } finally {
        timers.restore();
    }
});

test('window session id is stored per workspace, not globally', async () => {
    const timers = trackIntervals();
    try {
        const sharedGlobalState = {};
        const workspaceA = {};
        const ids = [];
        for (const workspaceState of [workspaceA, {}, workspaceA]) {
            const fake = createFakeVscode();
            const ext = loadExtension(fake.api);
            const context = createContext({ globalState: sharedGlobalState, workspaceState });
            ext.activate(context);
            const id = context.workspaceState.get('antigravity.windowId');
            assert.match(id, /^[0-9a-f-]{36}$/);
            assert.equal(context.globalState.get('antigravity.windowId'), undefined);
            Object.assign(workspaceState, Object.fromEntries(context.workspaceState.map));
            ids.push(id);
            shutdown(ext, context);
        }
        assert.notEqual(ids[0], ids[1], 'different windows get different ids');
        assert.equal(ids[0], ids[2], 'the same workspace keeps its id');
    } finally {
        timers.restore();
    }
});

test('talks to the proxy: shows model and quotas, switches model per window, toggles off', async (t) => {
    let proxy;
    try {
        proxy = await startFakeProxy();
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            t.skip(`port ${PROXY_PORT} is in use`);
            return;
        }
        throw err;
    }

    const timers = trackIntervals();
    const fake = createFakeVscode();
    const ext = loadExtension(fake.api);
    const context = createContext({ globalState: { 'antigravity.proxyEnabled': true } });
    try {
        ext.activate(context);
        const modelItem = fake.statusBarItems.find((i) => i.command === 'antigravity.switchModel');
        const quotaItem = fake.statusBarItems.find((i) => i.command === 'antigravity.showQuotaInfo');

        // First connect adopts the proxy's active model
        await waitFor(() => modelItem.text === '⚡ Flash');
        assert.equal(quotaItem.text, '$(account)');
        assert.ok(proxy.requests.some((r) => r.url === '/health'), 'auto-start check hits /health when enabled');

        // Quota popup: overall minimums and accounts sorted by Claude quota
        let items = [];
        await waitFor(async () => {
            await fake.commands.get('antigravity.showQuotaInfo')();
            items = fake.quickPicks.at(-1).items;
            return items.some((i) => i.label.startsWith('🟠 Claude'));
        });
        assert.ok(items.some((i) => i.label === '🟠 Claude: ▰▰▱▱▱▱▱▱▱▱ 20%'));
        assert.ok(items.some((i) => i.label === '💎 Gemini: ▰▰▰▰▰▱▱▱▱▱ 50%'));
        const accountLabels = items.filter((i) => i.label.startsWith('👤')).map((i) => i.label);
        assert.deepEqual(accountLabels, ['👤 beta', '👤 alpha']);

        // A failed switch is reported to the user and keeps the current model
        proxy.sessionModelStatus = 500;
        fake.quickPickHandler = (menu) => menu.find((i) => i.label === '🎵 Sonnet');
        await fake.commands.get('antigravity.switchModel')();
        assert.ok(fake.messages.some(([level, msg]) => level === 'error' && msg.startsWith('Failed to switch model')));
        assert.equal(modelItem.text, '⚡ Flash');

        // Successful switch posts this window's session id and persists the model per workspace
        proxy.sessionModelStatus = 200;
        fake.quickPickHandler = (menu) => {
            assert.equal(menu[0].label, '$(debug-stop) Disable Proxy');
            return menu.find((i) => i.label === '🎭 Opus');
        };
        await fake.commands.get('antigravity.switchModel')();
        const post = proxy.requests.filter((r) => r.url === '/session-model').at(-1);
        assert.deepEqual(JSON.parse(post.body), {
            model: 'claude-opus-4-5-thinking',
            sessionId: context.workspaceState.get('antigravity.windowId'),
            name: 'test-workspace',
        });
        assert.equal(context.workspaceState.get('antigravity.windowModel'), 'claude-opus-4-5-thinking');
        assert.equal(modelItem.text, '🎭 Opus');

        // Later polls must not override the window's own model with the proxy's global one
        const polls = proxy.requests.filter((r) => r.url === '/active-model').length;
        await waitFor(() => proxy.requests.filter((r) => r.url === '/active-model').length > polls, 8000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(modelItem.text, '🎭 Opus');

        // Disable toggle persists the flag and shows the disabled state
        fake.quickPickHandler = (menu) => menu[0];
        await fake.commands.get('antigravity.switchModel')();
        assert.equal(context.globalState.get('antigravity.proxyEnabled'), false);
        assert.equal(modelItem.text, '$(debug-stop) Disabled');
        assert.equal(quotaItem.tooltip, 'Proxy disabled');
    } finally {
        shutdown(ext, context);
        timers.restore();
        await proxy.close();
    }
});
