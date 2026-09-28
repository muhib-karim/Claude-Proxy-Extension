const assert = require('assert');
const vscode = require('vscode');
const manifest = require('../../../package.json');

const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

async function waitForExtension(id, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ext = vscode.extensions.getExtension(id);
        if (ext) return ext;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Extension ${id} not found within ${timeoutMs}ms`);
}

module.exports = {
    'activates and registers every contributed command': async () => {
        const ext = await waitForExtension(EXTENSION_ID);
        await ext.activate();
        assert.strictEqual(ext.isActive, true, 'extension should be active');

        const all = await vscode.commands.getCommands(true);
        for (const { command } of manifest.contributes.commands) {
            assert.ok(all.includes(command), `command ${command} should be registered`);
        }
    },

    'contributes the proxyScriptPath setting with an empty default': async () => {
        const value = vscode.workspace.getConfiguration('antigravity').inspect('proxyScriptPath');
        assert.ok(value, 'antigravity.proxyScriptPath should be a known setting');
        assert.strictEqual(value.defaultValue, '');
    }
};
