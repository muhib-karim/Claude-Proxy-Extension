// Repository and packaging guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = require('../package.json');

test('npm test lists every test file explicitly', () => {
    // The script must not rely on the shell expanding a glob: Node 20's runner does not expand
    // globs itself, so `node --test test/*.test.js` fails under cmd.exe / PowerShell.
    const script = manifest.scripts.test;
    assert.doesNotMatch(script, /\*/, 'no glob in the test script');
    const listed = script.split(/\s+/).filter((arg) => arg.endsWith('.test.js')).sort();
    const onDisk = fs.readdirSync(path.join(ROOT, 'test'))
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => `test/${name}`)
        .sort();
    assert.deepEqual(listed, onDisk, 'a test file that is not listed would be skipped silently');
});
