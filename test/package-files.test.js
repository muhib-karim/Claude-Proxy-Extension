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

// ---------- VSIX contents ----------

const { spawnSync } = require('node:child_process');

const CHECK_SCRIPT = path.join(ROOT, 'scripts', 'check-vsix-files.js');
const loadCheck = () => require('../scripts/check-vsix-files');

const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`);
// What `vsce ls` prints for a clean checkout
const CLEAN_LS = ['CHANGELOG.md', 'LICENSE', 'README.md', 'extension.js', 'icon.png', 'package.json', ...libFiles];
// What `unzip -Z1 <file>.vsix` prints: vsce renames some files and adds two metadata entries
const CLEAN_VSIX = [
    'extension.vsixmanifest', '[Content_Types].xml',
    'extension/changelog.md', 'extension/LICENSE.txt', 'extension/readme.md',
    'extension/extension.js', 'extension/icon.png', 'extension/package.json',
    ...libFiles.map((file) => `extension/${file}`)
];

const FORBIDDEN_EXAMPLES = [
    '.secrets', 'lib/.secrets', '.env', '.env.local', 'config/.env.production',
    'server.pem', 'private.key', 'cert.p12', 'id_rsa', '.npmrc',
    'old-build.vsix',
    'node_modules/eslint/lib/api.js',
    'test/quota.test.js',
    'extracted-3.3.0/extension/extension.js',
    'publish.ps1'
];

test('a clean file list passes, as vsce ls output and as a VSIX listing', () => {
    const { checkFileList } = loadCheck();
    for (const list of [CLEAN_LS, CLEAN_VSIX, CLEAN_LS.map((f) => f.replace(/\//g, '\\'))]) {
        const result = checkFileList(list);
        assert.deepEqual({ forbidden: result.forbidden, unexpected: result.unexpected, missing: result.missing },
            { forbidden: [], unexpected: [], missing: [] });
        assert.equal(result.ok, true);
        assert.equal(result.files.length, CLEAN_LS.length);
    }
});

test('every secret-like or forbidden file fails the check', () => {
    const { checkFileList } = loadCheck();
    for (const file of FORBIDDEN_EXAMPLES) {
        const fromLs = checkFileList([...CLEAN_LS, file]);
        assert.equal(fromLs.ok, false, file);
        assert.deepEqual(fromLs.forbidden.map((f) => f.file), [file], file);

        const fromVsix = checkFileList([...CLEAN_VSIX, `extension/${file}`]);
        assert.equal(fromVsix.ok, false, `extension/${file}`);
        assert.deepEqual(fromVsix.forbidden.map((f) => f.file), [file], `extension/${file}`);
    }
});

test('a file outside the allowlist fails the check', () => {
    const { checkFileList } = loadCheck();
    for (const file of ['screenshot.png', 'docs/banner.svg', 'notes.txt', 'scripts/check-vsix-files.js', 'lib/sub/x.js', 'lib/data.json', 'package-lock.json']) {
        const result = checkFileList([...CLEAN_LS, file]);
        assert.equal(result.ok, false, file);
        assert.deepEqual(result.unexpected, [file]);
    }
});

test('a missing runtime file fails the check', () => {
    const { checkFileList } = loadCheck();
    for (const file of ['extension.js', 'lib/quota.js', 'icon.png', 'package.json', 'LICENSE']) {
        const result = checkFileList(CLEAN_LS.filter((f) => f !== file));
        assert.equal(result.ok, false, file);
        assert.deepEqual(result.missing, [file.toLowerCase()]);
    }
});

test('an empty file list fails the check', () => {
    const { checkFileList } = loadCheck();
    assert.equal(checkFileList([]).ok, false);
    assert.equal(checkFileList(['', '  ']).ok, false);
});

test('the check script exits 1 for a forbidden file and 0 for a clean list', () => {
    const run = (lines) => spawnSync(process.execPath, [CHECK_SCRIPT], { input: lines.join('\n') + '\n', encoding: 'utf8' });

    const clean = run(CLEAN_LS);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    const leaking = run([...CLEAN_LS, '.secrets']);
    assert.equal(leaking.status, 1);
    assert.match(leaking.stderr, /\.secrets/);

    const empty = run([]);
    assert.equal(empty.status, 1);
});

test('.vscodeignore is an allowlist limited to the runtime files', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.equal(lines[0], '**', 'everything is excluded first');
    const included = lines.slice(1);
    assert.ok(included.every((l) => l.startsWith('!')), 'only re-includes follow');
    // vsce lets a negated pattern win over every exclude, so each one must stay narrow
    assert.deepEqual([...included].sort(), [
        '!CHANGELOG.md', '!LICENSE', '!README.md', '!extension.js', '!icon.png', '!lib/*.js', '!package.json'
    ].sort());
});

test('.gitignore keeps local secrets and build output out of git', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const pattern of ['node_modules', '*.vsix', '.env', '.env.*', '.secrets', '*.pem', '*.key']) {
        assert.ok(lines.includes(pattern), `${pattern} is ignored`);
    }
});

test('README does not embed local SVG images (vsce refuses to package those)', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const sources = [
        ...[...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
        ...[...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1])
    ];
    assert.ok(sources.length >= 4, 'banner and screenshots are referenced');
    const local = sources.filter((src) => !/^https?:/.test(src));
    assert.deepEqual(local.filter((src) => /\.svg$/i.test(src)), []);
    for (const src of local) {
        assert.ok(fs.existsSync(path.join(ROOT, src)), `${src} exists`);
    }
});

test('verify:package pipes a pinned vsce ls through the check script', () => {
    assert.match(manifest.scripts['verify:package'],
        /^npx --yes @vscode\/vsce@\d+\.\d+\.\d+ ls \| node scripts\/check-vsix-files\.js$/);
});
