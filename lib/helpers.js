// Pure helpers used by extension.js. This module must not require('vscode') so it can be
// unit-tested with plain Node (see test/helpers.test.js).

// Available models for quick switching
const MODELS = [
    { label: '⚡ Flash', model: 'gemini-3-flash', description: 'Fast tasks' },
    { label: '💎 Pro', model: 'gemini-3-pro-high', description: 'Complex coding' },
    { label: '🎭 Opus', model: 'claude-opus-4-5-thinking', description: 'Deep reasoning' },
    { label: '🎵 Sonnet', model: 'claude-sonnet-4-5-thinking', description: 'Balanced' },
    { label: '🌐 Grok', model: 'pplx-grok', description: 'With web search' },
    { label: '🔍 Perplexity', model: 'sonar', description: 'Search focused' },
];

const PM2_PROCESS_NAME = 'antigravity-proxy';

// ==================== DISPLAY ====================

function getDisplayName(model) {
    if (!model) return '❓';
    const m = model.toLowerCase();
    if (m.includes('flash')) return '⚡ Flash';
    if (m.includes('pro')) return '💎 Pro';
    if (m.includes('opus')) return '🎭 Opus';
    if (m.includes('sonnet')) return '🎵 Sonnet';
    if (m.includes('haiku')) return '📝 Haiku';
    if (m.includes('grok')) return '🌐 Grok';
    if (m.includes('pplx') || m.includes('sonar')) return '🔍 Perplexity';
    return model.length > 15 ? model.substring(0, 12) + '...' : model;
}

// Local part of an email address ("name@example.com" -> "name"); tolerates missing values
function shortEmail(email) {
    if (typeof email !== 'string' || email === '') return 'unknown';
    return email.split('@')[0];
}

function createSmallQuotaBar(percent) {
    // Clamp so out-of-range values (e.g. remainingFraction > 1) cannot make String.repeat throw
    const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
    const filled = Math.round(clamped / 10);
    const empty = 10 - filled;
    // Use same-size block characters: ▰ for filled, ▱ for empty
    const filledChar = '▰';
    const emptyChar = '▱';
    return filledChar.repeat(filled) + emptyChar.repeat(empty);
}

function formatResetTime(resetDate, now = new Date()) {
    const diff = resetDate.getTime() - now.getTime();

    if (!(diff > 0)) {
        return 'soon';
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `in ${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `in ${minutes}m`;
    } else {
        return 'soon';
    }
}

// ==================== QUOTA DATA ====================

// Process quota data from the proxy's /account-limits endpoint - aggregate by model family
function processQuotaData(json) {
    if (!json || !Array.isArray(json.accounts) || json.accounts.length === 0) {
        return {
            claudeQuota: null,
            geminiQuota: null,
            claudeModels: [],
            geminiModels: [],
            accounts: [],
            totalAccounts: 0
        };
    }

    const accounts = json.accounts;
    const modelQuotas = {}; // { modelId: [pct1, pct2, ...] }
    const accountSummaries = [];

    for (const acc of accounts) {
        if (!acc || acc.status !== 'ok' || !acc.limits) continue;

        for (const [modelId, info] of Object.entries(acc.limits)) {
            if (info && info.remainingFraction !== undefined && info.remainingFraction !== null) {
                const pct = Math.round(info.remainingFraction * 100);
                if (!modelQuotas[modelId]) modelQuotas[modelId] = [];
                modelQuotas[modelId].push(pct);
            }
        }

        accountSummaries.push({
            email: acc.email,
            limits: acc.limits
        });
    }

    // Aggregate by family - use MINIMUM across accounts (conservative)
    let claudeQuota = null;
    let geminiQuota = null;
    const claudeModels = [];
    const geminiModels = [];

    for (const [modelId, pcts] of Object.entries(modelQuotas)) {
        const minPct = Math.min(...pcts);

        if (modelId.includes('claude')) {
            claudeModels.push({ id: modelId, quota: minPct });
            if (claudeQuota === null || minPct < claudeQuota) {
                claudeQuota = minPct;
            }
        } else if (modelId.includes('gemini')) {
            geminiModels.push({ id: modelId, quota: minPct });
            if (geminiQuota === null || minPct < geminiQuota) {
                geminiQuota = minPct;
            }
        }
    }

    return {
        claudeQuota: claudeQuota,
        geminiQuota: geminiQuota,
        claudeModels: claudeModels.sort((a, b) => a.id.localeCompare(b.id)),
        geminiModels: geminiModels.sort((a, b) => a.id.localeCompare(b.id)),
        accounts: accountSummaries,
        totalAccounts: json.totalAccounts || accounts.length
    };
}

// Lowest remaining Claude/Gemini percentage (and latest reset time seen) for one account's limits
function summarizeAccountLimits(limits) {
    // Lowest remaining quota per family, paired with the reset time of that same model
    const claude = { pct: null, reset: null };
    const gemini = { pct: null, reset: null };

    for (const [modelId, info] of Object.entries(limits || {})) {
        if (!info || info.remainingFraction === undefined || info.remainingFraction === null) continue;
        const family = modelId.includes('claude') ? claude : modelId.includes('gemini') ? gemini : null;
        if (!family) continue;
        const pct = Math.round(info.remainingFraction * 100);
        if (family.pct === null || pct < family.pct) {
            family.pct = pct;
            family.reset = info.resetTime || null;
        }
    }

    return { claudePct: claude.pct, geminiPct: gemini.pct, claudeReset: claude.reset, geminiReset: gemini.reset };
}

// Summarize each account and sort by Claude quota descending (accounts with Claude available at top)
function sortAccountsByClaudeQuota(accounts) {
    const accountsWithQuota = (accounts || []).map(acc => ({ acc, ...summarizeAccountLimits(acc.limits) }));
    accountsWithQuota.sort((a, b) => {
        const aPct = a.claudePct !== null ? a.claudePct : -1;
        const bPct = b.claudePct !== null ? b.claudePct : -1;
        return bPct - aPct;  // Descending
    });
    return accountsWithQuota;
}

// ==================== ANTIGRAVITY LANGUAGE SERVER ====================

// Parse `wmic process ... get ProcessId,CommandLine /format:list` output and return the
// first language server process that carries a CSRF token
function parseWmicProcessList(stdout) {
    if (!stdout || stdout.trim() === '') return null;

    // wmic separates records with blank lines and often ends lines with "\r\r\n"
    const entries = stdout.split(/(?:\r*\n){2,}/).filter(block => block.trim());
    for (const entry of entries) {
        const lines = entry.split(/\r*\n/).map(l => l.trim()).filter(Boolean);
        let commandLine = '';
        let pid = 0;

        for (const line of lines) {
            if (line.startsWith('CommandLine=')) {
                commandLine = line.substring('CommandLine='.length);
            } else if (line.startsWith('ProcessId=')) {
                pid = parseInt(line.substring('ProcessId='.length), 10);
            }
        }

        if (!commandLine || !pid) continue;

        // Extract CSRF token
        const csrfMatch = commandLine.match(/--csrf_token[=\s]+([^\s"]+)/i);
        if (csrfMatch && csrfMatch[1]) {
            return { pid, csrfToken: csrfMatch[1], commandLine };
        }
    }
    return null;
}

// Parse `netstat -ano` output into a sorted list of unique LISTENING ports. When `pid` is given,
// only rows whose PID column matches exactly are used (findstr "<pid>" also matches substrings).
function parseListeningPorts(stdout, pid) {
    if (!stdout) return [];

    const ports = new Set();
    for (const line of stdout.split('\n')) {
        const match = line.match(/:(\d+)\s+[\d.:[\]*]+\s+LISTENING\s*(\d+)?/);
        if (pid !== undefined && (!match || Number(match[2]) !== Number(pid))) continue;
        if (match && match[1]) {
            ports.add(parseInt(match[1], 10));
        }
    }
    return Array.from(ports).sort((a, b) => a - b);
}

// Parse a GetUserStatus response body. Returns { email, plan } or null; throws on invalid JSON.
function parseUserStatusResponse(data) {
    const json = JSON.parse(data);
    const userStatus = json && json.userStatus;
    if (!userStatus) return null;
    const planInfo = userStatus.planStatus?.planInfo;
    return {
        email: userStatus.email,
        plan: planInfo?.planDisplayName || planInfo?.planName
    };
}

// ==================== PM2 ====================

// Build the shell command used to start/restart the proxy via PM2. `pm2 restart` is always tried
// first; `pm2 start <script>` is only appended when a script path is configured. Paths containing
// characters that could break out of the quoted argument are rejected.
function buildPm2StartCommand(proxyScriptPath) {
    const restart = `pm2 restart ${PM2_PROCESS_NAME}`;
    const scriptPath = typeof proxyScriptPath === 'string' ? proxyScriptPath.trim() : '';
    if (!scriptPath) return restart;
    if (/["`$%\r\n]/.test(scriptPath)) {
        throw new Error('Invalid antigravity.proxyScriptPath: must not contain quotes, `, $, % or newlines');
    }
    return `${restart} || pm2 start "${scriptPath}" --name ${PM2_PROCESS_NAME}`;
}

module.exports = {
    MODELS,
    PM2_PROCESS_NAME,
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
};
