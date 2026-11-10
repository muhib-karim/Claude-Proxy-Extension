const test = require('node:test');
const assert = require('node:assert/strict');
const pm2 = require('../lib/pm2');
const manifest = require('../package.json');

const RESTART = 'pm2 restart antigravity-proxy';

test('buildPm2StartCommand only restarts when no script path is configured', () => {
    for (const value of ['', '   ', undefined, null, 42]) {
        assert.equal(pm2.buildPm2StartCommand(value), RESTART);
    }
    assert.equal(pm2.PM2_RESTART_COMMAND, RESTART);
    assert.equal(pm2.PM2_STOP_COMMAND, 'pm2 stop antigravity-proxy');
});

test('buildPm2StartCommand appends a quoted pm2 start fallback for a configured absolute path', () => {
    assert.equal(
        pm2.buildPm2StartCommand(' /opt/proxy dir/src/index.js '),
        `${RESTART} || pm2 start "/opt/proxy dir/src/index.js" --name antigravity-proxy`
    );
    assert.equal(
        pm2.buildPm2StartCommand('C:\\Users\\me\\proxy\\src\\index.js'),
        `${RESTART} || pm2 start "C:\\Users\\me\\proxy\\src\\index.js" --name antigravity-proxy`
    );
});

test('buildPm2StartCommand rejects paths that could break out of the quoted argument', () => {
    const bad = [
        '/x" && rm -rf / "',
        '/x/$(whoami).js',
        '/x/`id`.js',
        'C:\\%PATH%\\a.js',
        '/x\n/y.js',
        '/x\r/y.js',
        'C:\\proxy\\'            // a trailing backslash would escape the closing quote
    ];
    for (const value of bad) {
        assert.throws(() => pm2.buildPm2StartCommand(value), /Invalid antigravity\.proxyScriptPath/, JSON.stringify(value));
    }
});

test('buildPm2StartCommand rejects relative paths and option-like values', () => {
    for (const value of ['src/index.js', './index.js', '..\\proxy\\index.js', '-i max', '--watch']) {
        assert.throws(() => pm2.buildPm2StartCommand(value), /Invalid antigravity\.proxyScriptPath/, value);
    }
});

test('the proxy script path setting is machine-scoped, so a workspace cannot set it', () => {
    const setting = manifest.contributes.configuration.properties['antigravity.proxyScriptPath'];
    assert.equal(setting.type, 'string');
    assert.equal(setting.default, '');
    assert.equal(setting.scope, 'machine');
});
