# Codex Context Handoff

When an opted-in Codex CLI chat crosses 40% of its effective context window, the plugin checks for work that can continue. It records a handoff and opens a fresh chat in the same Herdr terminal. The current worktree and the terminal's existing Herdr child workers stay available.

## Install and enable

Requires Codex CLI, Herdr CLI (`hc`), and Python 3. The terminal automation uses the English Codex CLI prompt. Tested on macOS with Codex CLI 0.167.1 and Herdr 0.1.19.

```bash
codex plugin marketplace add ulttla/gun-marketplace
codex plugin add codex-context-handoff@gun-marketplace
```

Open a new Codex CLI session. Review the plugin's `Stop`, `PostToolUse`, and `UserPromptSubmit` hooks in `/hooks` before trusting them. A plugin update that changes the hooks must be trusted again.

## Start Codex through the launcher

The hooks act only when Codex runs in the foreground of a Herdr terminal with `--no-daemon` and `CODEX_CONTEXT_HANDOFF=1`. The plugin ships a launcher, `bin/codex`, that adds both. Put it ahead of the real `codex` on your `PATH`, for example:

```bash
ln -s "$PWD/plugins/codex/codex-context-handoff/bin/codex" ~/.local/bin/codex
hash -r   # zsh and bash cache the old codex path until a rehash or a new shell
```

Inside a Herdr terminal (`HC_TERMINAL_ID` is set), the launcher changes only interactive launches and sets `CODEX_CONTEXT_HANDOFF=1` for them:

- `codex [options] [prompt]` gets `--no-daemon` before the other arguments.
- `codex [options] resume|fork ...` gets `--no-daemon` right after the subcommand, which has its own flag.
- Your model, profile, sandbox, and other flags are kept. An explicit `--no-daemon` is not repeated in the same place, but still opts in.

Everything else runs the real `codex` unchanged: `exec`, `review`, `app-server`, `plugin`, `agents`, and other subcommands; `--help`, `--version`, and `--remote` anywhere before `--`; an `-i` image list followed by a subcommand name; launches outside Herdr; and any launch with `CODEX_CONTEXT_HANDOFF=0`. The launcher finds the real `codex` by skipping itself and any copy of itself on `PATH`.

Without the launcher, start Codex with `CODEX_CONTEXT_HANDOFF=1 codex --no-daemon` (or `codex resume --no-daemon <id>`).

The launcher cannot change a Codex process that is already running. A chat started with plain `codex` runs its hooks in the Codex daemon, whose environment can name another Herdr terminal, and the plugin does not guess the right one. Exit that chat and reopen it with `codex resume <session-id>` in the Herdr terminal. `handoff status` tells you when this is needed.

## Turn it off or on for one chat

Submit one of these as the whole prompt. The hook blocks it, so it never reaches the model, and shows the result:

| Prompt | Effect |
| --- | --- |
| `handoff off` (also `handoff cancel`, `핸드오프 끄기`, `핸드오프 취소`) | Turns the handoff off for this chat and cancels a handoff that is armed or waiting to switch. |
| `handoff on` (also `핸드오프 켜기`) | Removes this chat's off setting. A cancelled handoff stays cancelled. |
| `handoff status` (also `핸드오프 상태`) | Shows the requested setting, whether the hooks can act in this process, and any pending handoff. |

The setting belongs to the chat's session ID; there is no global switch. Case and extra spaces are ignored, but quotes or any other words make it an ordinary prompt. These commands also work when the process was not started through the launcher, so `handoff status` can say that a restart is needed.

A prompt of exactly `end session`, `wrap up`, `세션 종료`, or `마무리` goes to the model as usual and skips the handoff for that turn only.

## How it works

1. After each tool call, a hook checks the latest token count of the turn against the reported context window. The calculation includes the tokens counted by the runtime, so it can differ from the CLI's display. Once usage strictly exceeds the threshold (40% by default), it adds one note per turn to the model's context: reach a safe checkpoint and end the turn if work will remain. It does not change the tool result or interrupt a running tool. For testing, set `CODEX_CONTEXT_HANDOFF_THRESHOLD` to a number between 0 and 100, exclusive.
2. When a turn past the threshold is about to finish, Codex gets one request to prepare a short handoff if the work can continue. Completed work, work waiting on the user or an approval, and a user ending the session finish normally. This also works when another plugin's `Stop` hook has already continued the turn. The hook saves the note locally under the plugin's data directory.
3. After the turn completes and the terminal shows an empty prompt, the plugin waits through a cancellation window of 10 seconds (`CODEX_CONTEXT_HANDOFF_GRACE` accepts 0 to 60). Typing anything, a status change, or `handoff off` stops the switch. It checks again immediately before sending `/clear`, then opens the new chat, submits a continuation prompt, and verifies that the new chat receives it in the original worktree. The old chat remains accessible via `/resume`.

The hooks act only in an interactive root chat whose hook process descends from the foreground Codex process of the Herdr terminal, in the same worktree. The session source can be `cli`, or `vscode` for a chat first started through the daemon and later resumed with `--no-daemon`. The process check excludes IDE, daemon, `exec`, and subagent hooks.

The handoff includes the task, decisions, worktree, validation, next action, and live child terminal IDs. The plugin stores its handoff notes and switch logs locally in `$PLUGIN_DATA/<old-session-id>/`. The notes can contain project context. Review them before sharing. If a Codex update changes its transcript or prompt, the plugin can fall back to manual recovery.

## Recover a handoff

If the plugin cannot confirm the active terminal or an empty prompt, it leaves the handoff note available for manual recovery. Find the latest `.md` and its matching `.log` in the plugin data directory. A `.received` file names the chat that received the continuation, `.cancelled` means you turned the handoff off, and `.closed` means no note was written or the switch stopped (the reason is in `.closed` and `.log`). Check whether the continuation already started, then read the note in a fresh chat in the same worktree if needed. Do not retry blindly when the terminal shows a prompt or approval dialog.

## Run the tests

From the repository root:

```bash
python3 -B -m unittest discover -s plugins/codex/codex-context-handoff/tests
```
