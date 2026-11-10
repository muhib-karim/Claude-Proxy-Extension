#!/usr/bin/env node
// Guard against shipping files that must never be inside the VSIX.
//
// Reads a file list on stdin, one path per line, from either
//   npx @vscode/vsce ls            what would be packaged from this working tree
//   unzip -Z1 <file>.vsix          what was packaged
// and exits 1 when the list
//   - contains a secret-like or otherwise forbidden file,
//   - contains a file that is not on the allowlist of runtime files,
//   - misses a file the extension needs at runtime,
//   - or is empty.
//
// Usage:  npx @vscode/vsce ls | node scripts/check-vsix-files.js      (npm run verify:package)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Matched against lower-cased, forward-slash paths relative to the extension root
const FORBIDDEN = [
    ['.secrets file', /(^|\/)\.secrets$/],
    ['.env file', /(^|\/)\.env(\.[^/]*)?$/],
    ['key or certificate file', /\.(pem|key|p12|pfx)$/],
    ['SSH key', /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/],
    ['npm credentials', /(^|\/)\.npmrc$/],
    ['packaged extension', /\.vsix$/],
    ['node_modules', /(^|\/)node_modules\//],
    ['tests', /(^|\/)test\//],
    ['unpacked copy of an old build', /(^|\/)extracted-[^/]*(\/|$)/],
    ['publish script', /\.ps1$/]
];

// The only files the extension needs at runtime (lower-cased; vsce renames README, CHANGELOG and
// LICENSE inside the VSIX)
const ALLOWED = new Set(['extension.js', 'package.json', 'readme.md', 'changelog.md', 'license', 'license.txt', 'icon.png']);
const ALLOWED_PATTERNS = [/^lib\/[^/]+\.js$/];

// Entries vsce adds to every VSIX next to the extension/ folder
const VSIX_METADATA = new Set(['extension.vsixmanifest', '[content_types].xml']);

// LICENSE is stored as LICENSE.txt inside the VSIX
const canonical = (file) => {
    const lower = file.toLowerCase();
    return lower === 'license.txt' ? 'license' : lower;
};

// Turn raw lines into extension-relative paths with forward slashes
function normalizeFileList(lines) {
    const entries = lines
        .map((line) => String(line).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean);
    const isVsixListing = entries.some((entry) => entry.toLowerCase() === 'extension.vsixmanifest');
    const files = [];
    for (const entry of entries) {
        if (entry.endsWith('/')) continue;                              // directory entry of a zip listing
        if (!isVsixListing) { files.push(entry); continue; }
        if (VSIX_METADATA.has(entry.toLowerCase())) continue;
        files.push(entry.startsWith('extension/') ? entry.slice('extension/'.length) : entry);
    }
    return files;
}

// Files that have to be in the package for the extension to load
function requiredFiles(root = ROOT) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const required = ['package.json', 'readme.md', 'changelog.md', 'license'];
    required.push(path.posix.normalize(manifest.main || './extension.js'));
    if (manifest.icon) required.push(path.posix.normalize(manifest.icon));
    for (const name of fs.readdirSync(path.join(root, 'lib'))) {
        if (name.endsWith('.js')) required.push(`lib/${name}`);
    }
    return required.map(canonical);
}

function checkFileList(lines, { required = requiredFiles() } = {}) {
    const files = normalizeFileList(lines);
    const forbidden = [];
    const unexpected = [];
    for (const file of files) {
        const lower = file.toLowerCase();
        const rule = FORBIDDEN.find(([, pattern]) => pattern.test(lower));
        if (rule) {
            forbidden.push({ file, reason: rule[0] });
        } else if (!ALLOWED.has(lower) && !ALLOWED_PATTERNS.some((pattern) => pattern.test(lower))) {
            unexpected.push(file);
        }
    }
    const present = new Set(files.map(canonical));
    const missing = required.filter((file) => !present.has(file));
    const ok = files.length > 0 && forbidden.length === 0 && unexpected.length === 0 && missing.length === 0;
    return { ok, files, forbidden, unexpected, missing };
}

function main() {
    const input = fs.readFileSync(0, 'utf8');
    const result = checkFileList(input.split(/\r?\n/));

    if (result.ok) {
        console.log(`Package contents OK: ${result.files.length} files, nothing forbidden or unexpected.`);
        for (const file of result.files) console.log(`  ${file}`);
        return 0;
    }

    console.error('Package content check FAILED.');
    if (result.files.length === 0) {
        console.error('  The file list is empty (did `vsce ls` fail?).');
    }
    for (const { file, reason } of result.forbidden) {
        console.error(`  forbidden  ${file}  (${reason})`);
    }
    for (const file of result.unexpected) {
        console.error(`  unexpected ${file}  (not a runtime file; add it to .vscodeignore's allowlist and to this script only if the extension needs it)`);
    }
    for (const file of result.missing) {
        console.error(`  missing    ${file}  (the extension needs it at runtime)`);
    }
    return 1;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { checkFileList, normalizeFileList, requiredFiles };
