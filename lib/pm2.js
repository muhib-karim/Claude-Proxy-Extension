// Pure PM2 command helpers (no `vscode` dependency) so they can be unit-tested with plain Node.
const path = require('path');

const PM2_PROCESS_NAME = 'antigravity-proxy';
const PM2_RESTART_COMMAND = `pm2 restart ${PM2_PROCESS_NAME}`;
const PM2_STOP_COMMAND = `pm2 stop ${PM2_PROCESS_NAME}`;

// Validate the `antigravity.proxyScriptPath` setting. Returns the trimmed path, or '' when unset.
// The value ends up inside a double-quoted shell argument (pm2 is a .cmd shim on Windows, so it has
// to go through a shell), so anything that could end the quoting or expand is rejected.
function validateProxyScriptPath(value) {
    const scriptPath = typeof value === 'string' ? value.trim() : '';
    if (!scriptPath) return '';

    const invalid = (reason) => new Error(`Invalid antigravity.proxyScriptPath: ${reason}`);
    if (/["`$%\r\n]/.test(scriptPath)) {
        throw invalid('must not contain quotes, backticks, $, % or line breaks');
    }
    if (scriptPath.endsWith('\\')) {
        throw invalid('must be a file path, not end with a backslash');
    }
    // Absolute paths only (POSIX or Windows form). This also rules out values starting with "-",
    // which pm2 would read as options.
    if (!path.posix.isAbsolute(scriptPath) && !path.win32.isAbsolute(scriptPath)) {
        throw invalid('must be an absolute path');
    }
    return scriptPath;
}

// Shell command that (re)starts the proxy. `pm2 restart` is always tried first; `pm2 start <script>`
// is only appended when a script path is configured, for a proxy not yet registered with PM2.
function buildPm2StartCommand(proxyScriptPath) {
    const scriptPath = validateProxyScriptPath(proxyScriptPath);
    if (!scriptPath) return PM2_RESTART_COMMAND;
    return `${PM2_RESTART_COMMAND} || pm2 start "${scriptPath}" --name ${PM2_PROCESS_NAME}`;
}

module.exports = {
    PM2_PROCESS_NAME,
    PM2_RESTART_COMMAND,
    PM2_STOP_COMMAND,
    validateProxyScriptPath,
    buildPm2StartCommand
};
