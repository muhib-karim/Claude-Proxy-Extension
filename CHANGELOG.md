# Changelog — Antigravity Proxy Status Extension

All notable changes to the VS Code extension will be documented in this file.

---

## [Unreleased]

### Fixed
- **Per-window session ID**: the window ID sent to the proxy's `/session-model` endpoint is now stored in `workspaceState`; it was stored in `globalState`, which is shared by all windows, so every window used the same proxy session
- **Hardcoded proxy path removed**: the offline "start proxy" fallback no longer uses a machine-specific `~/Desktop/Projects/...` path; `pm2 start` is only attempted when the new `antigravity.proxyScriptPath` setting is configured
- **Timer leak**: the 60-second account refresh interval is now cleared on deactivate
- **Model switch errors** are shown as an error message instead of an unhandled promise rejection
- **Quota bar crash**: out-of-range quota values (e.g. >100%) no longer throw a `RangeError`
- **Account detection**: skipped on non-Windows platforms (it relies on `wmic`/`netstat`); the HTTP fallback request now has a timeout; ports are matched to the exact language server PID; `wmic` records with `\r\r\n` line endings are parsed separately (previously only the last process was checked); overlapping lookups are prevented
- Activation log shows the real extension version instead of a stale hardcoded one
- Per-account reset times in the quota popup now belong to the model with the lowest remaining quota (previously the last model listed)
- `repository` URL in `package.json` now points to this repository, so README images resolve on the marketplace
- Stale extracted VSIX folders (`extracted-3.3.0/`, `extracted-3.4.0/`) and `publish.ps1` are no longer shipped inside the `.vsix`
- Local secret files (`.env`, `.env.*`, `.secrets`) are excluded from both git and the `.vsix`

### Added
- `antigravity.proxyScriptPath` setting (machine scope)
- Development tooling: `npm run lint` (ESLint), `npm run compile` (type-check), `npm test` (node:test unit + activation tests), `npm run test:integration` (real VS Code via `@vscode/test-electron`), `npm run package`
- GitHub Actions CI workflow

### Changed
- Pure logic moved to `lib/helpers.js`; unused legacy quota panel/tooltip code removed

---

## [4.3.0] - 2026-01-25

### Changed
- **Opt-in proxy**: the proxy integration is disabled on first install; the extension only checks/starts the proxy after it is enabled from the model switcher
- Removed hardcoded user paths from the PM2 fallback; updated the extension description

---

## [4.2.4] - 2026-01-03

### Changed
- Proxy toggle item in the model switcher simplified (no description text)
- Signed-in account is refreshed every 60 seconds (was 15 minutes) and whenever the window gains focus

---

## [4.2.3] - 2026-01-03

### Changed
- Version bump for Open VSX (no code changes)

---

## [4.2.2] - 2026-01-03

### Fixed
- **Proxy Toggle in Offline State**: Clicking "Disable Proxy" when offline now properly disables the proxy flag instead of trying to start it
- **Correct Server Path**: Fixed PM2 fallback to use `server.js` instead of `index.js`
- **Toggle Action Handling**: Model switcher now correctly processes toggle actions in all states (online, offline, disabled)

---

## [4.2.0] - 2026-01-03

### Added
- **One-Click Proxy Toggle**: Enable/Disable proxy directly from model switcher menu
- Toggle option appears at top of model menu with $(debug-stop) Disable / $(play) Enable icons
- Disabled state shows warning background in status bar
- State persists across VS Code restarts

### Changed
- Model switcher menu now includes toggle separator
- PM2 proxy process stopped when disabled, started when enabled
- Auto-start skipped when proxy is disabled

### Fixed
- Status bar now correctly shows disabled state when proxy is manually disabled

---

## [4.1.1] - 2026-01-03

### Fixed
- **Disabled Settings Watchers** - Removed global settings file watchers that were overriding per-window model selection
- Claude Code settings.json watcher no longer resets your model
- VS Code config listener no longer overrides window-local model

---

## [4.1.0] - 2026-01-03

### Added
- **Per-Window Model Selection**: Each Antigravity window maintains its own model independently
- **Workspace Persistence**: Model choice persists per-workspace across restarts
- **Auto Proxy Restart**: Extension starts proxy if offline when switching models

### Changed
- Model switches only affect current window, not other windows
- Shows "(per-window)" in model tooltip

### Fixed
- **Model Ping-Pong**: Fixed issue where multiple windows would conflict over model selection
- **Proxy Entry Point**: Extension now starts `index.js` instead of `server.js`

---

## [4.0.0] - 2026-01-02

### Added
- **Per-Window Model Selection**: each window maintains its own model independently; the choice persists per workspace

### Fixed
- Model "ping-pong" when multiple windows were open

---

## [3.9.2] - 2026-01-02

### Added
- **Smart Account Sorting** - Accounts with highest Claude quota shown first
- **Click-to-View Quota Popup** - Quick Pick popup shows all quota info on click
- **Clean UI Labels** - Removed icon prefixes from separator labels

### Changed
- Status bar shows just `$(account)` icon (no email text)
- Accounts sorted by Claude availability for easy manual switching

---

## [3.9.0] - 2026-01-02

### Added
- **Quota Info Panel** - Dedicated panel with real-time quota updates
- **Antigravity Account Detection** - Fetches logged-in account from IDE
- **Visual Quota Bars** - Block characters (▰▱) for quota display

### Changed
- Improved quota data processing with per-model breakdown

---

## [3.8.0] - 2026-01-02

### Added
- **Multi-Account Quota Display** - Shows quotas for all connected Google accounts
- **Reset Time Display** - Shows when each account's quota resets
- **Per-Model Quotas** - Claude and Gemini quotas displayed separately

---

## [2.6.0] - 2026-01-02

### Added
- **Per-Model Quota Display**: Hover tooltip shows Claude and Gemini quotas separately
- **Model-Level Breakdown**: Shows individual model quotas (opus, sonnet, flash, pro)
- **Visual Quota Bars**: Color-coded based on remaining percentage

### Removed
- **IDE Account Switcher**: Removed unused Antigravity IDE account feature

---

## [2.5.0] - 2026-01-02

### Added
- **Simplified 2-Icon Layout**: Account icon + Model name

### Fixed
- **API Endpoint Mismatch**: Fixed model sync using `/active-model` endpoint

---

## [2.4.0] - 2026-01-02

### Added
- **Dashboard Auto-Refresh Polling**: Extension syncs after OAuth operations

---

## [2.3.0] - 2026-01-01

### Added
- **Window-Local Model Switching**: Per-window model memory
- **Direct Google OAuth**: Quota fetching support

---

## [2.2.0] - 2026-01-01

### Added
- **Faster Polling**: 2-second interval for quick updates
- **Offline Detection**: 2-second timeout shows "Offline" immediately

---

## [2.1.0] - 2026-01-01

### Added
- **Status Bar Sync**: Updates to show actual model from Claude dropdown

---

## [2.0.0] - 2026-01-01

### Added
- **Real-Time Model Display**: Shows current model with emoji icons
- **3-Second Polling**: Auto-updates from `/active-model` endpoint
- **Dashboard Integration**: Click status bar to open dashboard
