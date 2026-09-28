// Launches a real VS Code (downloaded into .vscode-test/) with this extension loaded and runs
// test/integration/suite. On headless Linux run it under a virtual display: xvfb-run -a npm run test:integration
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '../..');
    try {
        await runTests({
            // Defaults to the minimum supported version from engines.vscode
            version: process.env.VSCODE_VERSION || '1.80.0',
            cachePath: path.join(root, '.vscode-test'),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
            launchArgs: ['--disable-extensions']
        });
    } catch (err) {
        console.error('Integration tests failed:', err);
        process.exit(1);
    }
}

main();
