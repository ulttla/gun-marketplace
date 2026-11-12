# Codex Context Handoff

When an opted-in Codex CLI chat crosses 40% of its effective context window, the plugin checks for work that can continue. It records a handoff and opens a fresh chat in the same Herdr terminal. The current worktree and the terminal's existing Herdr child workers stay available.

## Install and enable

Requires Codex CLI, Herdr CLI (`hc`), and Python 3. The terminal automation uses the English Codex CLI prompt and Herdr's turn counter and status time (`hc get` fields `turn` and `status_ms`, present in Herdr 0.1.20). Tested on macOS with Codex CLI 0.167.2 and Herdr 0.1.20.

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

`handoff goal transfer on` (`핸드오프 목표 이전 켜기`) and `handoff goal transfer off` (`핸드오프 목표 이전 끄기`) turn Goal transfer on or off for the whole plugin; see below. `handoff status` also shows `Goal transfer: on since <time>` or `off`.

A prompt of exactly `end session`, `wrap up`, `세션 종료`, or `마무리` goes to the model as usual and skips the handoff for that turn only.

## How it works

1. After each tool call, a hook checks the latest token count of the turn against the reported context window. The calculation includes the tokens counted by the runtime, so it can differ from the CLI's display. Once usage strictly exceeds the threshold (40% by default), it adds one note per turn to the model's context: reach a safe checkpoint and end the turn if work will remain. It does not change the tool result or interrupt a running tool. For testing, set `CODEX_CONTEXT_HANDOFF_THRESHOLD` to a number between 0 and 100, exclusive.
2. When a turn past the threshold is about to finish, Codex gets one request to prepare a short handoff if the work can continue. Completed work, work waiting on the user or an approval, and a user ending the session finish normally. This also works when another plugin's `Stop` hook has already continued the turn. The hook saves the note locally under the plugin's data directory.
3. After the turn completes and the terminal shows an empty prompt, the plugin waits through a cancellation window of 10 seconds (`CODEX_CONTEXT_HANDOFF_GRACE` accepts 0 to 60). Typing anything, submitting any prompt, a status change, or `handoff off` stops the switch. It checks again immediately before sending `/clear`.
4. After `/clear`, Codex can report itself busy while it starts MCP servers for the new chat, with only the empty welcome prompt on screen. The plugin waits for that startup, up to 150 seconds (`CODEX_CONTEXT_HANDOFF_STARTUP_WAIT` accepts 12 to 600), but only after it has seen this chat's `UserPromptSubmit` hook run in the same Codex process; otherwise it waits at most 12 seconds. During the wait, text in the prompt, any submitted prompt (including a Herdr worker's message or `handoff status`), a dialog, an error, a finished turn, or a second busy period stops the switch. The new chat must then stay idle at its empty prompt for 2 seconds.
5. After a last check, the plugin submits the continuation prompt once and verifies that the new chat receives it in the original worktree. The new chat runs it only if it arrives exactly as sent, before any other prompt, and before the switch stopped; otherwise it is blocked and the note is left for manual recovery. The old chat remains accessible via `/resume`.

The hooks act only in an interactive root chat whose hook process descends from the foreground Codex process of the Herdr terminal, in the same worktree. The session source can be `cli`, or `vscode` for a chat first started through the daemon and later resumed with `--no-daemon`. The process check excludes IDE, daemon, `exec`, and subagent hooks.

The handoff includes the task, decisions, worktree, validation, next action, and live child terminal IDs. The plugin stores its handoff notes and switch logs locally in `$PLUGIN_DATA/<old-session-id>/` (a `.goal.json` beside a note records a transferred Goal). If `$PLUGIN_DATA` is a symlink, the plugin uses the resolved directory, so two installs that share one data directory refer to the same note paths. The notes can contain project context. Review them before sharing. If a Codex update changes its transcript or prompt, the plugin can fall back to manual recovery.

## Goals

A Codex Goal starts its next turn as soon as a turn ends, so a chat with an active Goal never reaches the idle prompt the switch needs. The plugin reads the Goal state from `<CODEX_HOME>/goals_1.sqlite` read-only (found from the transcript path) and never writes it or calls any Goal API. A Goal state it cannot read stops the handoff for that chat with one message; it is never treated as "no Goal".

- **No Goal:** unchanged.
- **Goal not active** (paused, blocked, usage- or budget-limited, complete): the usual handoff, asking the model to leave the Goal alone. If the Goal changes during the handoff turn, nothing is handed off.
- **Active Goal, transfer off:** no handoff request. The chat shows once that it is waiting and Codex auto-compaction handles context. If transfer is turned on later, the chat's next Goal turn past the threshold gets the transfer request.
- **Active Goal, transfer on:** the request also asks the model to call `get_goal`, then `update_goal` with `paused`, and print both results. The plugin checks the transcript after its own request (no prompt, steer or `/goal` change from you after it; exactly one `update_goal` and no `create_goal`; an active then a paused result for the same Goal from `update_goal`) and that the DB shows the same paused Goal (same Goal ID, budget, token count and time). It then saves the objective, the remaining token budget (if any) and the counters with the note, and switches. The fresh chat is asked to call `create_goal` with exactly that objective and `token_budget`; its next Stop checks the DB once, reminds at most once, and reports a mismatch without fixing it. Counters restart in the fresh chat; the note and the plugin data keep the per-chat and total counters.

Transfer needs two things: the plugin consent from `handoff goal transfer on` (stored in `$PLUGIN_DATA/goal-transfer.json`), and a standing instruction from you, for example in `~/.codex/AGENTS.md`, that the model may pause and recreate a Goal when this plugin's request contains a "GOAL TRANSFER" section. `handoff on` alone is not consent. `CODEX_CONTEXT_HANDOFF_GOAL=off` disables transfer whatever the file says, and `handoff off` disables everything for its chat.

Turning transfer off (or the environment kill switch) at any point before the fresh chat accepts the continuation stops the handoff: the capture, the grace window, the startup wait, the final check before the continuation and the fresh chat itself all check it again. In the fresh chat, a Goal with the exact objective and budget counts as recreated whatever its native status (it may already be complete). Any prompt submitted there before the Goal is recreated, including a Herdr message or a `handoff` command, ends the check: the plugin does not remind the model later, and says that the old Goal stays paused.

Each chat gets at most one transfer request. If the model does not pause, or the pause cannot be verified, nothing is switched: an active Goal keeps running in the same chat, and a paused one stays paused with a message to resume it with `/goal`. A handoff cancelled after the pause also leaves the old Goal paused; the plugin never resumes a Goal. `handoff status` lists a Goal paused for a handoff that did not reach a fresh chat.

Live checks cover a 20-second MCP startup, draft and submitted-prompt takeover, a 0.2.0-to-0.3.0 handoff through shared plugin data, and an active Goal's pause, exact remaining-budget recreation and native continuation to completion. Goal checks used a test-only 1% threshold; the shipped default remains 40%. Concurrent Stop-hook provenance and long transcripts also have automated regression coverage.

## Recover a handoff

If the plugin cannot confirm the active terminal or an empty prompt, it leaves the handoff note available for manual recovery. Find the latest `.md` and its matching `.log` in the plugin data directory. A `.received` file names the chat that received the continuation, `.cancelled` means you turned the handoff off or a prompt was submitted before the continuation, and `.closed` means no note was written or the switch stopped (the reason is in `.closed`; the `.log` records each step with timestamps, including the status, Herdr turn, and prompt state seen after `/clear`). Check whether the continuation already started, then read the note in a fresh chat in the same worktree if needed. Do not retry blindly when the terminal shows a prompt or approval dialog.

## Run the tests

From the repository root:

```bash
python3 -B -m unittest discover -s plugins/codex/codex-context-handoff/tests
```
