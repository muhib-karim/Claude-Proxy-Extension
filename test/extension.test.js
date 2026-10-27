// Smoke test: load extension.js against a minimal fake `vscode` module and check that
// activate() wires up status bar items and every command declared in package.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const pkg = require('../package.json');

function makeFakeVscode(registered) {
    const statusItem = () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' });
    const disposable = { dispose() {} };
    return {
        StatusBarAlignment: { Left: 1, Right: 2 },
        QuickPickItemKind: { Separator: -1 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: class { appendMarkdown() {} },
        Uri: { parse: s => s },
        env: { openExternal() {} },
        workspace: { name: 'test' },
        authentication: { onDidChangeSessions: () => disposable },
        window: {
            createStatusBarItem: statusItem,
            onDidChangeWindowState: () => disposable,
            showQuickPick: async () => undefined,
            showInformationMessage() {},
            showWarningMessage() {},
            showErrorMessage() {}
        },
        commands: {
            registerCommand(id, fn) { registered.set(id, fn); return disposable; }
        }
    };
}

function memento(initial = {}) {
    const store = { ...initial };
    return { get: k => store[k], update: (k, v) => { store[k] = v; return Promise.resolve(); } };
}

test('activate registers all contributed commands and deactivate cleans up', () => {
    const registered = new Map();
    const fake = makeFakeVscode(registered);
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') return fake;
        return originalLoad.call(this, request, ...rest);
    };
    try {
        const ext = require('../extension.js');
        const context = {
            subscriptions: [],
            // proxy disabled (default) so activation never shells out to pm2
            globalState: memento(),
            workspaceState: memento(),
            extension: { packageJSON: pkg }
        };
        ext.activate(context);

        const declared = pkg.contributes.commands.map(c => c.command).sort();
        assert.deepEqual([...registered.keys()].sort(), declared);
        assert.ok(context.subscriptions.length > 0);
        // session id used for /session-model is generated per workspace, not shared globally
        assert.match(context.workspaceState.get('antigravity.windowId'), /^[0-9a-f-]{36}$/);
        assert.equal(context.globalState.get('antigravity.windowId'), undefined);

        for (const d of context.subscriptions) d.dispose();
        ext.deactivate();
    } finally {
        Module._load = originalLoad;
    }
});
