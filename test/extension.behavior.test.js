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

// ---------- B4 / B17: language server requests must always settle ----------

// The language server listens on two ports; the lookup tries them in ascending order
const NETSTAT_TWO_PORTS = [
    '  TCP    127.0.0.1:53021        0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:53022        0.0.0.0:0              LISTENING       4242'
].join('\r\n');
const TLS_ERROR = () => Object.assign(new Error('wrong version number'), { code: 'EPROTO' });
const aliceStatus = languageServer()[GET_USER_STATUS];

test('every request the extension sends has a timeout handler', async () => {
    const up = proxyUp({ [GET_USER_STATUS]: aliceStatus });
    await withHarness({
        platform: 'win32', globalState: ENABLED, exec: windowsTools(),
        https: () => TLS_ERROR(),          // plain-HTTP port: the extension falls back to http
        http: up
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.requests('http', GET_USER_STATUS).length > 0, 'HTTP fallback request');
        await h.settle();
        const missing = h.state.requests.filter((r) => !r.hasTimeoutHandler).map((r) => `${r.kind} ${r.path}`);
        assert.deepEqual(missing, []);
    });
});

test('a silent HTTP fallback port does not hang the account lookup', async () => {
    const up = proxyUp();
    await withHarness({
        platform: 'win32', globalState: ENABLED, exec: windowsTools({ netstat: NETSTAT_TWO_PORTS }),
        https: (record) => (record.port === 53021 ? TLS_ERROR() : aliceStatus),
        http: (record) => (record.path === GET_USER_STATUS ? 'timeout' : up[record.path])
    }, async (h) => {
        h.activate();
        // Port 53021 never answers the fallback; the lookup must give up on it and try 53022
        await h.waitFor(() => h.quotaItem.text === '$(account) alice', 'account found on the second port');
    });
});

test('after an HTTPS timeout the token is not re-sent over plain HTTP', async () => {
    await withHarness({
        platform: 'win32', globalState: ENABLED, exec: windowsTools(), http: proxyUp(),
        https: { [GET_USER_STATUS]: 'timeout' }
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.requests('https', GET_USER_STATUS).some((r) => r.destroyed), 'HTTPS request timed out');
        await h.settle();
        assert.equal(h.requests('http', GET_USER_STATUS).length, 0);
    });
});

test('a language server response that is cut off mid-body does not hang the account lookup', async () => {
    await withHarness({
        platform: 'win32', globalState: ENABLED, exec: windowsTools({ netstat: NETSTAT_TWO_PORTS }), http: proxyUp(),
        https: (record) => (record.port === 53021 ? { body: '{"userStatus":', abort: true } : aliceStatus)
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.quotaItem.text === '$(account) alice', 'account found on the second port');
    });
});

test('a model switch settles when the proxy drops the connection mid-response', async () => {
    await withHarness({
        globalState: ENABLED,
        http: proxyUp({ '/session-model': { body: '{"ok":', abort: true } }),
        pick: (items) => items.find((i) => i.model === 'claude-opus-4-5-thinking')
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');
        const outcome = await Promise.race([
            h.command('antigravity.switchModel').then(() => 'settled', () => 'settled'),
            h.settle(200).then(() => 'pending')
        ]);
        assert.equal(outcome, 'settled', 'the command must not stay pending forever');
        assert.equal(h.modelItem.text, '⚡ Flash', 'the model is unchanged');
        assert.ok(h.messages('error').some((m) => m.startsWith('Failed to switch model')));
    });
});

// ---------- B5 / B6 / B15: PM2 control and model switching ----------

const OPUS = 'claude-opus-4-5-thinking';
const pickModel = (model) => (items) => items.find((i) => i.model === model);
const pickToggle = (items) => items[0];
const pm2Commands = (h) => h.execs('pm2').map((e) => e.command);

test('offline: picking a model restarts the proxy, waits until it answers, then sets the model', async () => {
    const routes = proxyUp();
    let phase = 'down';             // 'down' -> 'starting' -> 'up'
    let probesWhileStarting = 0;
    await withHarness({
        globalState: ENABLED, fastTimers: true, pick: pickModel(OPUS),
        exec: (command) => (command.startsWith('pm2') ? 'ok' : null),
        http: (record) => {
            if (phase === 'up') return routes[record.path];
            if (phase === 'starting' && record.path === '/health' && ++probesWhileStarting >= 3) {
                phase = 'up';       // the proxy needs a moment after `pm2 restart` returns
                return routes['/health'];
            }
            return 'refuse';
        }
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.modelItem.text, '$(warning) Offline');

        phase = 'starting';
        await h.command('antigravity.switchModel');

        assert.deepEqual([...new Set(pm2Commands(h))], ['pm2 restart antigravity-proxy'],
            'no machine-specific script path in the command');
        const post = h.requests('http', '/session-model').at(-1);
        assert.ok(post, 'the model is sent once the proxy answers');
        assert.deepEqual(JSON.parse(post.body), {
            model: OPUS,
            sessionId: h.context.workspaceState.get('antigravity.windowId'),
            name: 'test-workspace'
        });
        assert.equal(h.context.workspaceState.get('antigravity.windowModel'), OPUS);
        assert.deepEqual(h.messages('error'), []);
        assert.deepEqual(h.state.unhandledRejections, []);
        await h.waitFor(() => h.modelItem.text === '🎭 Opus', 'model shown after the proxy came up');
    });
});

test('offline: a proxy that never comes up gives an error message, not an unhandled rejection', async () => {
    await withHarness({
        globalState: ENABLED, fastTimers: true, pick: pickModel(OPUS), http: {},
        exec: (command) => (command.startsWith('pm2') ? 'ok' : null)
    }, async (h) => {
        h.activate();
        await h.settle();
        const probesBefore = h.requests('http', '/health').length;

        await h.command('antigravity.switchModel');
        await h.settle();

        assert.equal(h.requests('http', '/health').length - probesBefore, 20, 'readiness wait is bounded');
        assert.equal(h.requests('http', '/session-model').length, 0);
        assert.equal(h.messages('error').length, 1);
        assert.match(h.messages('error')[0], /not responding/);
        assert.ok(!h.messages('info').some((m) => m.includes('Proxy started')), 'no success toast');
        assert.deepEqual(h.state.unhandledRejections, []);
    });
});

test('offline: a PM2 failure is reported and nothing is sent to the proxy', async () => {
    await withHarness({ globalState: ENABLED, pick: pickModel(OPUS), http: {}, exec: () => null }, async (h) => {
        h.activate();
        await h.settle();
        await h.command('antigravity.switchModel');
        assert.equal(h.messages('error').length, 1);
        assert.match(h.messages('error')[0], /Failed to start proxy/);
        assert.equal(h.requests('http', '/session-model').length, 0);
    });
});

test('the pm2 start fallback uses antigravity.proxyScriptPath and rejects unsafe values', async () => {
    await withHarness({
        globalState: ENABLED, fastTimers: true, pick: pickModel(OPUS), http: {},
        config: { 'antigravity.proxyScriptPath': '/opt/proxy/src/index.js' },
        exec: () => null
    }, async (h) => {
        h.activate();
        await h.settle();
        await h.command('antigravity.switchModel');
        assert.deepEqual([...new Set(pm2Commands(h))],
            ['pm2 restart antigravity-proxy || pm2 start "/opt/proxy/src/index.js" --name antigravity-proxy']);
    });

    await withHarness({
        globalState: ENABLED, pick: pickModel(OPUS), http: {},
        config: { 'antigravity.proxyScriptPath': '/x/$(whoami).js' },
        exec: () => 'ok'
    }, async (h) => {
        h.activate();
        await h.settle();
        await h.command('antigravity.switchModel');
        assert.deepEqual(pm2Commands(h), [], 'nothing is executed for an unsafe path');
        assert.match(h.messages('error')[0], /antigravity\.proxyScriptPath/);
    });
});

test('online: a failed model switch shows an error and keeps the current model', async () => {
    await withHarness({
        globalState: ENABLED, pick: pickModel(OPUS),
        http: proxyUp({ '/session-model': { status: 500, body: '' } })
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');

        await h.command('antigravity.switchModel');     // must not reject

        assert.deepEqual(h.messages('error'), ['Failed to switch model: HTTP 500']);
        assert.equal(h.modelItem.text, '⚡ Flash');
        assert.equal(h.context.workspaceState.get('antigravity.windowModel'), undefined);
        assert.deepEqual(h.state.unhandledRejections, []);
    });
});

test('online: a successful switch posts this window\'s session id and persists the model', async () => {
    await withHarness({ globalState: ENABLED, pick: pickModel(OPUS), http: proxyUp() }, async (h) => {
        h.activate();
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');
        await h.command('antigravity.switchModel');

        const post = h.requests('http', '/session-model').at(-1);
        assert.equal(post.method, 'POST');
        assert.deepEqual(JSON.parse(post.body), {
            model: OPUS,
            sessionId: h.context.workspaceState.get('antigravity.windowId'),
            name: 'test-workspace'
        });
        assert.equal(h.context.workspaceState.get('antigravity.windowModel'), OPUS);
        assert.equal(h.modelItem.text, '🎭 Opus');

        // Later polls must not replace the window's own model with the proxy's global one
        h.tickIntervals(5000);
        await h.settle();
        assert.equal(h.modelItem.text, '🎭 Opus');
    });
});

test('PM2 commands run with a timeout and without a console window', async () => {
    await withHarness({ globalState: ENABLED, pick: pickModel(OPUS), http: {}, exec: () => null }, async (h) => {
        h.activate();           // proxy down: activation tries to start it
        await h.settle();
        await h.command('antigravity.switchModel');
        const pm2Execs = h.execs('pm2');
        assert.ok(pm2Execs.length >= 2);
        for (const { command, options } of pm2Execs) {
            assert.ok(options.timeout > 0, `${command} has a timeout`);
            assert.equal(options.windowsHide, true, `${command} hides the console window`);
        }
    });
});

test('disabling an online proxy stops it via PM2 and reports a failure honestly', async () => {
    for (const [pm2Result, level, pattern] of [['ok', 'info', /Proxy stopped/], [null, 'warning', /could not stop/i]]) {
        await withHarness({
            globalState: ENABLED, pick: pickToggle, http: proxyUp(),
            exec: (command) => (command.startsWith('pm2') ? pm2Result : null)
        }, async (h) => {
            h.activate();
            await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');
            await h.command('antigravity.switchModel');
            await h.settle();

            assert.deepEqual(pm2Commands(h), ['pm2 stop antigravity-proxy']);
            assert.equal(h.context.globalState.get('antigravity.proxyEnabled'), false);
            assert.equal(h.modelItem.text, '$(debug-stop) Disabled');
            assert.equal(h.quotaItem.tooltip, 'Proxy disabled');
            assert.equal(h.messages(level).length, 1, `one ${level} message`);
            assert.match(h.messages(level)[0], pattern);
            assert.equal(h.messages().length, 1, 'no other message');
        });
    }
});

test('enabling the proxy starts it via PM2; a failure names the setting, not a Windows script', async () => {
    await withHarness({ pick: pickToggle, http: {}, exec: () => null }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.modelItem.text, '$(debug-stop) Disabled');

        await h.command('antigravity.switchModel');
        await h.settle();

        assert.equal(h.context.globalState.get('antigravity.proxyEnabled'), true);
        assert.deepEqual(pm2Commands(h), ['pm2 restart antigravity-proxy']);
        const warnings = h.messages('warning');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /antigravity\.proxyScriptPath/);
        assert.doesNotMatch(warnings[0], /\.bat/);
    });
});

// ---------- B7: activation must not restart a proxy that is only slow ----------

test('a slow /health answer at activation does not restart the proxy', async () => {
    await withHarness({
        globalState: ENABLED, http: proxyUp({ '/health': 'timeout' }), exec: () => 'ok'
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.requests('http', '/health').some((r) => r.destroyed), 'health check timed out');
        await h.settle();
        assert.deepEqual(pm2Commands(h), [], 'slow is not down: restarting would drop every window\'s requests');
    });
});

test('a refused /health connection at activation restarts the proxy exactly once', async () => {
    await withHarness({ globalState: ENABLED, http: {}, exec: () => 'ok' }, async (h) => {
        h.activate();
        await h.settle();
        assert.deepEqual(pm2Commands(h), ['pm2 restart antigravity-proxy']);
    });
});

test('the /health response at activation is drained so the socket is released', async () => {
    await withHarness({ globalState: ENABLED, http: proxyUp() }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.requests('http', '/health')[0].resumed, true);
        assert.deepEqual(pm2Commands(h), []);
    });
});

// ---------- B8 / B10: polling and account lookups ----------

test('nothing is polled or spawned while the proxy is disabled', async () => {
    await withHarness({
        platform: 'win32', http: proxyUp(), https: languageServer(), exec: windowsTools()
    }, async (h) => {
        h.activate();
        await h.settle();
        h.tickIntervals();          // the 5 s proxy poll and the 60 s account poll
        h.fireWindowState(true);
        h.fireAuthChange();
        await h.settle();

        assert.deepEqual(h.state.requests.map((r) => `${r.kind} ${r.path}`), []);
        assert.deepEqual(h.state.execs.map((e) => e.command), []);
        assert.equal(h.modelItem.text, '$(debug-stop) Disabled');
        assert.equal(h.quotaItem.tooltip, 'Proxy disabled');
    });
});

test('on Linux and macOS no Windows tools are spawned for the account lookup', async () => {
    for (const platform of ['linux', 'darwin']) {
        await withHarness({ platform, globalState: ENABLED, http: proxyUp(), exec: () => null }, async (h) => {
            h.activate();
            await h.settle();
            h.tickIntervals(60000);
            h.fireWindowState(true);
            h.fireAuthChange();
            await h.settle();

            assert.deepEqual(h.state.execs.map((e) => e.command), [], platform);
            assert.equal(h.modelItem.text, '⚡ Flash');
            assert.equal(h.quotaItem.text, '$(account)');
        });
    }
});

test('account lookups never overlap; events during a lookup cause exactly one follow-up', async () => {
    await withHarness({
        platform: 'win32', globalState: ENABLED, http: proxyUp(), https: languageServer(), exec: windowsTools()
    }, async (h) => {
        h.activate();               // lookup #1 starts (wmic is running)
        h.fireWindowState(true);    // three more triggers while it runs
        h.fireWindowState(true);
        h.fireAuthChange();
        assert.equal(h.execs('wmic').length, 1, 'no second wmic while one is running');

        await h.waitFor(() => h.execs('wmic').length === 2, 'one follow-up lookup');
        await h.settle();
        assert.equal(h.execs('wmic').length, 2, 'and only one');
        assert.equal(h.quotaItem.text, '$(account) alice');

        h.fireWindowState(false);   // losing focus is not a trigger
        await h.settle();
        assert.equal(h.execs('wmic').length, 2);
    });
});

test('a proxy poll never overlaps the previous one', async () => {
    await withHarness({
        globalState: ENABLED,
        http: proxyUp({ '/active-model': 'hold', '/account-limits': 'hold' })
    }, async (h) => {
        h.activate();
        await h.settle();
        h.tickIntervals(5000);
        h.tickIntervals(5000);
        await h.settle();
        assert.equal(h.requests('http', '/active-model').length, 1);
        assert.equal(h.requests('http', '/account-limits').length, 1);

        // Once the slow answers arrive, polling carries on
        h.release(h.requests('http', '/active-model')[0], { body: '{"model":"gemini-3-flash"}' });
        h.release(h.requests('http', '/account-limits')[0], { body: JSON.stringify(ACCOUNT_LIMITS) });
        await h.settle();
        assert.equal(h.modelItem.text, '⚡ Flash');
        h.tickIntervals(5000);
        await h.settle();
        assert.equal(h.requests('http', '/active-model').length, 2);
        assert.equal(h.requests('http', '/account-limits').length, 2);
    });
});

test('a poll that times out does not block the next poll', async () => {
    await withHarness({
        globalState: ENABLED,
        http: proxyUp({ '/active-model': 'timeout', '/account-limits': 'timeout' })
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.modelItem.text, '$(warning) Offline');
        h.tickIntervals(5000);
        await h.settle();
        assert.equal(h.requests('http', '/active-model').length, 2);
        assert.equal(h.requests('http', '/account-limits').length, 2);
    });
});

test('enabling the proxy refreshes its state as soon as it answers', async () => {
    await withHarness({
        pick: pickToggle, http: proxyUp(), exec: (command) => (command.startsWith('pm2') ? 'ok' : null)
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.deepEqual(h.state.requests, []);

        await h.command('antigravity.switchModel');
        // No timer tick: the refresh must come from enabling itself
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'state refreshed after enabling');
        await h.waitFor(() => h.requests('http', '/account-limits').length >= 1, 'quota fetched after enabling');
    });
});

test('disabling forgets the online state, so a later enable does not show a stale model', async () => {
    let proxyRunning = true;
    const routes = proxyUp();
    await withHarness({
        globalState: ENABLED, pick: pickToggle,
        http: (record) => (proxyRunning ? routes[record.path] : 'refuse'),
        exec: (command) => (command === 'pm2 stop antigravity-proxy' ? 'ok' : null)
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');

        await h.command('antigravity.switchModel');     // disable: pm2 stop
        await h.settle();
        proxyRunning = false;
        assert.equal(h.modelItem.text, '$(debug-stop) Disabled');

        const enabling = h.command('antigravity.switchModel');  // enable: pm2 restart fails, proxy stays down
        await h.settle(2);
        assert.notEqual(h.modelItem.text, '⚡ Flash', 'the stopped proxy must not look online');
        await enabling;
        await h.settle();
        assert.equal(h.modelItem.text, '$(warning) Offline');
    });
});

// ---------- B11: what counts as "online" ----------

test('an answer on port 8080 that is not HTTP 200 does not count as the proxy being online', async () => {
    await withHarness({
        globalState: ENABLED,
        http: {
            '/health': { body: '{}' },
            '/active-model': { status: 404, body: '{"error":"not found"}' },
            '/account-limits': { status: 404, body: '{"error":"not found"}' }
        }
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.modelItem.text, '$(warning) Offline');
        assert.equal(h.quotaItem.text, '$(account) Offline');
    });
});

test('a non-string model reported by the proxy is ignored', async () => {
    await withHarness({
        globalState: ENABLED, http: proxyUp({ '/active-model': { body: '{"model":{"id":1}}' } })
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.equal(h.modelItem.text, 'unknown', 'online, but no model adopted');
        assert.doesNotMatch(String(h.modelItem.tooltip), /\[object/);
    });
});

// ---------- B13: quota popup states ----------

const popupLabels = async (h) => {
    await h.command('antigravity.showQuotaInfo');
    return h.state.quickPicks.at(-1).items.map((i) => i.label);
};

test('the quota popup says why there is no data instead of loading forever', async () => {
    await withHarness({ http: proxyUp() }, async (h) => {          // disabled
        h.activate();
        await h.settle();
        const labels = await popupLabels(h);
        assert.ok(labels.some((l) => l.includes('Proxy disabled')), labels.join(' | '));
        assert.ok(!labels.some((l) => l.includes('Loading')));
    });
    await withHarness({ globalState: ENABLED, http: {} }, async (h) => {   // enabled, proxy down
        h.activate();
        await h.settle();
        const labels = await popupLabels(h);
        assert.ok(labels.some((l) => l.includes('Proxy offline')), labels.join(' | '));
        assert.ok(!labels.some((l) => l.includes('Loading')));
    });
    await withHarness({                                             // online, quota still on its way
        globalState: ENABLED, http: proxyUp({ '/account-limits': 'hold' })
    }, async (h) => {
        h.activate();
        await h.settle();
        assert.ok((await popupLabels(h)).some((l) => l.includes('Loading quota data')));
    });
    await withHarness({ globalState: ENABLED, http: proxyUp() }, async (h) => {   // online with data
        h.activate();
        await h.settle();
        const labels = await popupLabels(h);
        assert.ok(labels.includes('🟠 Claude: ▰▰▱▱▱▱▱▱▱▱ 20%'), labels.join(' | '));
        assert.ok(labels.includes('💎 Gemini: ▰▰▰▰▰▱▱▱▱▱ 50%'));
        assert.deepEqual(labels.filter((l) => l.startsWith('👤')), ['👤 beta', '👤 alpha']);
    });
});

// ---------- B14: nothing happens after deactivation ----------

test('a model switch answered after deactivation shows nothing and touches no UI', async () => {
    await withHarness({
        globalState: ENABLED, pick: pickModel(OPUS), http: proxyUp({ '/session-model': 'hold' })
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.modelItem.text === '⚡ Flash', 'proxy online');
        const pending = h.command('antigravity.switchModel');
        await h.waitFor(() => h.requests('http', '/session-model').length === 1, 'switch request sent');

        h.shutdown();
        const item = h.state.statusBarItems.find((i) => i.command === 'antigravity.switchModel');
        const textAtShutdown = item.text;
        h.release(h.requests('http', '/session-model')[0], { body: '{"ok":true}' });
        await pending;
        await h.settle();

        assert.deepEqual(h.messages(), []);
        assert.equal(item.text, textAtShutdown);
    });
});

test('deactivating during the readiness wait ends it without a message', async () => {
    await withHarness({
        globalState: ENABLED, pick: pickModel(OPUS),
        http: { '/health': 'hold' },                                 // the proxy never answers the probe
        exec: (command) => (command.startsWith('pm2') ? 'ok' : null)
    }, async (h) => {
        h.activate();
        await h.settle();
        const pending = h.command('antigravity.switchModel');
        await h.waitFor(() => h.requests('http', '/health').length === 2, 'first readiness probe');

        h.shutdown();
        for (const probe of h.requests('http', '/health')) h.release(probe, 'refuse');
        await pending;
        await h.settle();

        assert.equal(h.requests('http', '/health').length, 2, 'no further probes after deactivation');
        assert.deepEqual(h.messages(), []);
    });
});

// ---------- B16: privacy ----------

test('the signed-in e-mail address is not written to the log', async () => {
    await withHarness({
        platform: 'win32', globalState: ENABLED, http: proxyUp(), https: languageServer(), exec: windowsTools()
    }, async (h) => {
        h.activate();
        await h.waitFor(() => h.quotaItem.text === '$(account) alice', 'account found');
        assert.ok(h.state.logs.some((l) => l.includes('Found Antigravity account')));
        assert.deepEqual(h.state.logs.filter((l) => l.includes('alice@example.com')), []);
    });
});
