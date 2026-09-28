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
    getDisplayName,
    shortEmail,
    createSmallQuotaBar,
    formatResetTime,
    processQuotaData,
    sortAccountsByClaudeQuota,
    parseWmicProcessList,
    parseListeningPorts,
    parseUserStatusResponse,
    buildPm2StartCommand,
} = require('./lib/helpers');

// ==================== STATE ====================
let quotaStatusBarItem = null;        // Shows quota summary on hover
let modelStatusBarItem = null;        // Model name (shows "Offline" in red when down)
let currentModel = 'unknown';
let isProxyOnline = false;
let isProxyEnabled = false;           // Toggle to enable/disable proxy (default OFF to avoid conflicts with Antigravity Manager Tool)
let pollInterval = null;
let accountPollInterval = null;       // Periodic Antigravity account refresh
let settingsWatcher = null;           // File watcher for Claude Code settings
let proxyQuotaData = null;            // Quota data from proxy /account-limits
let currentIDEAccount = null;         // Antigravity signed-in account
let ideAccountFetchInFlight = false;  // Prevents overlapping account lookups (poll + focus + auth events)

// Per-window model persistence
let extensionContext = null;          // Store context for workspaceState access
let isFirstConnect = true;            // Track first connection to proxy
let windowId = null;                  // Unique window identifier
const WINDOW_MODEL_KEY = 'antigravity.windowModel';  // workspaceState key for per-window model
const WINDOW_ID_KEY = 'antigravity.windowId';        // workspaceState key for per-window session ID

// Configuration
const PROXY_POLL_INTERVAL_MS = 5000;
const ACCOUNT_POLL_INTERVAL_MS = 60 * 1000;  // 60 seconds - refresh account frequently
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const DASHBOARD_URL = 'http://localhost:8080/dashboard#overview';

// ==================== PROXY AUTO-START ====================

// Ensure proxy is running - called on extension activation
function ensureProxyRunning() {
    // Quick check if proxy is responding
    const req = http.request({
        hostname: 'localhost',
        port: 8080,
        path: '/health',
        method: 'GET',
        timeout: 2000
    }, (res) => {
        // Proxy is running, nothing to do
        res.resume();
        console.log('[Claude Proxy] Proxy already running');
    });

    req.on('error', () => {
        // Proxy is not running, try to start it via PM2
        console.log('[Claude Proxy] Proxy offline, attempting PM2 restart...');
        runPm2Start((error) => {
            if (error) {
                console.log('[Claude Proxy] PM2 restart failed. Please run: pm2 start <proxy-path> --name antigravity-proxy');
            } else {
                console.log('[Claude Proxy] Proxy started successfully via PM2');
            }
        });
    });

    req.on('timeout', () => {
        req.destroy();
    });

    req.end();
}

// Run `pm2 restart antigravity-proxy`, falling back to `pm2 start <antigravity.proxyScriptPath>`
// when that setting is configured (the process may not be registered with PM2 yet)
function runPm2Start(callback) {
    let command;
    try {
        const scriptPath = vscode.workspace.getConfiguration('antigravity').get('proxyScriptPath', '');
        command = buildPm2StartCommand(scriptPath);
    } catch (e) {
        callback(e);
        return;
    }
    exec(command, (error) => callback(error));
}

// Direct PM2 start - called when user clicks Enable or to recover crashed proxy
function startProxyViaPM2() {
    console.log('[Claude Proxy] Starting proxy via PM2...');
    // Try restart first (works if process exists in PM2)
    runPm2Start((restartErr) => {
        if (restartErr) {
            console.log('[Claude Proxy] PM2 restart failed. Proxy may not be registered.');
            vscode.window.showWarningMessage('Proxy not found in PM2. Please run setup: scripts/setup/SETUP_STARTUP.bat, or set "antigravity.proxyScriptPath" in your user settings.');
        } else {
            console.log('[Claude Proxy] Proxy restarted via PM2');
        }
    });
}

// Set the model on the proxy and surface failures instead of leaving an unhandled rejection
async function trySetModelOnProxy(model) {
    try {
        await setModelOnProxy(model);
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to switch model: ${e && e.message ? e.message : e}`);
    }
}

// ==================== ACTIVATION ====================

function activate(context) {
    const version = context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : '';
    console.log(`[Claude Proxy] Extension v${version} activated`);

    // Store context for workspaceState access in other functions
    extensionContext = context;

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

    // Generate or retrieve unique window ID. Stored in workspaceState (per window/workspace):
    // globalState is shared by every window, which gave all windows the same proxy session.
    windowId = context.workspaceState.get(WINDOW_ID_KEY);
    if (!windowId) {
        windowId = crypto.randomUUID();
        context.workspaceState.update(WINDOW_ID_KEY, windowId);
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
            vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.switchModel', async () => {
            // Build menu items - toggle at top
            const toggleLabel = isProxyEnabled ? '$(debug-stop) Disable Proxy' : '$(play) Enable Proxy';
            /** @type {Array<vscode.QuickPickItem & { action?: string, model?: string }>} */
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
                    isProxyEnabled = true;
                    extensionContext.globalState.update('antigravity.proxyEnabled', true);
                    startProxyViaPM2();
                    updateModelStatusBar();
                    updateQuotaStatusBar();
                    vscode.window.showInformationMessage('✅ Proxy enabled!');
                }
                return;
            }

            // If proxy is offline, show options to start it or disable
            if (!isProxyOnline) {
                const selected = await vscode.window.showQuickPick(menuItems, {
                    placeHolder: 'Proxy offline - selecting a model will start it',
                    title: '🧠 Switch Model (Proxy Offline)'
                });

                if (selected) {
                    // Handle toggle action (disable proxy flag)
                    if (selected.action === 'toggle') {
                        isProxyEnabled = false;
                        extensionContext.globalState.update('antigravity.proxyEnabled', false);
                        updateModelStatusBar();
                        updateQuotaStatusBar();
                        vscode.window.showInformationMessage('⏸️ Proxy disabled. Use Antigravity Manager instead.');
                        return;
                    }

                    // Start the proxy via PM2 for model selection
                    // (pm2 start fallback uses the antigravity.proxyScriptPath setting, if set)
                    runPm2Start((error) => {
                        if (error) {
                            vscode.window.showErrorMessage('Failed to start proxy. Run: pm2 restart antigravity-proxy (or set "antigravity.proxyScriptPath")');
                        } else {
                            vscode.window.showInformationMessage(`Proxy started! Model: ${selected.label}`);
                            // Wait a moment then set the model
                            setTimeout(() => {
                                trySetModelOnProxy(selected.model);
                            }, 2000);
                        }
                    });
                }
                return;
            }

            const selected = await vscode.window.showQuickPick(menuItems, {
                placeHolder: `Current: ${getDisplayName(currentModel)}`,
                title: '🧠 Switch Model'
            });
            if (selected) {
                if (selected.action === 'toggle') {
                    isProxyEnabled = false;
                    extensionContext.globalState.update('antigravity.proxyEnabled', false);
                    exec('pm2 stop antigravity-proxy', () => { });
                    updateModelStatusBar();
                    updateQuotaStatusBar();
                    vscode.window.showInformationMessage('⏸️ Proxy stopped. Use Antigravity Manager instead.');
                    return;
                }
                await trySetModelOnProxy(selected.model);
            }
        })
    );

    // Show quota info command - Quick Pick style popup
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.showQuotaInfo', async () => {
            await showQuotaQuickPick();
        })
    );

    // ==================== POLLING ====================
    checkProxyHealth();
    fetchProxyQuotaData();
    fetchIDEAccount();  // Fetch Antigravity signed-in account
    pollInterval = setInterval(() => {
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

    context.subscriptions.push({
        dispose: () => {
            clearTimers();
            if (settingsWatcher) settingsWatcher.close();
        }
    });
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

    if (!proxyQuotaData) {
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

            // Pre-calculate Claude quota for each account and sort (accounts with Claude available at top)
            const accountsWithQuota = sortAccountsByClaudeQuota(proxyQuotaData.accounts);

            for (const { acc, claudePct, geminiPct, claudeReset, geminiReset } of accountsWithQuota) {
                const accountName = shortEmail(acc.email);

                const claudeStr = claudePct !== null ? `${createSmallQuotaBar(claudePct)} ${claudePct}%` : '—';
                const geminiStr = geminiPct !== null ? `${createSmallQuotaBar(geminiPct)} ${geminiPct}%` : '—';

                let detail = `🟠 Claude: ${claudeStr}`;
                if (claudeReset && claudePct < 100) detail += ` (resets ${formatResetTime(new Date(claudeReset))})`;
                detail += `  •  💎 Gemini: ${geminiStr}`;
                if (geminiReset && geminiPct < 100) detail += ` (resets ${formatResetTime(new Date(geminiReset))})`;

                items.push({
                    label: `👤 ${accountName}`,
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
        vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
    }
}

// Fetch Antigravity signed-in account using language server API (like UsageBar)
async function fetchIDEAccount() {
    if (ideAccountFetchInFlight) return;
    ideAccountFetchInFlight = true;
    try {
        // Step 1: Find Antigravity language server process and extract CSRF token
        const processInfo = await detectAntigravityProcess();
        if (!processInfo) {
            currentIDEAccount = null;
            return;
        }

        // Step 2: Get listening ports for the process
        const ports = await getProcessPorts(processInfo.pid);
        if (ports.length === 0) {
            console.log('[Claude Proxy] No listening ports found');
            currentIDEAccount = null;
            return;
        }

        // Step 3: Call GetUserStatus API on each port until one works
        for (const port of ports) {
            try {
                const userStatus = await callGetUserStatus(port, processInfo.csrfToken);
                if (userStatus && userStatus.email) {
                    console.log(`[Claude Proxy] Found Antigravity account: ${userStatus.email}`);
                    currentIDEAccount = {
                        provider: 'antigravity',
                        email: userStatus.email,
                        plan: userStatus.plan
                    };
                    updateQuotaStatusBar();
                    return;
                }
            } catch (e) {
                // Try next port
            }
        }

        console.log('[Claude Proxy] Could not get user status from any port');
        currentIDEAccount = null;
    } catch (e) {
        console.log('[Claude Proxy] Could not fetch Antigravity account:', e.message);
        currentIDEAccount = null;
    } finally {
        ideAccountFetchInFlight = false;
    }
}

// Detect Antigravity language server process (Windows only - relies on wmic)
function detectAntigravityProcess() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(null);
            return;
        }
        exec('wmic process where "Name like \'%language_server%\'" get ProcessId,CommandLine /format:list',
            { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                resolve(parseWmicProcessList(stdout));
            }
        );
    });
}

// Get listening ports for a process (Windows)
function getProcessPorts(pid) {
    return new Promise((resolve) => {
        exec(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`,
            { timeout: 5000 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }
                resolve(parseListeningPorts(stdout, pid));
            }
        );
    });
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
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(parseUserStatusResponse(data));
                } catch (e) {
                    reject(e);
                }
            });
        };

        // Try HTTPS first
        const req = https.request(options, handleResponse);

        req.on('error', (e) => {
            if (e && e.message === 'Timeout') {
                reject(e);
                return;
            }
            // Try HTTP fallback
            const httpReq = http.request({ ...options, protocol: undefined }, handleResponse);
            httpReq.on('error', reject);
            httpReq.on('timeout', () => httpReq.destroy(new Error('Timeout')));
            httpReq.write(body);
            httpReq.end();
        });

        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.write(body);
        req.end();
    });
}

// ==================== QUOTA DATA ====================

function fetchProxyQuotaData() {
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
        proxyQuotaData = null;
        updateQuotaStatusBar();
    });
    req.on('timeout', () => req.destroy());
    req.end();
}

// ==================== CLAUDE CODE SETTINGS WATCHER ====================

// Kept for reference - intentionally not called (see activate()); per-window selection wins
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
            try {
                const json = JSON.parse(data);
                isProxyOnline = true;

                // Only accept proxy model on FIRST connect if no local model saved
                // This prevents multiple windows from overwriting each other's model
                if (json.model && json.model !== currentModel) {
                    const hasSavedModel = extensionContext && extensionContext.workspaceState.get(WINDOW_MODEL_KEY);
                    if (isFirstConnect && !hasSavedModel) {
                        console.log(`[Claude Proxy] First connect - using proxy model: ${json.model}`);
                        currentModel = json.model;
                    }
                    // Otherwise, keep local model - don't let proxy override
                }
                isFirstConnect = false;

                updateModelStatusBar();
                updateQuotaStatusBar();
            } catch (e) {
                isProxyOnline = false;
                updateModelStatusBar();
                updateQuotaStatusBar();
            }
        });
    });

    req.on('error', () => {
        isProxyOnline = false;
        updateModelStatusBar();
        updateQuotaStatusBar();
    });
    req.on('timeout', () => req.destroy());
    req.end();
}


function setModelOnProxy(model) {
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
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    currentModel = model;
                    // Save to workspaceState for per-window persistence
                    if (extensionContext) {
                        extensionContext.workspaceState.update(WINDOW_MODEL_KEY, model);
                        console.log(`[Claude Proxy] Saved session model: ${windowId.slice(0, 8)} -> ${model}`);
                    }
                    updateModelStatusBar();
                    vscode.window.showInformationMessage(`🧠 Model: ${getDisplayName(model)} (this window)`);
                    resolve();
                } else {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
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

function deactivate() {
    clearTimers();
    console.log('[Claude Proxy] Extension deactivated');
}

module.exports = { activate, deactivate };

