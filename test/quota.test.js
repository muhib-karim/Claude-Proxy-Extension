const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../lib/quota');

const sample = {
    totalAccounts: 3,
    accounts: [
        {
            email: 'alice@example.com', status: 'ok', limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.8, resetTime: '2026-01-01T05:00:00Z' },
                'claude-sonnet-4-5-thinking': { remainingFraction: 0.5 },
                'gemini-3-pro-high': { remainingFraction: 1 }
            }
        },
        {
            email: 'bob@example.com', status: 'ok', limits: {
                'claude-opus-4-5-thinking': { remainingFraction: 0.2 },
                'gemini-3-pro-high': { remainingFraction: 0.333 },
                'gemini-3-flash': { remainingFraction: null }
            }
        },
        { email: 'carol@example.com', status: 'error', limits: { 'claude-opus-4-5-thinking': { remainingFraction: 0 } } }
    ]
};

test('processQuotaData returns empty shape for missing/empty input', () => {
    for (const input of [null, undefined, {}, { accounts: [] }, { accounts: 'nope' }]) {
        const r = q.processQuotaData(input);
        assert.equal(r.claudeQuota, null);
        assert.equal(r.geminiQuota, null);
        assert.deepEqual(r.accounts, []);
        assert.deepEqual(r.claudeModels, []);
    }
});

test('processQuotaData takes the minimum per model and per family, skipping non-ok accounts', () => {
    const r = q.processQuotaData(sample);
    assert.equal(r.claudeQuota, 20);
    assert.equal(r.geminiQuota, 33);
    assert.deepEqual(r.claudeModels, [
        { id: 'claude-opus-4-5-thinking', quota: 20 },
        { id: 'claude-sonnet-4-5-thinking', quota: 50 }
    ]);
    assert.deepEqual(r.geminiModels, [{ id: 'gemini-3-pro-high', quota: 33 }]);
    assert.equal(r.accounts.length, 2);
    assert.equal(r.totalAccounts, 3);
});

test('processQuotaData falls back to accounts.length when totalAccounts is absent', () => {
    const r = q.processQuotaData({ accounts: sample.accounts });
    assert.equal(r.totalAccounts, 3);
});

test('summarizeAccountLimits reports the lowest pct per family with that model\'s reset time', () => {
    // Sonnet (50%, no reset time) is the lowest Claude model; Opus's reset time must not be shown next to 50%
    const s = q.summarizeAccountLimits(sample.accounts[0].limits);
    assert.deepEqual(s, { claudePct: 50, geminiPct: 100, claudeReset: null, geminiReset: null });

    // The reset time belongs to the model with the lowest quota, not to the last model listed
    assert.deepEqual(q.summarizeAccountLimits({
        'claude-opus-4-5-thinking': { remainingFraction: 0.1, resetTime: '2026-01-01T01:00:00Z' },
        'claude-sonnet-4-5-thinking': { remainingFraction: 0.9, resetTime: '2026-01-02T09:00:00Z' },
        'gemini-3-flash': { remainingFraction: 0.4, resetTime: '2026-01-01T03:00:00Z' },
        'gemini-3-pro-high': { remainingFraction: null, resetTime: '2026-01-05T00:00:00Z' }
    }), { claudePct: 10, geminiPct: 40, claudeReset: '2026-01-01T01:00:00Z', geminiReset: '2026-01-01T03:00:00Z' });

    // Two models tied for lowest: a known reset time is kept
    assert.deepEqual(q.summarizeAccountLimits({
        'claude-sonnet-4-5-thinking': { remainingFraction: 0.2 },
        'claude-opus-4-5-thinking': { remainingFraction: 0.2, resetTime: '2026-01-01T01:00:00Z' }
    }), { claudePct: 20, geminiPct: null, claudeReset: '2026-01-01T01:00:00Z', geminiReset: null });

    assert.deepEqual(q.summarizeAccountLimits(undefined), { claudePct: null, geminiPct: null, claudeReset: null, geminiReset: null });
});

test('sortAccountsByClaudeQuota puts the most available Claude quota first, unknowns last', () => {
    const accounts = [
        { email: 'none@x', limits: {} },
        { email: 'low@x', limits: { 'claude-a': { remainingFraction: 0.1 } } },
        { email: 'high@x', limits: { 'claude-a': { remainingFraction: 0.9 } } }
    ];
    assert.deepEqual(q.sortAccountsByClaudeQuota(accounts).map(a => a.acc.email), ['high@x', 'low@x', 'none@x']);
});

test('createSmallQuotaBar is always 10 segments and clamps out-of-range input', () => {
    assert.equal(q.createSmallQuotaBar(0), '▱'.repeat(10));
    assert.equal(q.createSmallQuotaBar(100), '▰'.repeat(10));
    assert.equal(q.createSmallQuotaBar(46), '▰'.repeat(5) + '▱'.repeat(5));
    for (const v of [-20, 150, NaN, undefined]) {
        assert.equal([...q.createSmallQuotaBar(v)].length, 10);
    }
});

test('formatResetTime formats hours/minutes relative to now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const at = ms => new Date(now.getTime() + ms);
    assert.equal(q.formatResetTime(at(2 * 3600e3 + 15 * 60e3), now), 'in 2h 15m');
    assert.equal(q.formatResetTime(at(5 * 60e3), now), 'in 5m');
    assert.equal(q.formatResetTime(at(30e3), now), 'soon');
    assert.equal(q.formatResetTime(at(-60e3), now), 'soon');
    assert.equal(q.formatResetTime(new Date('not a date'), now), 'soon');
});

test('getDisplayName maps model ids to friendly names', () => {
    assert.equal(q.getDisplayName('gemini-3-flash'), '⚡ Flash');
    assert.equal(q.getDisplayName('gemini-3-pro-high'), '💎 Pro');
    assert.equal(q.getDisplayName('claude-opus-4-5-thinking'), '🎭 Opus');
    assert.equal(q.getDisplayName('claude-sonnet-4-5-thinking'), '🎵 Sonnet');
    assert.equal(q.getDisplayName('claude-haiku-4-5'), '📝 Haiku');
    assert.equal(q.getDisplayName('pplx-grok'), '🌐 Grok');
    assert.equal(q.getDisplayName('sonar'), '🔍 Perplexity');
    assert.equal(q.getDisplayName(''), '❓');
    assert.equal(q.getDisplayName('short-model'), 'short-model');
    assert.equal(q.getDisplayName('some-very-long-model-id'), 'some-very-lo...');
});

test('every MODELS entry has a matching display name', () => {
    for (const m of q.MODELS) {
        assert.equal(q.getDisplayName(m.model), m.label, m.model);
    }
});

test('shortEmail strips the domain and tolerates missing values', () => {
    assert.equal(q.shortEmail('alice@example.com'), 'alice');
    assert.equal(q.shortEmail(undefined), 'unknown');
});

test('parseWmicOutput extracts pid and csrf token from list-format output', () => {
    const out = [
        '', '',
        'CommandLine=C:\\other.exe --foo',
        'ProcessId=111',
        '', '',
        'CommandLine=C:\\ls\\language_server_windows_x64.exe --csrf_token abc-123 --port 0',
        'ProcessId=4242',
        '', ''
    ].join('\r\n');
    const r = q.parseWmicOutput(out);
    assert.equal(r.pid, 4242);
    assert.equal(r.csrfToken, 'abc-123');
    assert.equal(q.parseWmicOutput(''), null);
    assert.equal(q.parseWmicOutput('CommandLine=x --csrf_token=t\r\n'), null); // no pid
    assert.equal(q.parseWmicOutput('CommandLine=x --csrf_token=t\r\nProcessId=7\r\n').csrfToken, 't');
});

test('parseWmicOutput keeps records apart when wmic ends lines with CR CR LF', () => {
    // Real `wmic ... /format:list` output piped to Node uses "\r\r\n" line endings
    const serverLine = 'CommandLine=C:\\ag\\language_server_windows_x64.exe --csrf_token first-tok';
    const raw = [
        '', serverLine, 'ProcessId=10', '', '',
        'CommandLine=C:\\tools\\lua-language-server.exe --stdio', 'ProcessId=20', ''
    ].join('\r\r\n');
    assert.deepEqual(q.parseWmicOutput(raw), {
        pid: 10,
        csrfToken: 'first-tok',
        commandLine: serverLine.substring('CommandLine='.length)
    });

    // Two token-bearing servers: the pid and the token must come from the same record
    const two = [
        '', 'CommandLine=C:\\ag\\language_server_windows_x64.exe --csrf_token tok-A', 'ProcessId=10', '', '',
        'CommandLine=C:\\ag\\language_server_windows_x64.exe --csrf_token tok-B', 'ProcessId=20', ''
    ].join('\r\r\n');
    const first = q.parseWmicOutput(two);
    assert.deepEqual({ pid: first.pid, csrfToken: first.csrfToken }, { pid: 10, csrfToken: 'tok-A' });

    assert.equal(q.parseWmicOutput('CommandLine=x.exe --csrf_token=tok\nProcessId=7').csrfToken, 'tok');
    assert.equal(q.parseWmicOutput('\r\r\n\r\r\n'), null);
});

test('parseNetstatPorts returns sorted unique listening ports (IPv4 and IPv6)', () => {
    const out = [
        '  TCP    127.0.0.1:53021        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:52999        0.0.0.0:0              LISTENING       4242',
        '  TCP    [::1]:53021            [::]:0                 LISTENING       4242',
        '  TCP    127.0.0.1:53021        127.0.0.1:60000        ESTABLISHED     4242'
    ].join('\r\n');
    assert.deepEqual(q.parseNetstatPorts(out), [52999, 53021]);
    assert.deepEqual(q.parseNetstatPorts(''), []);
});

test('parseNetstatPorts keeps only rows owned by the exact PID', () => {
    // `findstr "4242"` matches substrings, so its output also contains other processes' rows
    const out = [
        '  TCP    127.0.0.1:53000        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:42100        0.0.0.0:0              LISTENING       4242',
        '  TCP    [::1]:42101            [::]:0                 LISTENING       4242',
        '  TCP    127.0.0.1:42100        0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:4242         0.0.0.0:0              LISTENING       999',     // port 4242, pid 999
        '  TCP    127.0.0.1:61000        0.0.0.0:0              LISTENING       42421',   // pid 42421
        '  TCP    127.0.0.1:50000        127.0.0.1:4242         ESTABLISHED     4242'
    ].join('\r\n');
    assert.deepEqual(q.parseNetstatPorts(out, 4242), [42100, 42101, 53000]);
    assert.deepEqual(q.parseNetstatPorts(out, '4242'), [42100, 42101, 53000]);
    assert.deepEqual(q.parseNetstatPorts(out, 7), []);
    // Without a pid every listening port is returned
    assert.deepEqual(q.parseNetstatPorts(out), [4242, 42100, 42101, 53000, 61000]);
});

test('processQuotaData skips malformed account entries instead of throwing', () => {
    const r = q.processQuotaData({
        accounts: [
            null,
            'junk',
            { email: 'bad-limits@x', status: 'ok', limits: 'nope' },
            { email: 'ok@x', status: 'ok', limits: { 'claude-a': { remainingFraction: 0.4 } } }
        ]
    });
    assert.equal(r.claudeQuota, 40);
    assert.deepEqual(r.accounts.map(a => a.email), ['ok@x']);
});

test('non-numeric remaining fractions count as unknown, never NaN', () => {
    const r = q.processQuotaData({
        accounts: [{
            email: 'a@x', status: 'ok', limits: {
                'claude-a': { remainingFraction: 'abc' },
                'claude-b': { remainingFraction: '0.5' },
                'gemini-a': { remainingFraction: {} },
                'gemini-b': { remainingFraction: '' }
            }
        }]
    });
    assert.equal(r.claudeQuota, 50);
    assert.deepEqual(r.claudeModels, [{ id: 'claude-b', quota: 50 }]);
    assert.equal(r.geminiQuota, null);
    assert.deepEqual(q.summarizeAccountLimits({ 'claude-a': { remainingFraction: 'abc' } }),
        { claudePct: null, geminiPct: null, claudeReset: null, geminiReset: null });
});

test('getDisplayName tolerates non-string model values', () => {
    for (const value of [undefined, null, 123, {}, []]) {
        assert.equal(q.getDisplayName(value), '❓');
    }
});

test('sortAccountsByClaudeQuota tolerates a missing list and entries without limits', () => {
    assert.deepEqual(q.sortAccountsByClaudeQuota(undefined), []);
    assert.deepEqual(q.sortAccountsByClaudeQuota([{ email: 'a@x' }, null]).map(a => a.claudePct), [null, null]);
});

test('parseUserStatusResponse reads the email and plan name', () => {
    const body = JSON.stringify({
        userStatus: { email: 'me@example.com', planStatus: { planInfo: { planName: 'pro', planDisplayName: 'Pro' } } }
    });
    assert.deepEqual(q.parseUserStatusResponse(body), { email: 'me@example.com', plan: 'Pro' });
    assert.deepEqual(q.parseUserStatusResponse(JSON.stringify({ userStatus: { email: 'x@example.com' } })),
        { email: 'x@example.com', plan: undefined });
    assert.equal(q.parseUserStatusResponse('{}'), null);
    assert.equal(q.parseUserStatusResponse('null'), null);
    assert.throws(() => q.parseUserStatusResponse('<html>'), SyntaxError);
});
