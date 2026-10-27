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

test('summarizeAccountLimits reports lowest pct and reset time per family', () => {
    const s = q.summarizeAccountLimits(sample.accounts[0].limits);
    assert.deepEqual(s, { claudePct: 50, geminiPct: 100, claudeReset: '2026-01-01T05:00:00Z', geminiReset: null });
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
