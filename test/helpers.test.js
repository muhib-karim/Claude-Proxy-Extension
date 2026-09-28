const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MODELS,
    getDisplayName,
    shortEmail,
    createSmallQuotaBar,
    formatResetTime,
    processQuotaData,
    summarizeAccountLimits,
    sortAccountsByClaudeQuota,
    parseWmicProcessList,
    parseListeningPorts,
    parseUserStatusResponse,
    buildPm2StartCommand,
} = require('../lib/helpers');

test('getDisplayName maps every switchable model to its menu label', () => {
    for (const { label, model } of MODELS) {
        assert.equal(getDisplayName(model), label, model);
    }
});

test('getDisplayName handles missing, haiku and unknown models', () => {
    assert.equal(getDisplayName(undefined), '❓');
    assert.equal(getDisplayName(''), '❓');
    assert.equal(getDisplayName('claude-haiku-4-5'), '📝 Haiku');
    assert.equal(getDisplayName('gpt-4o'), 'gpt-4o');
    assert.equal(getDisplayName('some-very-long-model-name'), 'some-very-lo...');
});

test('shortEmail returns the local part and tolerates missing values', () => {
    assert.equal(shortEmail('someone@example.com'), 'someone');
    assert.equal(shortEmail('no-at-sign'), 'no-at-sign');
    assert.equal(shortEmail(undefined), 'unknown');
    assert.equal(shortEmail(''), 'unknown');
});

test('createSmallQuotaBar always renders 10 blocks', () => {
    assert.equal(createSmallQuotaBar(0), '▱'.repeat(10));
    assert.equal(createSmallQuotaBar(100), '▰'.repeat(10));
    assert.equal(createSmallQuotaBar(50), '▰'.repeat(5) + '▱'.repeat(5));
    assert.equal(createSmallQuotaBar(34), '▰'.repeat(3) + '▱'.repeat(7));
    assert.equal(createSmallQuotaBar(35), '▰'.repeat(4) + '▱'.repeat(6));
});

test('createSmallQuotaBar clamps out-of-range input instead of throwing', () => {
    assert.equal(createSmallQuotaBar(105), '▰'.repeat(10));
    assert.equal(createSmallQuotaBar(-20), '▱'.repeat(10));
    assert.equal(createSmallQuotaBar(NaN), '▱'.repeat(10));
    assert.equal(createSmallQuotaBar(null), '▱'.repeat(10));
});

test('formatResetTime formats the remaining time relative to now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const at = (ms) => new Date(now.getTime() + ms);
    assert.equal(formatResetTime(at(-1000), now), 'soon');
    assert.equal(formatResetTime(at(0), now), 'soon');
    assert.equal(formatResetTime(at(30 * 1000), now), 'soon');
    assert.equal(formatResetTime(at(5 * 60 * 1000), now), 'in 5m');
    assert.equal(formatResetTime(at((2 * 60 + 15) * 60 * 1000), now), 'in 2h 15m');
    assert.equal(formatResetTime(new Date('not a date'), now), 'soon');
});

const SAMPLE_LIMITS = {
    totalAccounts: 3,
    accounts: [
        {
            email: 'alpha@example.com',
            status: 'ok',
            limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.2, resetTime: '2026-01-01T05:00:00Z' },
                'claude-sonnet-4-5-thinking': { remainingFraction: 0.6 },
                'gemini-3-pro-high': { remainingFraction: 1 },
                'gemini-3-flash': { remainingFraction: 0.9 },
            },
        },
        {
            email: 'beta@example.com',
            status: 'ok',
            limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.8 },
                'claude-sonnet-4-5-thinking': { remainingFraction: 0.75 },
                'gemini-3-pro-high': { remainingFraction: 0.4, resetTime: '2026-01-01T03:00:00Z' },
                'gpt-oss': { remainingFraction: 0.1 },
            },
        },
        {
            email: 'gamma@example.com',
            status: 'error',
            limits: { 'claude-opus-4-5-thinking': { remainingFraction: 0 } },
        },
    ],
};

test('processQuotaData returns an empty summary for missing or empty input', () => {
    for (const input of [null, undefined, {}, { accounts: [] }, { accounts: 'bad' }]) {
        const result = processQuotaData(input);
        assert.equal(result.claudeQuota, null);
        assert.equal(result.geminiQuota, null);
        assert.deepEqual(result.accounts, []);
        assert.deepEqual(result.claudeModels, []);
        assert.deepEqual(result.geminiModels, []);
        assert.equal(result.totalAccounts, 0);
    }
});

test('processQuotaData aggregates per family using the minimum across healthy accounts', () => {
    const result = processQuotaData(SAMPLE_LIMITS);

    // gamma (status "error") is ignored, so Claude minimum is alpha's opus at 20%
    assert.equal(result.claudeQuota, 20);
    assert.equal(result.geminiQuota, 40);
    assert.deepEqual(result.claudeModels, [
        { id: 'claude-opus-4-5-thinking', quota: 20 },
        { id: 'claude-sonnet-4-5-thinking', quota: 60 },
    ]);
    assert.deepEqual(result.geminiModels, [
        { id: 'gemini-3-flash', quota: 90 },
        { id: 'gemini-3-pro-high', quota: 40 },
    ]);
    assert.deepEqual(result.accounts.map(a => a.email), ['alpha@example.com', 'beta@example.com']);
    assert.equal(result.totalAccounts, 3);
});

test('processQuotaData falls back to the account count and skips null fractions', () => {
    const result = processQuotaData({
        accounts: [{ email: 'a@example.com', status: 'ok', limits: { 'claude-x': { remainingFraction: null } } }],
    });
    assert.equal(result.totalAccounts, 1);
    assert.equal(result.claudeQuota, null);
    assert.equal(result.accounts.length, 1);
});

test('summarizeAccountLimits picks the lowest percentage and reset time per family', () => {
    assert.deepEqual(summarizeAccountLimits(SAMPLE_LIMITS.accounts[0].limits), {
        claudePct: 20,
        geminiPct: 90,
        claudeReset: '2026-01-01T05:00:00Z',
        geminiReset: null,
    });
    // The reset time belongs to the model with the lowest quota, not the last model listed
    assert.deepEqual(summarizeAccountLimits({
        'claude-opus-4-5-thinking': { remainingFraction: 0.1, resetTime: '2026-01-01T01:00:00Z' },
        'claude-sonnet-4-5-thinking': { remainingFraction: 0.9, resetTime: '2026-01-02T09:00:00Z' },
    }), { claudePct: 10, geminiPct: null, claudeReset: '2026-01-01T01:00:00Z', geminiReset: null });
    assert.deepEqual(summarizeAccountLimits(undefined), {
        claudePct: null, geminiPct: null, claudeReset: null, geminiReset: null,
    });
});

test('sortAccountsByClaudeQuota puts accounts with the most Claude quota first', () => {
    const accounts = [
        { email: 'none@example.com', limits: { 'gemini-3-flash': { remainingFraction: 1 } } },
        ...processQuotaData(SAMPLE_LIMITS).accounts,
    ];
    const sorted = sortAccountsByClaudeQuota(accounts);
    assert.deepEqual(sorted.map(a => a.acc.email), ['beta@example.com', 'alpha@example.com', 'none@example.com']);
    assert.equal(sorted[0].claudePct, 75);
    assert.equal(sorted[2].claudePct, null);
});

test('parseWmicProcessList extracts pid and CSRF token of the language server', () => {
    const stdout = [
        '',
        'CommandLine=C:\\Windows\\other.exe --flag',
        'ProcessId=111',
        '',
        '',
        'CommandLine=C:\\Antigravity\\language_server_windows_x64.exe --csrf_token abc-123 --port 0',
        'ProcessId=4242',
        '',
    ].join('\r\n');
    assert.deepEqual(parseWmicProcessList(stdout), {
        pid: 4242,
        csrfToken: 'abc-123',
        commandLine: 'C:\\Antigravity\\language_server_windows_x64.exe --csrf_token abc-123 --port 0',
    });
    // Real wmic output piped to Node uses "\r\r\n" line endings; each record must stay separate
    const wmicRaw = [
        '',
        'CommandLine=C:\\Antigravity\\language_server_windows_x64.exe --csrf_token first-tok',
        'ProcessId=10',
        '',
        '',
        'CommandLine=C:\\Windows\\other.exe --flag',
        'ProcessId=20',
        '',
    ].join('\r\r\n');
    assert.deepEqual(parseWmicProcessList(wmicRaw), {
        pid: 10,
        csrfToken: 'first-tok',
        commandLine: 'C:\\Antigravity\\language_server_windows_x64.exe --csrf_token first-tok',
    });
    assert.equal(parseWmicProcessList('CommandLine=x.exe --csrf_token=tok\nProcessId=7').csrfToken, 'tok');
    assert.equal(parseWmicProcessList(''), null);
    assert.equal(parseWmicProcessList('CommandLine=x.exe\r\nProcessId=1\r\n'), null);
});

test('parseListeningPorts returns sorted unique LISTENING ports, filtered by exact PID', () => {
    const stdout = [
        '  TCP    127.0.0.1:53000        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:42100        0.0.0.0:0              LISTENING       4242',
        '  TCP    [::1]:42101            [::]:0                 LISTENING       4242',
        '  TCP    127.0.0.1:42100        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:4242         0.0.0.0:0              LISTENING       999',
        '  TCP    127.0.0.1:61000        0.0.0.0:0              LISTENING       42421',
        '  TCP    127.0.0.1:50000        127.0.0.1:4242         ESTABLISHED     4242',
    ].join('\r\n');
    assert.deepEqual(parseListeningPorts(stdout, 4242), [42100, 42101, 53000]);
    assert.deepEqual(parseListeningPorts(stdout), [4242, 42100, 42101, 53000, 61000]);
    assert.deepEqual(parseListeningPorts(''), []);
});

test('parseUserStatusResponse reads email and plan name', () => {
    const body = JSON.stringify({
        userStatus: { email: 'me@example.com', planStatus: { planInfo: { planName: 'pro', planDisplayName: 'Pro' } } },
    });
    assert.deepEqual(parseUserStatusResponse(body), { email: 'me@example.com', plan: 'Pro' });
    assert.deepEqual(parseUserStatusResponse(JSON.stringify({ userStatus: { email: 'x@example.com' } })), {
        email: 'x@example.com',
        plan: undefined,
    });
    assert.equal(parseUserStatusResponse('{}'), null);
    assert.throws(() => parseUserStatusResponse('<html>'), SyntaxError);
});

test('buildPm2StartCommand only restarts when no script path is configured', () => {
    assert.equal(buildPm2StartCommand(''), 'pm2 restart antigravity-proxy');
    assert.equal(buildPm2StartCommand('   '), 'pm2 restart antigravity-proxy');
    assert.equal(buildPm2StartCommand(undefined), 'pm2 restart antigravity-proxy');
});

test('buildPm2StartCommand appends a quoted pm2 start fallback for a configured path', () => {
    assert.equal(
        buildPm2StartCommand(' /opt/proxy dir/src/index.js '),
        'pm2 restart antigravity-proxy || pm2 start "/opt/proxy dir/src/index.js" --name antigravity-proxy'
    );
    assert.equal(
        buildPm2StartCommand('C:\\proxy\\src\\index.js'),
        'pm2 restart antigravity-proxy || pm2 start "C:\\proxy\\src\\index.js" --name antigravity-proxy'
    );
});

test('buildPm2StartCommand rejects paths that could inject shell syntax', () => {
    for (const bad of ['/x" && rm -rf / "', '/x/$(whoami).js', '/x/`id`.js', 'C:\\%PATH%\\a.js', '/x\n/y.js']) {
        assert.throws(() => buildPm2StartCommand(bad), /Invalid antigravity\.proxyScriptPath/, bad);
    }
});
