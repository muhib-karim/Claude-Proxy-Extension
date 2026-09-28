// Minimal test runner executed inside the VS Code extension host (no test framework needed).
const tests = require('./extension.test');

async function run() {
    let failures = 0;
    for (const [name, fn] of Object.entries(tests)) {
        try {
            await fn();
            console.log(`  ok - ${name}`);
        } catch (err) {
            failures++;
            console.error(`  not ok - ${name}\n${err && err.stack ? err.stack : err}`);
        }
    }
    if (failures > 0) {
        throw new Error(`${failures} integration test(s) failed.`);
    }
}

module.exports = { run };
