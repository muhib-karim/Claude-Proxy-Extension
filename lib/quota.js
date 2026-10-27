// Pure helpers (no `vscode` dependency) so they can be unit-tested with plain Node.

// Available models for quick switching
const MODELS = [
    { label: '⚡ Flash', model: 'gemini-3-flash', description: 'Fast tasks' },
    { label: '💎 Pro', model: 'gemini-3-pro-high', description: 'Complex coding' },
    { label: '🎭 Opus', model: 'claude-opus-4-5-thinking', description: 'Deep reasoning' },
    { label: '🎵 Sonnet', model: 'claude-sonnet-4-5-thinking', description: 'Balanced' },
    { label: '🌐 Grok', model: 'pplx-grok', description: 'With web search' },
    { label: '🔍 Perplexity', model: 'sonar', description: 'Search focused' },
];

function fractionToPercent(info) {
    if (!info || info.remainingFraction === undefined || info.remainingFraction === null) return null;
    return Math.round(info.remainingFraction * 100);
}

// Process /account-limits response - aggregate by model family
function processQuotaData(json) {
    if (!json || !Array.isArray(json.accounts) || json.accounts.length === 0) {
        return { claudeQuota: null, geminiQuota: null, claudeModels: [], geminiModels: [], accounts: [], totalAccounts: 0 };
    }

    const accounts = json.accounts;
    const modelQuotas = {}; // { modelId: [pct1, pct2, ...] }
    const accountSummaries = [];

    for (const acc of accounts) {
        if (acc.status !== 'ok' || !acc.limits) continue;

        for (const [modelId, info] of Object.entries(acc.limits)) {
            const pct = fractionToPercent(info);
            if (pct !== null) {
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
            if (claudeQuota === null || minPct < claudeQuota) claudeQuota = minPct;
        } else if (modelId.includes('gemini')) {
            geminiModels.push({ id: modelId, quota: minPct });
            if (geminiQuota === null || minPct < geminiQuota) geminiQuota = minPct;
        }
    }

    return {
        claudeQuota,
        geminiQuota,
        claudeModels: claudeModels.sort((a, b) => a.id.localeCompare(b.id)),
        geminiModels: geminiModels.sort((a, b) => a.id.localeCompare(b.id)),
        accounts: accountSummaries,
        totalAccounts: json.totalAccounts || accounts.length
    };
}

// Lowest remaining Claude/Gemini percentage (and latest-seen reset time) for one account
function summarizeAccountLimits(limits) {
    let claudePct = null, geminiPct = null;
    let claudeReset = null, geminiReset = null;

    for (const [modelId, info] of Object.entries(limits || {})) {
        const pct = fractionToPercent(info);
        if (modelId.includes('claude')) {
            if (pct !== null && (claudePct === null || pct < claudePct)) claudePct = pct;
            if (info && info.resetTime) claudeReset = info.resetTime;
        } else if (modelId.includes('gemini')) {
            if (pct !== null && (geminiPct === null || pct < geminiPct)) geminiPct = pct;
            if (info && info.resetTime) geminiReset = info.resetTime;
        }
    }

    return { claudePct, geminiPct, claudeReset, geminiReset };
}

// Sort accounts by Claude quota descending (accounts with Claude available at top)
function sortAccountsByClaudeQuota(accounts) {
    return accounts
        .map(acc => ({ acc, ...summarizeAccountLimits(acc.limits) }))
        .sort((a, b) => {
            const aPct = a.claudePct !== null ? a.claudePct : -1;
            const bPct = b.claudePct !== null ? b.claudePct : -1;
            return bPct - aPct;
        });
}

function shortEmail(email) {
    if (!email) return 'unknown';
    return String(email).split('@')[0];
}

function createSmallQuotaBar(percent) {
    // Clamp so out-of-range input never makes String.repeat throw
    const pct = Math.min(100, Math.max(0, Number(percent) || 0));
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    // Use same-size block characters: ▰ for filled, ▱ for empty
    return '▰'.repeat(filled) + '▱'.repeat(empty);
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

// Parse `wmic process ... get ProcessId,CommandLine /format:list` output and
// return the first language server process that carries a CSRF token
function parseWmicOutput(stdout) {
    if (!stdout || stdout.trim() === '') return null;

    const entries = stdout.split(/\r?\n\r?\n/).filter(block => block.trim());
    for (const entry of entries) {
        const lines = entry.split(/\r?\n/).filter(l => l.trim());
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

        const csrfMatch = commandLine.match(/--csrf_token[=\s]+([^\s"]+)/i);
        if (csrfMatch && csrfMatch[1]) {
            return { pid, csrfToken: csrfMatch[1], commandLine };
        }
    }
    return null;
}

// Parse `netstat -ano` LISTENING lines into a sorted, de-duplicated port list
function parseNetstatPorts(stdout) {
    if (!stdout) return [];
    const ports = new Set();
    for (const line of stdout.split('\n')) {
        const match = line.match(/:(\d+)\s+[\d.:[\]]+\s+LISTENING/);
        if (match && match[1]) {
            ports.add(parseInt(match[1], 10));
        }
    }
    return Array.from(ports).sort((a, b) => a - b);
}

module.exports = {
    MODELS,
    processQuotaData,
    summarizeAccountLimits,
    sortAccountsByClaudeQuota,
    shortEmail,
    createSmallQuotaBar,
    formatResetTime,
    getDisplayName,
    parseWmicOutput,
    parseNetstatPorts
};
