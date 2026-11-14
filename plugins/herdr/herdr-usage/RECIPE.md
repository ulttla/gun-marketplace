# Recipe: herdr-usage

The brief this build follows, for rebuilding it from scratch or adapting it to another Herdr version.

## Goal

Show, at a glance in Herdr's status bar, how much of each AI subscription window is left (Codex, Claude Code, Antigravity, Ollama Cloud), and on click a popup with every window, its reset time and when the value was observed. Never invent a number: unknown stays unknown, a passed reset waits for a new value, and old data never looks fresh.

## Pieces

1. **Status bar mod** (`gun-usage-bar`): a copy of what Herdr's shipped `workspace-status` shows (machine, branch, agents, "needs you", palette hint) plus one chip per source with its remaining percent. It narrows to the lowest window, then to icons only, as the bar gets narrower. Runs the collector every 60 s with `exec`; clicking opens the popup; `open` and `refresh` commands.
2. **Detail mod** (`gun-usage-detail`): a dialog overlay listing each source's windows with remaining/used bars, reset time and countdown, observation time and method, source status, and a manual refresh that shares the new snapshot with the bar.
3. **Layout** (`gun-usage`): Herdr's `main` layout with the `status` block pointed at the bar. Shipped mods and layouts stay untouched.
4. **Collector** (`bin/herdr-usage snapshot`): one Node.js script, no dependencies, single-flight with a lock. Writes a normalized snapshot (`schema: 1`, per-source `status`, `method`, `observed_at`, `stale_after_s`, `groups[].windows[]`).
   - Codex: a short-lived `codex app-server`, `account/rateLimits/read`, bounded time, process group killed (Windows: only its PID tree via taskkill); fallback to the newest `rate_limits` event in session rollouts with the event's own timestamp.
   - Ollama Cloud: `GET /api/balance`, device-key signature or `OLLAMA_API_KEY` Bearer. Local Ollama by HTTP only.
   - Network sources at most every 5 minutes, forced refresh at most once a minute, 429 `Retry-After` honored, last good values kept with their original time.
5. **Statusline capture** for Claude Code and agy: Windows uses a Node.js wrapper that captures locally after the original command exits; macOS/Linux use a POSIX `sh` wrapper set as `statusLine.command` runs the original command with identical stdin, stdout, stderr and exit code, then hands the payload to `herdr-usage capture` in the background. The capture keeps a whitelist (rate limits, context percent, model name, cwd folder name, hashed session id, Herdr terminal id) in a 0600 file per session, and moves `observed_at` only when the quota values change.
6. **Display language**: the mods show English or Korean from one shared `i18n.js`, with the language the installer baked in. They rebuild window and account names from the locale-neutral parts of the snapshot (source, window id, duration, `label_key`, `message_codes`), so values cached by earlier versions with Korean `label` and `message_ko` still read correctly; names from a service or the person are shown as they are. The collector keeps writing `label` and `message_ko` for older readers.
7. **Installer**: checks before writing (options, platform, Node.js, Herdr home, `herdr-app`, name collisions, settings formatting, main layout, window, `herdr-app check` of the staged mods); edits only the `statusLine` key with an atomic, re-read-before-rename write; keeps the original value apart; idempotent; saves the display language (`--language en|ko`; otherwise the saved one, Korean for installs made before it was saved, English for new installs); an uninstaller that restores only while the wrapper is still in place.

## Herdr APIs used

`exec`, `readTextFile`, `appHome`, `openOverlay`, `closeOverlay`, `shared`/`setShared`, `focused`, `panes`, `spaces`, `agents`, `keys`, `theme`, `nextCommand`, `run("app.palette")`; gpui-kit `View`, `div`, `svg`, `image`, `h_flex`, `v_flex`, `on_size_change`. Commands: `herdr-app check`, `herdr-app status`, `herdr-app do layout.switch`.

## Network and programs

The mods run the collector with `exec`. The collector runs `codex app-server` and calls `ollama.com` and `127.0.0.1:11434`. It reads `~/.ollama/id_ed25519` to sign the Ollama request and Codex session files under `$CODEX_HOME`. It calls no model.
