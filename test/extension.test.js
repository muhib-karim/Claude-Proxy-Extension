// Activation smoke tests: load extension.js against the hermetic harness (fake `vscode`, no real
// HTTP requests or child processes) and check what activate() wires up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withHarness, Memento, manifest } = require('./support/harness');

test('activate registers all contributed commands and deactivate cleans up', async () => {
    await withHarness({}, async (h) => {
        h.activate();

        const declared = manifest.contributes.commands.map((c) => c.command).sort();
        assert.deepEqual([...h.state.commands.keys()].sort(), declared);
        assert.equal(h.state.statusBarItems.length, 2);
        assert.ok(h.quotaItem, 'account/quota status bar item');
        assert.ok(h.modelItem, 'model status bar item');
        assert.ok(h.context.subscriptions.length > 0);
        assert.equal(h.activeIntervals.length, 2, 'proxy poll + account poll intervals');

        h.shutdown();
        assert.equal(h.activeIntervals.length, 0, 'every interval is cleared after deactivate');
        assert.ok(h.state.statusBarItems.every((item) => item.disposed), 'status bar items are disposed');
    });
});

test('window session id is stored per workspace, not globally', async () => {
    const sharedGlobalState = new Memento();
    const workspaceA = new Memento();
    const ids = [];
    for (const workspaceState of [workspaceA, new Memento(), workspaceA]) {
        await withHarness({ globalState: sharedGlobalState, workspaceState }, async (h) => {
            h.activate();
            const id = h.context.workspaceState.get('antigravity.windowId');
            // session id used for /session-model is generated per workspace, not shared globally
            assert.match(id, /^[0-9a-f-]{36}$/);
            assert.equal(h.context.globalState.get('antigravity.windowId'), undefined);
            ids.push(id);
        });
    }
    assert.notEqual(ids[0], ids[1], 'different workspaces get different ids');
    assert.equal(ids[0], ids[2], 'the same workspace keeps its id');
});
