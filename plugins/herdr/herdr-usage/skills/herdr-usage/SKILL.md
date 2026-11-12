---
name: herdr-usage
description: Install, update, check or remove the herdr-usage status bar, which shows Codex, Claude Code, Antigravity and Ollama Cloud subscription usage in the Herdr app with a detail popup. Use when the person asks to set up, update, check the status of, troubleshoot or uninstall herdr-usage or its usage bar in Herdr.
---

# herdr-usage

The plugin root is `<directory containing this SKILL.md>/../..`. It holds `install.mjs`, `uninstall.mjs`, `status.mjs` and the files they install. Run them with Node.js 22 or newer from any folder; the commands below write `<root>` for the plugin root's absolute path. macOS, Linux and Windows are supported. On Windows, the installer discovers a native Codex executable; use `HERDR_USAGE_CODEX` to override it with an absolute `codex.exe` path (not a `.cmd` or `.ps1` launcher).

Nothing installs on its own: run the installer when the person asks to install or update herdr-usage. That request is the approval; in one short message say what it changes (below), then run it. Ask only when something outside that scope is needed, such as resolving a name collision.

## What the installer changes

- Copies a collector to `<Herdr home>/usage` and two mods, `gun-usage-bar` and `gun-usage-detail`, to `<Herdr home>/mods`. The Herdr home is `$HERDR_APP_HOME`, or `~/.config/herdr-app`.
- In Claude Code's `settings.json` (under `$CLAUDE_CONFIG_DIR`, or `~/.claude`) and Antigravity's `~/.gemini/antigravity-cli/settings.json`, it changes only the `statusLine` key. The existing statusline command still runs with the same output; the wrapper also saves its rate-limit fields. A CLI whose config folder does not exist is skipped.
- Adds a `gun-usage` layout (Herdr's main layout with this status bar) and shows it. Spaces, tabs and panes stay as they are. `--no-activate` adds it without showing it.
- The mods run programs: the collector asks `codex app-server` for rate limits and calls `ollama.com/api/balance` with the local Ollama key, at most every 5 minutes. No model is called.

## Install or update

```sh
node <root>/install.mjs
```

The same command updates an existing install in place: it keeps the shown layout, the saved original statuslines and the captured data, and never wraps a wrapper twice. After a plugin update, run it from the new plugin root.

Options: `--no-activate`, `--skip-layout`, `--skip-settings`, `--skip-claude`, `--skip-agy`. Environment: `HERDR_APP_BIN` (path to `herdr-app`), `HERDR_USAGE_NODE` (the Node.js the statusline and Herdr will run; by default a `node` on `PATH` that resolves to the Node.js running the installer, so a Homebrew upgrade does not break it, else that Node.js itself), `HERDR_APP_HOME`, `CLAUDE_CONFIG_DIR`.

If no Herdr window is running (the installer says so), use `--no-activate`; the person can show the layout later.

Every check runs before the first write. On a nonzero exit, show the message: it says what to fix, and whether anything changed. Do not delete or rename the person's files to get past a check: a name collision with a mod, layout or `usage` folder that is not herdr-usage's is the person's to resolve.

The first snapshot is collected when Herdr draws the bar, so `status.mjs` may say `snapshot: never` until the layout is shown. Claude Code and Antigravity data arrive with their next statusline refresh; Codex and Ollama with the first collection.

## Check

```sh
node <root>/status.mjs          # add --json for machine-readable output
```

It reports which parts are installed, which statusLines are wrapped, the shown layout and each source's state (`ok`, `unavailable`, `connect_needed`, `error`). It prints no usage numbers or settings content, and exits 1 when herdr-usage is not installed. For a mod error, run `herdr-app check <Herdr home>/mods/gun-usage-bar` and `herdr-app status`.

## Uninstall

```sh
node <root>/uninstall.mjs       # --keep-files restores the statusLines only
```

It restores each statusLine only while it is still the wrapper, switches back to `main` if `gun-usage` is shown, and removes the layout, both mods and `<Herdr home>/usage`. A nonzero exit means something was left in place on purpose; relay the message.
