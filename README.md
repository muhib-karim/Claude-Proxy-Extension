# Antigravity Proxy Status

VS Code extension for Antigravity Claude Proxy - real-time quota monitoring, multi-account management, and instant model switching.

![Quota Popup](screenshot-quota-popup.png)

## ✨ Key Features

### 🪟 Per-Window Model Selection (v4.0.0)
- **Independent models per window** - Each VS Code/Antigravity window maintains its own model
- **Workspace persistence** - Your model choice persists for each project/workspace
- **No more conflicts** - Multiple windows can use different models simultaneously

### 📊 Real-Time Quota Monitoring
- **Click to view quotas** - Click the account icon to see Claude & Gemini quota status
- **Per-model breakdown** - See individual quotas for Opus, Sonnet, Flash, Pro
- **Reset time display** - Know exactly when your quota resets
- **Smart account sorting** - Accounts with highest Claude quota shown first (helps when manually switching Antigravity accounts)

### 🧠 Instant Model Switching
- **One-click switching** - Click model name in status bar to switch models
- **Supported models**: Flash ⚡, Pro 💎, Opus 🎭, Sonnet 🎵, Grok 🌐, Perplexity 🔍
- **Per-window sync** - Model changes are saved per-window, not globally

![Model Switcher](screenshot-model-switcher.png)

### 👤 Status Bar Integration
- **Account icon** - Shows proxy connection status
- **Model display** - Current model with emoji indicator (per-window)
- **Offline detection** - Shows "Offline" in red when proxy is down

![Status Bar](screenshot-statusbar.png)

## Status Bar Layout

| Icon | Description | Click Action |
|------|-------------|--------------|
| 👤 | Account/Quota | Opens quota popup with all accounts |
| 💎 Pro | Current model (per-window) | Opens model switcher |
| ⏹ Disabled | Proxy integration is turned off | Opens model switcher with **Enable Proxy** at the top |

## Per-Window Model Selection

**New in v4.0.0:** Each window now maintains its own model independently.

| Scenario | Behavior |
|----------|----------|
| Window A sets Flash | Window A uses Flash |
| Window B sets Pro | Window B uses Pro, Window A still uses Flash |
| Reopen Window A | Window A still uses Flash (persisted) |

This is perfect for:
- Using **Flash** for quick tasks in one project
- Using **Opus** for complex reasoning in another project
- No more model "ping-pong" between windows!

## Quota Popup Features

When you click the account icon:

1. **Model Quotas** - Overall Claude and Gemini percentages with visual bars
2. **Google Accounts** - All connected accounts sorted by Claude availability
3. **Reset Times** - Shows when each account's quota resets
4. **Open Dashboard** - Quick link to full proxy dashboard

## Proxy Enable / Disable (opt-in auto-start)

The proxy integration is **off by default** so it does not conflict with other tools (such as Antigravity Manager) that use the same port.

- Open the model switcher and choose **Enable Proxy** (or **Disable Proxy**) at the top of the list. The choice is remembered across restarts.
- When enabled, the extension checks `http://localhost:8080/health` on startup and, if the proxy is down, runs `pm2 restart antigravity-proxy`.
- Disabling while the proxy is online runs `pm2 stop antigravity-proxy`.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravity.proxyScriptPath` | `""` | Absolute path to the proxy entry script (e.g. `.../Antigravity-Claude-Code-Proxy/src/index.js`). If `pm2 restart antigravity-proxy` fails because the process is not registered yet, the extension runs `pm2 start "<path>" --name antigravity-proxy`. Empty = only `pm2 restart`. User/machine setting only (cannot be set by a workspace). |

## Commands

| Command | Description |
|---------|-------------|
| `Antigravity: Switch Model` | Choose a different AI model (saved per-window), or enable/disable the proxy |
| `Antigravity: Show Quota Info` | Show the quota popup (same as clicking the account icon) |
| `Antigravity: Open Dashboard` | Open proxy dashboard in browser |

## Requirements

- Antigravity Proxy running on `localhost:8080`
- VS Code / Antigravity 1.80.0+
- Optional: [PM2](https://pm2.keymetrics.io/) with the proxy registered as `antigravity-proxy` for auto-start / enable / disable
- Signed-in Antigravity account detection uses `wmic`/`netstat` and only works on Windows where `wmic` is still installed (recent Windows 11 builds removed it, so detection is skipped there); on macOS/Linux the rest of the extension works without it

## Installation

### From Open VSX (Recommended)
Search "Antigravity Proxy Status" in extensions marketplace.

### From VSIX
Build the `.vsix` (see [Development](#development)) or download it from a release, then:

```bash
code --install-extension claude-proxy-status-4.3.0.vsix
```

In the Antigravity IDE the equivalent is `antigravity --install-extension claude-proxy-status-4.3.0.vsix` (not verified on Linux).

## Advanced Features

- **Per-window models** - Each window/workspace has its own model selection
- **Auto-account rotation** - Proxy automatically switches to next account when quota exhausted
- **Multi-account support** - Connect unlimited Google accounts via dashboard
- **Visual quota bars** - Color-coded (filled/empty blocks) for quick status reading
- **Instant polling** - 5-second refresh for real-time quota updates

## Development

Plain JavaScript (CommonJS), no runtime dependencies. Entry point: `extension.js`; pure, unit-tested helpers live in `lib/helpers.js`.

Prerequisites: Node.js 22 LTS (the dev tooling needs Node >= 20.19) and npm.

```bash
npm ci                    # install dev tooling (ESLint, TypeScript checker, vsce, test runner)
npm run lint              # ESLint
npm run compile           # type-check the JS against the VS Code 1.80 API (tsc --noEmit via jsconfig.json)
npm test                  # unit + activation smoke tests (node:test, no VS Code needed)
npx @vscode/vsce package  # builds claude-proxy-status-<version>.vsix (same as: npm run package)
```

`npx @vscode/vsce` uses the version pinned in `devDependencies` (3.x). Running an unpinned `npx -y @vscode/vsce` outside the project pulls vsce 4.x, which needs Node >= 22.

### Testing

- `npm test` runs `test/helpers.test.js` (quota maths, parsers, PM2 command building) and `test/extension.test.js`, which activates the extension against a fake `vscode` API and a fake proxy on `localhost:8080`. That test is skipped if port 8080 is already in use.
- `npm run test:integration` downloads VS Code 1.80.0 into `.vscode-test/` and activates the extension inside it. On a headless Linux machine run it under a virtual display:

  ```bash
  xvfb-run -a npm run test:integration
  ```

  (Set `VSCODE_VERSION=stable` to test against the latest VS Code.)

CI (`.github/workflows/ci.yml`) runs lint, type-check, unit tests, the integration test and packaging on every push/PR, and uploads the `.vsix` as an artifact.

### Publishing

`publish.ps1` (Windows PowerShell) packages the extension and publishes it to Open VSX with the `OVSX_TOKEN` from `.env` or the environment. `.env` is git-ignored; never commit tokens. (Not verified on Linux.)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full history.

### v4.0.0
- **Per-window model selection** - Each window maintains its own model independently
- Models persist per-workspace across restarts
- Fixed model "ping-pong" issue when multiple windows were open

### v3.9.x
- Quota popup improvements
- Account sorting by Claude availability
- UI refinements

## License

MIT

