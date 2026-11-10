const vscode = require('vscode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const crypto = require('crypto');
const {
    MODELS,
    processQuotaData,
    sortAccountsByClaudeQuota,
    shortEmail,
    createSmallQuotaBar,
    formatResetTime,
    getDisplayName,
    parseWmicOutput,
    parseNetstatPorts,
    parseUserStatusResponse
} = require('./lib/quota');
const { PM2_RESTART_COMMAND, PM2_STOP_COMMAND, buildPm2StartCommand } = require('./lib/pm2');

// ==================== STATE ====================
let quotaStatusBarItem = null;        // Shows quota summary on hover
let modelStatusBarItem = null;        // Model name (shows "Offline" in red when down)
let currentModel = 'unknown';
let isProxyOnline = false;
let isProxyEnabled = false;           // Toggle to enable/disable proxy (default OFF to avoid conflicts with Antigravity Manager Tool)
let pollInterval = null;
let accountPollInterval = null;
let settingsWatcher = null;           // File watcher for Claude Code settings
let proxyQuotaData = null;            // Quota data from proxy /account-limits
let currentIDEAccount = null;         // Antigravity signed-in account
let isDisposed = false;               // Set on deactivate: late callbacks must not touch the UI
let healthCheckInFlight = false;      // One /active-model poll at a time
let quotaFetchInFlight = false;       // One /account-limits poll at a time
let ideAccountFetchInFlight = false;  // One account lookup (wmic + netstat + GetUserStatus) at a time
let ideAccountFetchQueued = false;    // A trigger arrived mid-lookup: run once more when it finishes
let sessionModelSynced = false;       // The proxy has this window's model for the current online period
let sessionResendInFlight = false;    // A silent re-send of the saved model is running
let modelStartGeneration = 0;         // Bumped by every "start the proxy, then set the model" request

// Per-window model persistence
let extensionContext = null;          // Store context for workspaceState access
let isFirstConnect = true;            // Track first connection to proxy
let windowId = null;                  // Unique window identifier
const WINDOW_MODEL_KEY = 'antigravity.windowModel';  // workspaceState key for per-window model

// Configuration
const PROXY_POLL_INTERVAL_MS = 5000;
const ACCOUNT_POLL_INTERVAL_MS = 60 * 1000;  // 60 seconds - refresh account frequently
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');


// ==================== PROXY START / STOP (PM2) ====================

// PM2 goes through a shell (pm2 is a .cmd shim on Windows). A hung pm2 must not block forever,
// and no console window should flash on Windows.
const PM2_EXEC_OPTIONS = { timeout: 20000, windowsHide: true };
const PM2_START_HINT = 'Register the proxy once with "pm2 start <proxy-script> --name antigravity-proxy", or set "antigravity.proxyScriptPath".';

// A freshly (re)started proxy gets this long to accept connections
const PROXY_READY_ATTEMPTS = 20;
const PROXY_READY_INTERVAL_MS = 500;

function runPm2(command, callback) {
    exec(command, PM2_EXEC_OPTIONS, (error) => callback(error || null));
}

// `pm2 restart antigravity-proxy`, falling back to `pm2 start <antigravity.proxyScriptPath>` when
// that setting is configured (the proxy may not be registered with PM2 yet)
function runPm2Start(callback) {
    let command;
    try {
        const scriptPath = vscode.workspace.getConfiguration('antigravity').get('proxyScriptPath', '');
        command = buildPm2StartCommand(scriptPath);
    } catch (e) {
        callback(e);    // invalid setting: nothing is executed
        return;
    }
    runPm2(command, callback);
}

function isInvalidScriptPath(error) {
    return !!error && /^Invalid antigravity\.proxyScriptPath/.test(error.message);
}

// Ensure proxy is running - called on extension activation
function ensureProxyRunning() {

    // Quick check if proxy is responding
    let timedOut = false;
    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/health',
        method: 'GET',
        timeout: 2000
    }, (res) => {
        // Proxy is running, nothing to do
        res.resume();   // drain the response so the socket is released
        console.log('[Claude Proxy] Proxy already running');
    });

    req.on('error', () => {
        if (timedOut) {
            // Slow is not down. Restarting here would drop the in-flight requests of every
            // window, once per window that is starting up; the regular poll will report the state.
            console.log('[Claude Proxy] Proxy health check timed out; not restarting');
            return;
        }
        // Proxy is not running, try to start it via PM2
        console.log('[Claude Proxy] Proxy offline, attempting PM2 restart...');
        runPm2Start((error) => {
            if (error) {
                console.log(`[Claude Proxy] PM2 restart failed (${error.message}). ${PM2_START_HINT}`);
            } else {
                console.log('[Claude Proxy] Proxy started successfully via PM2');
            }
        });
    });

    req.on('timeout', () => {
        timedOut = true;
        req.destroy();  // emits 'error' on the request
    });

    req.end();
}

// Start the proxy after the user enabled it, then show its state without waiting for the next poll
async function startProxyViaPM2() {
    console.log('[Claude Proxy] Starting proxy via PM2...');
    const cancelled = () => isDisposed || !isProxyEnabled;
    const error = await new Promise((resolve) => runPm2Start(resolve));
    if (cancelled()) return;
    if (error) {
        console.log('[Claude Proxy] PM2 start failed:', error.message);
        vscode.window.showWarningMessage(isInvalidScriptPath(error)
            ? error.message
            : `Could not start the proxy with PM2. ${PM2_START_HINT}`);
    } else {
        console.log('[Claude Proxy] Proxy restarted via PM2');
        await waitForProxyReady(cancelled);     // refreshing before it listens would just paint "Offline"
        if (cancelled()) return;
    }
    // Also after a PM2 failure: the proxy may be running without PM2
    refreshProxyState();
}

// Stop the proxy after the user disabled it, and say what really happened
function stopProxyViaPM2() {
    runPm2(PM2_STOP_COMMAND, (error) => {
        if (isDisposed) return;
        if (error) {
            console.log('[Claude Proxy] PM2 stop failed:', error.message);
            vscode.window.showWarningMessage(`Proxy disabled, but PM2 could not stop it. Run: ${PM2_STOP_COMMAND}`);
        } else {
            vscode.window.showInformationMessage('⏸️ Proxy stopped. Use Antigravity Manager instead.');
        }
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One GET /health. Any HTTP answer means the proxy is listening.
function probeProxyHealth() {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: 8080,
            path: '/health',
            method: 'GET',
            timeout: 1000
        }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => req.destroy());
        req.end();
    });
}

// Wait until a freshly (re)started proxy accepts connections. Bounded by attempt count, so it
// always ends; `isCancelled` stops it early.
async function waitForProxyReady(isCancelled) {
    for (let attempt = 1; attempt <= PROXY_READY_ATTEMPTS; attempt++) {
        if (isCancelled()) return false;
        if (await probeProxyHealth()) return true;
        if (attempt < PROXY_READY_ATTEMPTS) await delay(PROXY_READY_INTERVAL_MS);
    }
    return false;
}

function describeRequestError(error) {
    if (!error) return 'unknown error';
    if (error.code === 'ECONNREFUSED') return 'the proxy is not reachable';
    if (error.code === 'ETIMEDOUT') return 'the proxy did not answer in time';
    if (error.code === 'ECONNRESET') return 'the proxy closed the connection';
    return error.message || String(error);
}

// Set the model and tell the user when that fails. Never rejects, so no caller can leak a rejection.
async function trySetModelOnProxy(model) {
    try {
        await setModelOnProxy(model);
        return true;
    } catch (e) {
        console.log('[Claude Proxy] Model switch failed:', e && e.message);
        if (!isDisposed) {
            vscode.window.showErrorMessage(`Failed to switch model: ${describeRequestError(e)}`);
        }
        return false;
    }
}

// Proxy is enabled but offline and the user picked a model: start it, wait for it, then set the model
async function startProxyAndSetModel(model) {
    const generation = ++modelStartGeneration;
    // A newer selection, a disable or a deactivate makes this request obsolete
    const superseded = () => isDisposed || generation !== modelStartGeneration || !isProxyEnabled;

    const startError = await new Promise((resolve) => runPm2Start(resolve));
    if (superseded()) return;
    if (startError) {
        console.log('[Claude Proxy] PM2 start failed:', startError.message);
        vscode.window.showErrorMessage(isInvalidScriptPath(startError)
            ? startError.message
            : `Failed to start proxy. Run: ${PM2_RESTART_COMMAND} (or set "antigravity.proxyScriptPath")`);
        return;
    }

    const ready = await waitForProxyReady(superseded);
    if (superseded()) return;
    if (!ready) {
        vscode.window.showErrorMessage('Proxy was started with PM2 but is not responding on localhost:8080 yet. Try again in a moment.');
        return;
    }

    await trySetModelOnProxy(model);
    if (isDisposed) return;
    // Show the new state now instead of waiting for the next poll
    checkProxyHealth();
    fetchProxyQuotaData();
}

// Flip the enabled flag (persisted for every window) and repaint both status bar items
function setProxyEnabled(enabled) {
    isProxyEnabled = enabled;
    extensionContext.globalState.update('antigravity.proxyEnabled', enabled);
    if (!enabled) {
        // Nothing is polled while disabled, so what we knew about the proxy is stale from here on
        isProxyOnline = false;
        proxyQuotaData = null;
        sessionModelSynced = false;
    }
    updateModelStatusBar();
    updateQuotaStatusBar();
}

// ==================== ACTIVATION ====================

function activate(context) {
    const version = context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : '';
    console.log(`[Claude Proxy] Extension v${version} activated`);

    // Store context for workspaceState access in other functions
    extensionContext = context;
    isDisposed = false;
    isProxyOnline = false;      // every activation starts offline, so the first answer counts as a reconnect
    healthCheckInFlight = false;
    quotaFetchInFlight = false;
    ideAccountFetchInFlight = false;
    ideAccountFetchQueued = false;
    sessionModelSynced = false;
    sessionResendInFlight = false;

    // Load saved proxy enabled state
    const savedProxyEnabled = context.globalState.get('antigravity.proxyEnabled');
    if (savedProxyEnabled !== undefined) {
        isProxyEnabled = savedProxyEnabled;
        console.log(`[Claude Proxy] Loaded proxy enabled state: ${isProxyEnabled}`);
    }

    // Auto-start proxy if not running AND enabled
    if (isProxyEnabled) {
        ensureProxyRunning();
    }

    // Generate or retrieve unique window ID (workspaceState, so each workspace gets its own proxy session)
    windowId = context.workspaceState.get('antigravity.windowId');
    if (!windowId) {
        windowId = crypto.randomUUID();
        context.workspaceState.update('antigravity.windowId', windowId);
        console.log(`[Claude Proxy] Generated new window ID: ${windowId.slice(0, 8)}...`);
    }

    // Load saved window-local model (persists per-workspace)
    const savedWindowModel = context.workspaceState.get(WINDOW_MODEL_KEY);
    if (savedWindowModel) {
        currentModel = savedWindowModel;
        isFirstConnect = false;  // Don't override with proxy model
        console.log(`[Claude Proxy] Loaded saved model for this window: ${savedWindowModel}`);
    }


    // ==================== STATUS BAR ITEMS (2 icons) ====================

    // 1. Account/Quota Status Bar (priority 101 - left) - Click to show quota info
    quotaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    quotaStatusBarItem.text = '$(account)';
    quotaStatusBarItem.tooltip = 'Click to view quota info';  // Static tooltip
    quotaStatusBarItem.command = 'antigravity.showQuotaInfo';
    quotaStatusBarItem.show();
    context.subscriptions.push(quotaStatusBarItem);

    // 2. Model Status Bar (priority 100 - right of quota)
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    modelStatusBarItem.text = '$(sync~spin) ...';
    modelStatusBarItem.tooltip = 'Connecting to proxy...';
    modelStatusBarItem.command = 'antigravity.switchModel';
    modelStatusBarItem.show();
    context.subscriptions.push(modelStatusBarItem);

    // ==================== COMMANDS ====================

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openDashboard', () => {
            vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard#overview'));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.switchModel', async () => {
            // Build menu items - toggle at top
            const toggleLabel = isProxyEnabled ? '$(debug-stop) Disable Proxy' : '$(play) Enable Proxy';
            const menuItems = [
                { label: toggleLabel, action: 'toggle' },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                ...MODELS.map(m => ({ ...m, action: 'model' }))
            ];

            // Handle disabled state
            if (!isProxyEnabled) {
                const selected = await vscode.window.showQuickPick(menuItems, {
                    placeHolder: 'Proxy disabled - click Enable to start',
                    title: '$(debug-stop) Proxy Disabled'
                });
                if (selected && selected.action === 'toggle') {
                    setProxyEnabled(true);
                    vscode.window.showInformationMessage('✅ Proxy enabled. Starting it via PM2...');
                    await startProxyViaPM2();
                }
                return;
            }

            // If proxy is offline, show options to start it or disable
            if (!isProxyOnline) {
                const selected = await vscode.window.showQuickPick(menuItems, {
                    placeHolder: 'Proxy offline - selecting a model will start it',
                    title: '🧠 Switch Model (Proxy Offline)'
                });
                if (!selected) return;

                // Handle toggle action (disable proxy flag)
                if (selected.action === 'toggle') {
                    setProxyEnabled(false);
                    vscode.window.showInformationMessage('⏸️ Proxy disabled. Use Antigravity Manager instead.');
                    return;
                }

                // Start the proxy via PM2, wait until it answers, then set the model
                await startProxyAndSetModel(selected.model);
                return;
            }

            const selected = await vscode.window.showQuickPick(menuItems, {
                placeHolder: `Current: ${getDisplayName(currentModel)}`,
                title: '🧠 Switch Model'
            });
            if (!selected) return;
            if (selected.action === 'toggle') {
                setProxyEnabled(false);
                stopProxyViaPM2();
                return;
            }
            await trySetModelOnProxy(selected.model);
        })
    );

    // Show quota info command - Quick Pick style popup
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.showQuotaInfo', async () => {
            await showQuotaQuickPick();
        })
    );

    // ==================== POLLING ====================
    // Nothing is polled or looked up while the user has the proxy disabled: port 8080 may then
    // belong to another tool, and "disabled" must not start any process.
    if (isProxyEnabled) {
        refreshProxyState();
    } else {
        updateModelStatusBar();
        updateQuotaStatusBar();
    }
    pollInterval = setInterval(() => {
        if (!isProxyEnabled) return;
        checkProxyHealth();
        fetchProxyQuotaData();
    }, PROXY_POLL_INTERVAL_MS);

    // Listen for auth changes - refresh account immediately
    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(() => {
            fetchIDEAccount();
        })
    );

    // Periodic account refresh
    accountPollInterval = setInterval(() => {
        fetchIDEAccount();
    }, ACCOUNT_POLL_INTERVAL_MS);

    // Refresh account on window focus (catches changes made via Antigravity Manager)
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((windowState) => {
            if (windowState.focused) {
                fetchIDEAccount();
            }
        })
    );

    // ==================== WATCH CLAUDE CODE SETTINGS ====================
    // DISABLED: Per-window model selection takes priority over global settings
    // The settings watcher was causing models to switch unexpectedly
    // watchClaudeSettings();

    // DISABLED: VS Code config changes should not override window-local model
    // Per-window model is stored in workspaceState and managed by this extension
    // context.subscriptions.push(
    //     vscode.workspace.onDidChangeConfiguration((e) => {
    //         if (e.affectsConfiguration('claudeCode.selectedModel')) {
    //             ...
    //         }
    //     })
    // );

    context.subscriptions.push({ dispose: shutdown });
}

// ==================== QUOTA STATUS BAR ====================

function updateQuotaStatusBar() {
    if (!quotaStatusBarItem) return;

    // Check if proxy is disabled by user
    if (!isProxyEnabled) {
        quotaStatusBarItem.text = '$(account)';
        quotaStatusBarItem.tooltip = 'Proxy disabled';
        return;
    }

    // Static tooltip - never changes, prevents flickering
    quotaStatusBarItem.tooltip = 'Click to view quota info';

    if (!isProxyOnline) {
        quotaStatusBarItem.text = '$(account) Offline';
        return;
    }

    // Show account name if available
    if (currentIDEAccount) {
        quotaStatusBarItem.text = `$(account) ${shortEmail(currentIDEAccount.email)}`;
    } else {
        quotaStatusBarItem.text = '$(account)';
    }
}

// Show quota info as a Quick Pick popup (like hover tooltip but on click)
async function showQuotaQuickPick() {
    const items = [];

    // Header separator - clean label without icons
    items.push({
        label: 'Model Quotas',
        kind: vscode.QuickPickItemKind.Separator
    });

    if (!isProxyEnabled) {
        items.push({ label: '$(debug-stop) Proxy disabled', description: 'Enable it from the model menu to see quotas' });
    } else if (!isProxyOnline) {
        items.push({ label: '$(warning) Proxy offline', description: 'No quota data available' });
    } else if (!proxyQuotaData) {
        items.push({ label: '$(sync~spin) Loading quota data...', description: '' });
    } else {
        // Claude quota
        if (proxyQuotaData.claudeQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.claudeQuota);
            items.push({
                label: `🟠 Claude: ${bar} ${proxyQuotaData.claudeQuota}%`,
                description: 'Overall',
                detail: proxyQuotaData.claudeModels?.slice(0, 3).map(m => `${m.id.replace('claude-', '')}: ${m.quota}%`).join(' • ')
            });
        }

        // Gemini quota
        if (proxyQuotaData.geminiQuota !== null) {
            const bar = createSmallQuotaBar(proxyQuotaData.geminiQuota);
            items.push({
                label: `💎 Gemini: ${bar} ${proxyQuotaData.geminiQuota}%`,
                description: 'Overall',
                detail: proxyQuotaData.geminiModels?.slice(0, 3).map(m => `${m.id.replace('gemini-', '')}: ${m.quota}%`).join(' • ')
            });
        }

        // Per-account breakdown - clean label
        if (proxyQuotaData.accounts && proxyQuotaData.accounts.length > 0) {
            items.push({
                label: `${proxyQuotaData.totalAccounts} Google Account(s)`,
                kind: vscode.QuickPickItemKind.Separator
            });

            const accountsWithQuota = sortAccountsByClaudeQuota(proxyQuotaData.accounts);

            for (const { acc, claudePct, geminiPct, claudeReset, geminiReset } of accountsWithQuota) {
                const name = shortEmail(acc.email);

                const claudeStr = claudePct !== null ? `${createSmallQuotaBar(claudePct)} ${claudePct}%` : '—';
                const geminiStr = geminiPct !== null ? `${createSmallQuotaBar(geminiPct)} ${geminiPct}%` : '—';

                let detail = `🟠 Claude: ${claudeStr}`;
                if (claudeReset && claudePct !== null && claudePct < 100) detail += ` (resets ${formatResetTime(new Date(claudeReset))})`;
                detail += `  •  💎 Gemini: ${geminiStr}`;
                if (geminiReset && geminiPct !== null && geminiPct < 100) detail += ` (resets ${formatResetTime(new Date(geminiReset))})`;

                items.push({
                    label: `👤 ${name}`,
                    detail: detail
                });
            }
        }

        // Open Dashboard option
        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator
        });
        items.push({
            label: '$(link-external) Open Dashboard',
            description: 'View full details in browser',
            alwaysShow: true,
            action: 'dashboard'
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Antigravity Quota Info',
        placeHolder: 'Account and model quota information',
        matchOnDetail: true
    });

    if (selected && selected.action === 'dashboard') {
        vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/dashboard#overview'));
    }
}

// Refresh everything the status bar shows: proxy health, quota and the signed-in account
function refreshProxyState() {
    checkProxyHealth();
    fetchProxyQuotaData();
    fetchIDEAccount();
}

// Fetch Antigravity signed-in account using language server API (like UsageBar).
// Triggered at activation, every 60 s, on window focus and on auth changes. Lookups never overlap;
// a trigger that arrives while one is running makes it run once more afterwards, so an account
// switch is not missed.
async function fetchIDEAccount() {
    if (isDisposed || !isProxyEnabled) return;
    if (ideAccountFetchInFlight) {
        ideAccountFetchQueued = true;
        return;
    }
    ideAccountFetchInFlight = true;
    let account = null;
    try {
        account = await lookupIDEAccount();
    } catch (e) {
        console.log('[Claude Proxy] Could not fetch Antigravity account:', e.message);
    } finally {
        ideAccountFetchInFlight = false;
    }
    if (isDisposed) return;
    currentIDEAccount = account;
    updateQuotaStatusBar();

    if (ideAccountFetchQueued) {
        ideAccountFetchQueued = false;
        fetchIDEAccount();
    }
}

// Resolves to { provider, email, plan }, or null when no signed-in account can be determined
async function lookupIDEAccount() {
    // Step 1: Find Antigravity language server process and extract CSRF token
    const processInfo = await detectAntigravityProcess();
    if (!processInfo) return null;

    // Step 2: Get listening ports for the process
    const ports = await getProcessPorts(processInfo.pid);
    if (ports.length === 0) {
        console.log('[Claude Proxy] No listening ports found');
        return null;
    }

    // Step 3: Call GetUserStatus API on each port until one works
    for (const port of ports) {
        let userStatus = null;
        try {
            userStatus = await callGetUserStatus(port, processInfo.csrfToken);
        } catch (e) {
            continue;   // Try next port (only request failures are ignored here)
        }
        if (userStatus && userStatus.email) {
            console.log('[Claude Proxy] Found Antigravity account');   // the address itself stays out of the log
            return {
                provider: 'antigravity',
                email: userStatus.email,
                plan: userStatus.plan
            };
        }
    }

    console.log('[Claude Proxy] Could not get user status from any port');
    return null;
}

// Detect Antigravity language server process. Windows only: it relies on wmic, and on other
// platforms spawning it would just fork a failing shell on every trigger.
function detectAntigravityProcess() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(null);
            return;
        }
        exec('wmic process where "Name like \'%language_server%\'" get ProcessId,CommandLine /format:list',
            { timeout: 5000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
            (error, stdout) => {
                resolve(error ? null : parseWmicOutput(stdout));
            }
        );
    });
}

// Get listening ports for a process (Windows)
function getProcessPorts(pid) {
    return new Promise((resolve) => {
        // The pid is interpolated into a shell command, so only a plain positive integer is accepted
        if (!Number.isInteger(pid) || pid <= 0) {
            resolve([]);
            return;
        }
        // findstr only narrows the output (it matches substrings); parseNetstatPorts keeps the
        // rows whose PID column is exactly this pid
        exec(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`,
            { timeout: 5000, windowsHide: true },
            (error, stdout) => {
                resolve(error ? [] : parseNetstatPorts(stdout, pid));
            }
        );
    });
}

// Collect a response body. Rejects when the connection drops before the response completes:
// in that case Node fires neither the response's 'end' nor the request's 'error', so a promise
// that only listens for those two would stay pending forever.
function readBody(res) {
    return new Promise((resolve, reject) => {
        let data = '';
        let ended = false;
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            ended = true;
            resolve(data);
        });
        res.on('error', reject);
        res.on('close', () => {
            if (!ended) reject(new Error('Connection closed before the response completed'));
        });
    });
}

function timeoutError() {
    return Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' });
}

// Call GetUserStatus API on the language server
function callGetUserStatus(port, csrfToken) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });

        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken
            },
            // Loopback-only connection to the IDE's language server, which uses a self-signed certificate
            rejectUnauthorized: false,
            timeout: 3000
        };

        const handleResponse = (res) => {
            readBody(res).then(data => resolve(parseUserStatusResponse(data))).catch(reject);
        };

        // Try HTTPS first
        const req = https.request(options, handleResponse);

        req.on('error', (e) => {
            if (e && e.code === 'ETIMEDOUT') {
                // A port that does not answer is not retried over plain HTTP: that would only
                // send the CSRF token again, in cleartext, after this promise has given up
                reject(e);
                return;
            }
            // Try HTTP fallback (the language server speaks plain HTTP on some ports)
            const httpReq = http.request({ ...options, protocol: undefined }, handleResponse);
            httpReq.on('error', reject);
            httpReq.on('timeout', () => httpReq.destroy(timeoutError()));
            httpReq.write(body);
            httpReq.end();
        });

        req.on('timeout', () => req.destroy(timeoutError()));
        req.write(body);
        req.end();
    });
}

// ==================== QUOTA DATA ====================

function fetchProxyQuotaData() {
    if (quotaFetchInFlight) return;     // the previous poll is still running
    quotaFetchInFlight = true;
    const done = () => { quotaFetchInFlight = false; };

    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/account-limits',
        method: 'GET',
        timeout: 5000
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            done();
            if (isDisposed || !isProxyEnabled) return;  // answer arrived after a disable/deactivate
            if (res.statusCode !== 200) {
                console.log(`[Claude Proxy] /account-limits answered HTTP ${res.statusCode}; keeping previous quota data`);
                return;
            }
            try {
                const json = JSON.parse(data);
                proxyQuotaData = processQuotaData(json);
                updateQuotaStatusBar();
            } catch (e) {
                console.log('[Claude Proxy] Could not parse quota data:', e.message);
            }
        });
    });

    req.on('error', () => {
        done();
        if (isDisposed || !isProxyEnabled) return;
        proxyQuotaData = null;
        updateQuotaStatusBar();
    });
    req.on('timeout', () => req.destroy());
    req.on('close', done);  // also covers a connection dropped mid-response, where neither of the above fires
    req.end();
}

// ==================== CLAUDE CODE SETTINGS WATCHER ====================

// Currently unused (see activate); kept for re-enabling global settings sync
// eslint-disable-next-line no-unused-vars
function watchClaudeSettings() {
    try {
        if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
            console.log('[Claude Proxy] Claude settings file not found, skipping watch');
            return;
        }

        settingsWatcher = fs.watch(CLAUDE_SETTINGS_PATH, { persistent: false }, (eventType) => {
            if (eventType === 'change') {
                try {
                    const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
                    if (data.model && data.model !== currentModel) {
                        console.log(`[Claude Proxy] Detected model change: ${data.model}`);
                        currentModel = data.model;
                        updateModelStatusBar();
                        trySetModelOnProxy(data.model);
                    }
                } catch (e) {
                    // File being written, ignore
                }
            }
        });

        console.log('[Claude Proxy] Watching Claude settings');
    } catch (e) {
        console.log('[Claude Proxy] Could not watch settings:', e.message);
    }
}

// ==================== PROXY/MODEL FUNCTIONS ====================

function checkProxyHealth() {
    if (healthCheckInFlight) return;    // the previous poll is still running
    healthCheckInFlight = true;
    const done = () => { healthCheckInFlight = false; };
    const setOnline = (online) => {
        const cameOnline = online && !isProxyOnline;
        isProxyOnline = online;
        if (!online) sessionModelSynced = false;    // a proxy that went away may come back without our model
        updateModelStatusBar();
        updateQuotaStatusBar();
        if (cameOnline) resendWindowModel();
    };

    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/active-model',
        method: 'GET',
        timeout: 2000
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            done();
            if (isDisposed || !isProxyEnabled) return;  // answer arrived after a disable/deactivate

            // Only the parse is guarded: an exception in the status bar code below must never be
            // mistaken for "the proxy is down"
            // Anything other than HTTP 200 with a JSON object is not our proxy answering normally
            // (another tool may be listening on 8080)
            let json = null;
            if (res.statusCode === 200) {
                try {
                    json = JSON.parse(data);
                } catch (e) {
                    json = null;
                }
            }
            if (!json || typeof json !== 'object') {
                setOnline(false);
                return;
            }

            // Only accept proxy model on FIRST connect if no local model saved
            // This prevents multiple windows from overwriting each other's model
            if (typeof json.model === 'string' && json.model && json.model !== currentModel) {
                const hasSavedModel = extensionContext && extensionContext.workspaceState.get(WINDOW_MODEL_KEY);
                if (isFirstConnect && !hasSavedModel) {
                    console.log(`[Claude Proxy] First connect - using proxy model: ${json.model}`);
                    currentModel = json.model;
                }
                // Otherwise, keep local model - don't let proxy override
            }
            isFirstConnect = false;

            setOnline(true);
        });
    });

    req.on('error', () => {
        done();
        if (isDisposed || !isProxyEnabled) return;
        setOnline(false);
    });
    req.on('timeout', () => req.destroy());
    req.on('close', done);  // also covers a connection dropped mid-response, where neither of the above fires
    req.end();
}


// POST this window's model to the proxy's per-session endpoint. Resolves on HTTP 200.
function postSessionModel(model) {
    return new Promise((resolve, reject) => {
        // Use session-model endpoint for per-window model isolation
        const postData = JSON.stringify({
            model,
            sessionId: windowId,  // Use window's unique ID
            name: vscode.workspace.name || 'Window'
        });
        const req = http.request({
            hostname: 'localhost',
            port: 8080,
            path: '/session-model',  // Session-based endpoint
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 5000
        }, (res) => {
            readBody(res).then((data) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    console.log(`[Claude Proxy] /session-model answered HTTP ${res.statusCode}: ${String(data).slice(0, 200)}`);
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).catch(reject);
        });

        req.on('error', reject);
        req.on('timeout', () => req.destroy(timeoutError()));
        req.write(postData);
        req.end();
    });
}

// The user picked a model: send it to the proxy, remember it for this window and show it
async function setModelOnProxy(model) {
    await postSessionModel(model);
    currentModel = model;
    sessionModelSynced = true;
    // Save to workspaceState for per-window persistence (also when the window is closing: the
    // proxy has accepted the model, so the saved state must match)
    if (extensionContext) {
        extensionContext.workspaceState.update(WINDOW_MODEL_KEY, model);
        console.log(`[Claude Proxy] Saved session model: ${windowId.slice(0, 8)} -> ${model}`);
    }
    if (!isDisposed) {
        updateModelStatusBar();
        vscode.window.showInformationMessage(`🧠 Model: ${getDisplayName(model)} (this window)`);
    }
}

// The proxy keeps per-window (session) models in memory only. After it restarts it no longer knows
// this window's model, while the status bar still shows the saved one. Called when the proxy goes
// from offline to online: quietly send the saved model again. One attempt per reconnect, and a
// failure is only logged, because the user did not ask for anything.
function resendWindowModel() {
    const savedModel = extensionContext && extensionContext.workspaceState.get(WINDOW_MODEL_KEY);
    if (!savedModel || sessionModelSynced || sessionResendInFlight) return;
    sessionResendInFlight = true;
    postSessionModel(savedModel).then(() => {
        sessionModelSynced = true;
        console.log(`[Claude Proxy] Re-sent session model after reconnect: ${windowId.slice(0, 8)} -> ${savedModel}`);
    }, (e) => {
        console.log('[Claude Proxy] Could not re-send session model after reconnect:', e && e.message);
    }).finally(() => {
        sessionResendInFlight = false;
    });
}

function updateModelStatusBar() {
    if (!modelStatusBarItem) return;

    // Check if proxy is disabled by user
    if (!isProxyEnabled) {
        modelStatusBarItem.text = '$(debug-stop) Disabled';
        modelStatusBarItem.tooltip = 'Proxy disabled - click to enable';
        modelStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
    }

    if (!isProxyOnline) {
        modelStatusBarItem.text = '$(warning) Offline';
        modelStatusBarItem.tooltip = 'Proxy offline - click to retry';
        modelStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        modelStatusBarItem.text = getDisplayName(currentModel);
        modelStatusBarItem.tooltip = `This Window: ${currentModel}\nClick to switch (per-window)`;
        modelStatusBarItem.backgroundColor = undefined;
    }
}

// ==================== DEACTIVATION ====================

function clearTimers() {
    if (pollInterval) clearInterval(pollInterval);
    if (accountPollInterval) clearInterval(accountPollInterval);
    pollInterval = null;
    accountPollInterval = null;
}

// Runs from deactivate() and again when the subscriptions are disposed; safe to call twice.
// Requests and timers that are still in flight see isDisposed and leave the UI and the user alone.
function shutdown() {
    isDisposed = true;
    modelStartGeneration++;     // cancels a pending "start the proxy, then set the model"
    clearTimers();
    if (settingsWatcher) {
        settingsWatcher.close();
        settingsWatcher = null;
    }
    // The items themselves are disposed by VS Code (they are in context.subscriptions)
    quotaStatusBarItem = null;
    modelStatusBarItem = null;
}

function deactivate() {
    shutdown();
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };

