# Codex Context Handoff

When an opted-in Codex CLI chat crosses 40% of its effective context window, the plugin checks for work that can continue. It records a handoff and opens a fresh chat in the same Herdr terminal. The current worktree and the terminal's existing Herdr child workers stay available.

## Install and enable

Requires Codex CLI, Herdr CLI (`hc`), and Python 3. The terminal automation uses the English Codex CLI prompt. Tested on macOS with Codex CLI 0.167.0 and Herdr 0.1.19.

```bash
codex plugin marketplace add ulttla/gun-marketplace
codex plugin add codex-context-handoff@gun-marketplace
```

Open a new Codex CLI session. Review the plugin's `Stop` and `UserPromptSubmit` hooks in `/hooks` before trusting them.

Start the interactive Codex session from inside a Herdr terminal:

```bash
CODEX_CONTEXT_HANDOFF=1 codex --no-daemon
```

Add your usual model, profile, and sandbox flags to that command. Use `--no-daemon` so the hooks can verify that they belong to the foreground Codex process in this Herdr terminal. The plugin is opt-in per launch. To disable it, omit `CODEX_CONTEXT_HANDOFF=1` or disable the hooks in `/hooks`.

## How it works

1. When Codex is about to finish a turn, a hook checks the latest token count for that turn against the reported context window. The calculation includes the tokens counted by the runtime, so it can differ from the CLI's display. For testing, set `CODEX_CONTEXT_HANDOFF_THRESHOLD` to a number between 0 and 100, exclusive.
2. If usage strictly exceeds the threshold, Codex gets one request to prepare a short handoff if it can continue the work. Completed work and work waiting on user input should end normally. The hook saves the resulting note locally under the plugin's data directory.
3. After that turn completes and the terminal has an empty prompt, the plugin uses `/clear` to open a new chat and submits a continuation prompt. It verifies that the new chat receives the prompt in the original worktree. The old chat remains accessible via `/resume`.

The handoff includes the task, decisions, worktree, validation, next action, and live child terminal IDs. The plugin stores its handoff notes and switch logs locally in `$PLUGIN_DATA/<old-session-id>/`. The notes can contain project context. Review them before sharing. If a Codex update changes its transcript or prompt, the plugin can fall back to manual recovery.

## Recover a handoff

If the plugin cannot confirm the active terminal or an empty prompt, it leaves the handoff note available for manual recovery. Find the latest `.md` and its matching `.log` in the plugin data directory. Check whether the continuation already started, then read the note in a fresh chat in the same worktree if needed. A missing `.received` file means the plugin did not confirm delivery. Do not retry blindly when the terminal shows a prompt or approval dialog.

## Run the tests

From the repository root:

```bash
python3 -B -m unittest discover -s plugins/codex/codex-context-handoff/tests
```
