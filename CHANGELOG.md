# Changelog — Antigravity Proxy Status Extension

All notable changes to the VS Code extension will be documented in this file.

---

## [4.3.1] - 2026-11-10

### Security
- **Package contents**: The VSIX now contains only the files the extension needs at runtime (`extension.js`, `lib/`, `package.json`, README, CHANGELOG, LICENSE and the icon). `.vscodeignore` is an allowlist, so local files such as `.env*`, `.secrets`, key files, `publish.ps1`, tests and unpacked old builds (`extracted-3.3.0`, `extracted-3.4.0`) can no longer be bundled. Earlier builds bundled files from the publisher's working folder. CI and `publish.ps1` now refuse to package anything outside the allowlist.
- **CSRF token scope**: The Antigravity language server's CSRF token is only sent to ports owned by that exact process. Before this, a substring match on the process id could send it to loopback ports of other processes.
- The token is no longer sent again over plain HTTP after an HTTPS request timed out.
- The signed-in e-mail address is no longer written to the extension host log.

### Fixed
- **Per-window session id**: The proxy session id is now stored in `workspaceState`. Before this it was in `globalState`, so every window sent the same id to `/session-model`.
- **Model after a proxy restart**: The saved model of a window is sent to the proxy again, silently, whenever the proxy comes back online. Before this the proxy forgot it on restart while the status bar still showed it.
- **Model switch errors**: A failed switch now shows "Failed to switch model: ..." instead of failing silently or leaving an unhandled promise rejection. A connection dropped mid-response no longer leaves the command hanging.
- **Starting the proxy from the model menu**: The extension waits until the proxy answers (up to 10 s) before it sends the model, instead of sleeping 2 s and hoping. The machine-specific `~/Desktop/Projects/...` fallback path is gone (see the new setting below).
- **Slow proxy at startup**: A proxy that is alive but slow to answer `/health` is no longer restarted through PM2.
- **Account detection (Windows)**: `wmic` output with `\r\r\n` line endings is parsed per process (before, only the last process was looked at), lookups no longer overlap, and every request to the language server times out instead of possibly hanging forever.
- **Other platforms**: `wmic` and `netstat` are no longer spawned on Linux and macOS, where they do not exist.
- **Quota popup**: Reset times belong to the model with the lowest remaining quota (before, the last model listed). The popup says "Proxy disabled" or "Proxy offline" instead of loading forever. One malformed account entry no longer drops the whole refresh, and non-numeric values no longer show as `NaN%`.
- **Quota bar crash**: Quota bars now clamp out-of-range percentages. Before this, `String.repeat` could throw a `RangeError`.
- **Account list**: Accounts with no email no longer crash the popup, and reset times are no longer shown next to a missing (`—`) percentage.
- **Online detection**: Only an HTTP 200 answer from `/active-model` counts as the proxy being online. Before, any JSON answer on port 8080 did.
- **Enable / disable messages**: The extension reports whether PM2 actually started or stopped the proxy, and the hint for an unregistered proxy no longer points at a Windows-only script.
- **Timers and late callbacks**: The 60 s account poll timer is cleared on deactivate, and requests that finish after deactivation no longer touch the status bar or show messages.
- **Packaging from source**: `npx @vscode/vsce package` works from a clean checkout (the README banner is a PNG; vsce rejects SVG images).

### Changed
- **Quiet while disabled**: While the proxy is disabled the extension no longer polls `localhost:8080` or looks up the signed-in account. Enabling it refreshes the state right away.
- Polls never overlap: a slow answer is not followed by a second request for the same data.
- PM2 commands run with a 20 s timeout.
- Pure logic lives in `lib/quota.js` (quota aggregation, formatting, `wmic`/`netstat` parsing) and `lib/pm2.js` (PM2 commands).
- The activation log line reports the real version from `package.json`.
- `repository` now points to github.com/muhib-karim/Claude-Proxy-Extension.

### Added
- **`antigravity.proxyScriptPath` setting** (machine scope, empty by default): absolute path of the proxy's entry script. Only used as a fallback, when `pm2 restart antigravity-proxy` fails because the proxy is not registered with PM2 yet.
- Unit and behaviour tests (`npm test`), ESLint (`npm run lint`), a package content check (`npm run verify:package`), and GitHub Actions CI: lint and tests on Node 20 and 22, a package dry run that inspects the built VSIX, and a gitleaks scan.

---

## [4.3.0] - 2026-01-25

### Changed
- **Opt-in proxy**: The proxy integration is disabled on first install. The extension only checks and starts the proxy after it is enabled from the model switcher.
- Removed hardcoded user paths from the PM2 fallback; updated the extension description.

---

## [4.2.4] - 2026-01-03

### Changed
- Proxy toggle item in the model switcher simplified (no description text).
- The signed-in account is refreshed every 60 seconds (was 15 minutes) and whenever the window gains focus.

---

## [4.2.3] - 2026-01-03

### Changed
- Version bump for Open VSX (no code changes).

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
