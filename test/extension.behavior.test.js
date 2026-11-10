// Behaviour and regression tests for extension.js, run on the hermetic harness
// (no real VS Code, proxy, PM2 or Windows tools).
const test = require('node:test');
const assert = require('node:assert/strict');
const { withHarness } = require('./support/harness');

const ENABLED = { 'antigravity.proxyEnabled': true };
const GET_USER_STATUS = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

const ACCOUNT_LIMITS = {
    totalAccounts: 2,
    accounts: [
        {
            email: 'alpha@example.com', status: 'ok', limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.2 },
                'gemini-3-flash': { remainingFraction: 0.9 }
            }
        },
        {
            email: 'beta@example.com', status: 'ok', limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.8 },
                'gemini-3-flash': { remainingFraction: 0.5 }
            }
        }
    ]
};

// Routes of a healthy proxy on localhost:8080
const proxyUp = (overrides = {}) => ({
    '/health': { body: '{"status":"ok"}' },
    '/active-model': { body: '{"model":"gemini-3-flash"}' },
    '/account-limits': { body: JSON.stringify(ACCOUNT_LIMITS) },
    '/session-model': { body: '{"ok":true}' },
    ...overrides
});

// What `wmic` and `netstat` print for an Antigravity language server with pid 4242 on port 53021
const WMIC = [
    '',
    'CommandLine=C:\\ag\\language_server_windows_x64.exe --csrf_token tok-1 --port 0',
    'ProcessId=4242',
    ''
].join('\r\r\n');
const NETSTAT = '  TCP    127.0.0.1:53021        0.0.0.0:0              LISTENING       4242\r\n';

const windowsTools = ({ wmic = WMIC, netstat = NETSTAT, pm2 = 'ok' } = {}) => (command) => {
    if (command.startsWith('wmic')) return wmic;
    if (command.startsWith('netstat')) return netstat;
    if (command.startsWith('pm2')) return pm2;
    return null;
};

const languageServer = (email = 'alice@example.com') => ({
    [GET_USER_STATUS]: { body: JSON.stringify({ userStatus: { email, planStatus: { planInfo: { planName: 'pro' } } } }) }
});

// ---------- B1: account item / shadowed shortEmail ----------

test('the signed-in Antigravity account is shown in the account item', async () => {
    await withHarness({
        platform: 'win32', globalState: ENABLED, http: proxyUp(), https: languageServer(), exec: windowsTools()
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.quotaItem.text === '$(account) alice', 'account name in the status bar');
        assert.equal(h.modelItem.text, '⚡ Flash');
    });
});

test('a known account never makes a healthy proxy look offline', async () => {
    let online = false;
    const up = proxyUp();
    await withHarness({
        platform: 'win32', globalState: ENABLED,
        http: (record) => (online ? up[record.path] : 'refuse'),
        https: languageServer(), exec: windowsTools()
    }, async (h) => {
        h.activate();   // the account is looked up while the proxy is still down
        await h.waitFor(() => h.requests('https', GET_USER_STATUS).length > 0, 'account lookup');
        await h.settle();
        assert.equal(h.modelItem.text, '$(warning) Offline');

        online = true;  // the proxy comes up; the next 5 s poll must see it
        h.tickIntervals(5000);
        await h.waitFor(() => h.modelItem.text !== '$(warning) Offline', 'proxy shown as online');
        assert.equal(h.modelItem.text, '⚡ Flash');
        assert.equal(h.quotaItem.text, '$(account) alice');
    });
});

// ---------- B2: CSRF token must only go to the language server's own ports ----------

test('the CSRF token is only sent to ports owned by the language server PID', async () => {
    // What `netstat -ano | findstr "4242"` really returns: findstr matches substrings
    const netstat = [
        '  TCP    127.0.0.1:53000        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:4242         0.0.0.0:0              LISTENING       999',
        '  TCP    127.0.0.1:61000        0.0.0.0:0              LISTENING       42421'
    ].join('\r\n');
    await withHarness({
        platform: 'win32', globalState: ENABLED, http: proxyUp(), https: {}, exec: windowsTools({ netstat })
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.requests('https', GET_USER_STATUS).length > 0, 'account lookup');
        await h.settle();
        const tokenPorts = [...new Set(
            h.state.requests.filter((r) => r.headers['X-Codeium-Csrf-Token']).map((r) => r.port)
        )].sort((a, b) => a - b);
        assert.deepEqual(tokenPorts, [53000]);
    });
});
