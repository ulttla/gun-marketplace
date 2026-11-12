# Windows usage-bar installation

Local Windows port of `plugins/herdr/herdr-usage`, based on upstream
`0a10441127de2c1717c58e7c71606f5d5ef6f760`. Not published upstream.

Installed on this PC in `C:/Users/GUN2/.config/herdr-app`:

- Collector: `usage/`
- Mods: `mods/gun-usage-bar` and `mods/gun-usage-detail`
- Separate layout: `layouts/gun-usage.json`; shipped `main` is unchanged
- Claude statusLine wrapper; original key saved in
  `usage/state/claude-statusline.orig.json`
- Antigravity skipped because its local config folder does not exist

The collector reads this Windows machine's sessions and account credentials.
Selecting a remote Mac terminal does not switch the collector to that machine.
Claude/agy quotas require a new local statusline response. No model prompts are
sent to obtain quotas. Google Drive and the Mac's files are not modified.

## Port changes

Windows executable discovery and safe JS path substitution; native Node
statusline wrapper (original stdout/stderr/exit status preserved); scoped
Windows process-tree cleanup for the short-lived Codex app-server.
The existing macOS/Linux wrapper remains available. `herdr-bg-status` is not
ported or installed.

## Reinstall/update

Run from `plugins/herdr/herdr-usage`. Set `HERDR_USAGE_CODEX` to the native
`codex.exe` shipped by the installed npm package, not `codex.cmd` or `codex.ps1`.
On this PC the native binary is:

`C:/Users/GUN2/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`

Then run `node install.mjs --no-activate`. The installer records that executable
path. `node status.mjs` reports installation and data state.

Do not overwrite this local checkout with upstream before preserving the patch.
The upstream installer currently rejects Windows.

## Verify and restore

`node --test test/parse.test.mjs test/windows.test.mjs` passes on Windows.
The Windows integration test uses an isolated temporary home and real mod checks;
it verifies install/update, path quoting, capture, original output/exit status,
and exact restoration. Existing shell-based setup/wrapper suites require Unix.

Switch back with `herdr-app do layout.switch '{"name":"main"}'`.
Run `node uninstall.mjs` to restore the saved statusLine and remove the package.
Changes made independently to statusLine after installation are preserved.
