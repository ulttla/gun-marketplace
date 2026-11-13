# Windows support (0.1.1)

Run the same installer with Node.js 22 or newer after opening Herdr once:

```powershell
node install.mjs --no-activate
```

The installer writes to `%USERPROFILE%/.config/herdr-app` unless
`HERDR_APP_HOME` is set. It adds the collector, two mods and a separate
`gun-usage` layout. It preserves the shipped `main` layout and saves each
original statusLine key in `usage/state/<cli>-statusline.orig.json`.

The native and standard npm Codex installations are detected automatically.
For another location, set `HERDR_USAGE_CODEX` to the absolute `codex.exe` path
before installing. A `.cmd` or `.ps1` launcher cannot be used directly.
The selected path is recorded in `usage/install.json`; rerun the installer
if the Codex installation moves. A missing CLI does not prevent installation.

Windows uses `statusline-wrap.mjs`, a Node.js wrapper that preserves the input
bytes, stdout, stderr and exit status of the original command. It captures
quota fields locally after the command exits. No model prompts are sent.
If an existing command starts with `bash`, the wrapper also finds Git Bash in
its standard Program Files location when absent from PATH.

Claude and Antigravity subscription quotas are also queried directly while the
Herdr usage bar is open, without opening an agent terminal or sending a model
prompt. The bar checks every minute; network queries run at most every five
minutes (manual refresh: once a minute). Statusline captures remain a fallback
and provide per-terminal context usage. A failed query preserves the last good
value and its original observation time.

Claude uses the account recorded in `usage/install.json` and renews its existing
OAuth credentials when expired. Antigravity uses its local Windows login.
If the login has been revoked, sign in again through the corresponding CLI.
A CLI whose config folder does not exist is skipped. To wrap a separate Claude
account, set `CLAUDE_CONFIG_DIR` to that account's local folder before installing
or updating. Switching config folders does not transfer credentials.

The collector uses the current computer's sessions and credentials. Selecting
a remote Mac terminal in Herdr does not switch the collector to that machine.
Keep installations, account folders and caches outside Google Drive or other
folders shared between computers. `herdr-bg-status` remains macOS-specific and
is not part of this Windows port.

## Check and restore

```powershell
node status.mjs
herdr-app do layout.switch '{"name":"gun-usage"}'
```

Click the usage area to open the detail popup. Switch back with
`herdr-app do layout.switch '{"name":"main"}'`. Run `node uninstall.mjs` to
restore the saved statusLine keys and remove the package. Independently edited
statusLines are preserved.

## Validation

```powershell
node --test test/parse.test.mjs test/windows.test.mjs test/claude.test.mjs test/agy.test.mjs test/account-source.test.mjs
```

CI runs the synthetic parsers and native-wrapper tests on Windows. The additional
isolated install/update/restore integration test runs when `herdr-app` is
installed, and checks both staged mods. Paths include spaces, Unicode and an
apostrophe. Original command bytes, exit status, capture and restoration are
verified without real credentials or network. Unix shell-based installer and
wrapper suites run on macOS and Linux.
