# mods

Small [mods](https://code.claude.com/docs/en/plugins/mods/overview) for Claude Code.

This is an independent personal project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC.

**[English](#english)** · **[한국어](#한국어)**

---

## English

A mod is a plugin that changes how Claude Code looks and behaves. This category of [gun-marketplace](../..) holds five. The repository works as a plugin marketplace, so you can install any of them by name.

| Mod | What it does | Where it works |
| :- | :- | :- |
| [`context-meter`](context-meter) | Shows the git branch, how full the context window is, how much the last turn added, and how much of your plan limits you have used, in a band above the prompt | Terminal and the Desktop app's Code tab |
| [`auto-pin`](auto-pin) | Pins a new session in the sidebar as soon as it starts | The Desktop app's Code tab |
| [`context-handoff`](context-handoff) | Once the context window is 40% full, has Claude write hand-off notes and continues from them in a new Desktop app session (or after resetting the context) | The Desktop app's Code tab (in a terminal it can only compact in place) |
| [`context-handoff-cli`](context-handoff-cli) | Once the context window is 40% full, has Claude write hand-off notes, then starts a fresh session in the same terminal with `/clear` and continues from them | Terminal |
| [`session-end-unpin`](session-end-unpin) | When you ask to end a session and Claude finds nothing left, unpins it from the sidebar | The Desktop app's Code tab |

Install one of the two hand-off mods: `context-handoff` where you work in the Desktop app, `context-handoff-cli` where you work in a terminal. `context-handoff-cli` does nothing outside an interactive terminal session, but with both installed, a terminal session would hand off twice.

### Requirements

- **Terminal**: Claude Code v2.1.287 or later. Check with `claude --version`.
- **Desktop app**: a version that includes Claude Code v2.1.286 or later. In a local session in the Code tab, enter `/status` and read the **Claude Code** row.

### Install

A mod is code that runs with your permissions: it can read and write your files, start processes, and make network requests. Read the source before you install, or [list what each mod does](#check-what-a-mod-does-first).

Add this repository as a marketplace, then install the mods you want:

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

```bash
claude plugin install context-meter@gun-marketplace
```

```bash
claude plugin install auto-pin@gun-marketplace
```

```bash
claude plugin install context-handoff@gun-marketplace
```

```bash
claude plugin install context-handoff-cli@gun-marketplace
```

```bash
claude plugin install session-end-unpin@gun-marketplace
```

In a Claude Code session the same commands are `/plugin marketplace add gunkr-com/gun-marketplace` and `/plugin install context-meter@gun-marketplace`.

A mod loads the next time you start a session. In a session that is already open, run `/reload-plugins`.

### Try one without installing

Clone the repository and load a mod's folder for one terminal session:

```bash
git clone https://github.com/gunkr-com/gun-marketplace.git
```

```bash
claude --plugin-dir ./gun-marketplace/plugins/mods/context-meter
```

### Check what a mod does first

With the repository cloned, this lists the events a mod handles and what it asks Claude Code to do, without running it:

```bash
claude plugin validate ./gun-marketplace/plugins/mods/context-meter
```

### context-meter

Draws one line above the prompt:

```text
main   Ctx 12% (119k/1M)   Last +119k   5H 1% ↻17:30   1W 25% ↻Wed 11:00
```

| Segment | Meaning |
| :- | :- |
| `main` | The current git branch. Left out when the session's folder is not in a git repository. On a detached HEAD, the short commit hash |
| `Ctx 12% (119k/1M)` | Context window: percent full, tokens used, window size |
| `Last +119k` | Tokens the last finished turn added. A negative number means the turn compacted the conversation |
| `5H 1% ↻17:30` | Five-hour plan limit: percent used, and when it resets |
| `1W 25% ↻Wed 11:00` | Weekly plan limit: percent used, and when it resets |

- A segment turns yellow at 70% and bold red at 90%.
- Reset times show only when the band is at least 100 columns wide.
- Plan limits show only on a subscription plan. On an API key the band shows the other segments alone.
- `/context-meter` prints the same line as text, for places that don't draw the band, such as the VS Code extension.

#### Options

Each segment can be turned on or off.

| Option | Default | What it shows |
| :- | :- | :- |
| `showBranch` | on | The current git branch |
| `showDirty` | off | A `*` after the branch name when the working tree has uncommitted changes, as in `main*`. Runs `git status` on each turn |
| `showModel` | off | The session's model |
| `showEffort` | off | The effort level the session's model requests ask for, as in `Effort xhigh`. Shown from the first response on, and left out on a model that takes no effort |
| `showContext` | on | `Ctx`, the context window |
| `showLastTurn` | on | `Last`, what the last turn added |
| `showFiveHour` | on | `5H`, the five-hour plan limit |
| `showWeekly` | on | `1W`, the weekly plan limit |
| `showOtherLimits` | on | Any other limit your account reports, such as a gateway's spend limit (`Spend`) |
| `showResetTimes` | on | When each limit resets |
| `showCost` | off | What the session has cost in US dollars, as in `$1.24`. On a subscription plan this is an estimate at API prices, not a charge |

To change them in a terminal session, run `/plugin configure context-meter@gun-marketplace`. From your shell, pass each one when you install:

```bash
claude plugin install context-meter@gun-marketplace --config showModel=true --config showCost=true
```

A change takes effect in the next session, or after `/reload-plugins`.

### auto-pin

When you start a new session in the Desktop app's Code tab, the mod pins it in the sidebar. You unpin it yourself when the work is done, or [`session-end-unpin`](#session-end-unpin) does when you end the session.

- A session you reopen is left as it is, so one you unpinned stays unpinned.
- When the sidebar is not reachable yet as the session starts, the mod tries again as each of your first three prompts starts and ends.
- `/auto-pin` pins the current session on request, says why when it can't, and lists the session's earlier tries.
- In auto mode the app's classifier refuses the mod's pin, since no request of yours asked for it. Allow the pin in `~/.claude/settings.json` with `"permissions": { "allow": ["mcp__ccd_sidebar__set_pinned"] }`. Claude's own pin and unpin calls then run without a check too.
- Outside the Desktop app there is no sidebar, and the mod does nothing.
- Sessions the app starts on its own, such as scheduled tasks, may be pinned too.

### context-handoff

A long session gets worse as its context fills up. This mod hands the work over to a fresh context before that happens, without you opening a new session. It is made for the Desktop app's Code tab; in a terminal, use [`context-handoff-cli`](#context-handoff-cli).

After each turn it reads how full the context window is. Past the threshold (40% by default), it:

1. Has Claude record a hand-off. When the project has a `session-close` skill, Claude is told to run it; otherwise Claude follows the session-close procedure in the project's `CLAUDE.md`, or updates `PROGRESS.md`, or writes `HANDOFF.md` at the project root.
2. By default (`reset` set to `session`), the hand-off waits for your next message. The Desktop app opens a session only on a turn you started, which a prompt the mod submits is not, so the mod attaches the hand-off instructions to that message instead (Claude reads them beside it; you don't see them). Claude does not work on the message here: it records the notes with your message as the next step, then opens a new Desktop app session in the same folder, whose first prompt has Claude read the notes and take up your message. It starts with this session's model, effort and permission mode. When the turn ends, the mod moves the new session to top level (so it lives on by itself, and this session is not woken each time its turns end) and unpins this session (`oldSession`). Where no session can be opened (outside the Desktop app, or when the app refuses), the mod compacts the conversation here instead, as below.
3. With `reset` set to `compact`, it submits the hand-off prompt at once, and when that turn ends, it compacts the conversation down to where the notes are and the next step (the same as `/compact` with instructions), so the process, model and settings stay as they were. In the Desktop app the session has no compaction call of its own, so the mod runs `/compact` with those instructions instead, as if you had typed it. With `reset` set to `clear`, it instead asks the Desktop app to clear the conversation (the same as `/clear`): the session keeps its row in the sidebar, the old conversation stays under **Resume previous session**, but the app starts a new Claude Code process only at your next message. Either way it then submits a prompt that has Claude read the notes and continue from the recorded next step.

Each step shows a toast. With `compact` or `clear`, a message you had already queued runs first. If you interrupt the hand-off turn, or the reset fails, the mod gives up, says why, and tries again once the context has grown by another 5 points.

- `/handoff-now` hands off right away, at any context size. It is a skill of the mod, so it runs in the turn you type it in, and with a new session that turn opens it. `/handoff-status` shows where the hand-off stands and what the mod did last.
- `/handoff-off` turns the automatic hand-off off for this session alone, for when it is about to end just past the threshold: a hand-off armed for your next message is called off, and no later turn starts one. A hand-off whose turn is already asked for goes on; interrupt that turn to stop it. `/handoff-now` still hands off, and `/handoff-on` turns the automatic hand-off on again (even with `enabled` off), started by the next turn to end past the threshold. Neither outlives the conversation: after a `/clear` of yours, `enabled` decides again.
- On Team and Enterprise plans, and on machines with managed settings, Claude Code's built-in security default (`cc-plugin-sec-default`) keeps some events from the plugins a person installs, the skill's text among them. So the mod sets `/handoff-now` up as you submit it, and its configured instructions ride along beside the skill's text, which holds the default ones. The compaction it then cannot watch is judged from how full the context is afterwards.
- The prompts the mod submits are shown in the transcript, marked `[context-handoff]`, and each step leaves a dim `context-handoff:` line there.
- A message of yours that asks to end the session (`endPhrases`: by default a message holding `세션` or `session` and `종료` or `end`, in any order, ignoring case; `end` only as a word of its own, not in `send`) carries no hand-off, and its turn starts none: the session is ending. A hand-off already armed waits for the message after it.
- With a new session: only a message you send carries the hand-off (typed, from the Desktop app or over Remote Control), not a slash command, another session's message or a background notice, nor a message you type while a turn is running. A session that shares another session's worktree cannot be moved to top level, so it stays under this one.
- With the compaction through `/compact` (the Desktop app, or `compaction` set to `command`): the `/compact` line shows in the transcript, the resume follows once its compaction has run, and if nothing has been compacted within five minutes the mod gives up.
- With the clear: the app is asked as the hand-off turn starts and clears as it ends; if it has not within eight seconds, the mod gives up. If a message you queued runs after the hand-off turn, the notes are recorded again. The resume is written to the mod's store, so the process the app starts next continues from the notes. The app starts that process only when you send your next message, however long after the clear: that message runs first, then the resume. Until then the conversation stays empty. A session started from another device cannot be cleared, so Remote Control is turned off for the clear and on again after the resume (`pauseRemoteControl`). Outside the Desktop app there is no app to clear, so the mod gives up after recording the notes.

#### Options

| Option | Default | What it does |
| :- | :- | :- |
| `enabled` | on | Hand off on its own past the threshold. Off, only `/handoff-now` hands off. `/handoff-off` and `/handoff-on` override it for one session |
| `threshold` | 40 | How full the context window is, in percent, before the hand-off starts |
| `retriggerStep` | 5 | After an interrupted or failed hand-off, try again once the context has grown this many points |
| `reset` | `session` | Where the work continues: `session` (a new Desktop app session, opened with your next message, or a compaction here where none can be opened), `compact` (in place, process and settings kept, no input needed) or `clear` (the Desktop app's clear: a fresh conversation, continued only after your next message) |
| `oldSession` | `unpin` | With a new session: `unpin` the session that handed off, or `keep` it as it is |
| `compaction` | `auto` | How the compaction is made: `auto` (the engine's compaction call, or `/compact` where the session has none, as in the Desktop app), `call` (the call alone) or `command` (`/compact` alone, queued as if typed) |
| `closeCommand` | `session-close` | The project skill Claude is told to run to record the hand-off, when the project has it |
| `closePrompt` | empty | Replaces the built-in hand-off prompt and the close skill. `{percent}` and `{threshold}` are filled in |
| `resumePrompt` | empty | Replaces the built-in prompt the work continues from: the new session's first prompt, or the one submitted after the reset |
| `pauseRemoteControl` | on | With the clear: turn Remote Control off for it, and on again after the resume. Off, such a session is not cleared |
| `endPhrases` | `세션 종료, session 종료, 세션 end, end session` | Comma-separated phrases. A message of yours holding every word of one, in any order and ignoring case, carries no hand-off, and its turn starts none. Empty, every message is handed off as usual |

To change them in a terminal session, run `/plugin configure context-handoff@gun-marketplace`, or pass them when you install:

```bash
claude plugin install context-handoff@gun-marketplace --config threshold=50
```

### context-handoff-cli

The terminal's `context-handoff`. A terminal session has no Desktop app to open a new session in, so this mod starts the fresh session itself, with `/clear`, in the same terminal: a new session id and transcript, with the old conversation still there under `claude --resume`.

After each turn it reads how full the context window is. Past the threshold (40% by default), it:

1. Submits a prompt that has Claude record a hand-off, as `context-handoff` does: the project's `session-close` skill when it has one, else the session-close procedure in `CLAUDE.md`, else `PROGRESS.md`, else `HANDOFF.md` at the project root. Claude stops once the notes are written.
2. When that turn ends, runs `/clear`, as if you had typed it.
3. As the fresh session starts, submits a prompt that has Claude read the notes, say in one line what it is picking up, and continue from the recorded next step (or ask the question the notes hold, and wait).

Each step shows a toast and leaves a dim `context-handoff-cli:` line in the transcript; the prompts it submits are marked `[context-handoff-cli]`.

- `/handoff-now` (`/context-handoff-cli:handoff-now`) hands off right away, at any context size, in the turn you type it in. `/handoff-status`, `/handoff-off` and `/handoff-on` work as in `context-handoff`, for the current conversation.
- If a message you had queued starts before `/clear` runs, it runs here first and the notes are recorded again after it. A message that runs after `/clear` was queued is quoted to the fresh session, which checks what came of it.
- If the hand-off turn is interrupted or ends in an error, nothing is cleared: the mod gives up, says why, and tries again once the context has grown by another 5 points. A `/clear` of your own while the notes are being written gives the hand-off up too.
- If `/clear` cannot be run, or runs without starting a fresh session, the mod compacts the conversation down to the notes here instead and continues from them (`fallback`).
- The threshold counts from scratch in the fresh session.
- A message of yours that asks to end the session (`endPhrases`, the same default as `context-handoff`) starts no hand-off when its turn ends.
- Outside an interactive terminal session (a `claude -p` run, an SDK host, the Desktop app) the mod does nothing, so a scripted run is never cleared. `/handoff-now` there records the notes and says no fresh session starts.

#### Options

| Option | Default | What it does |
| :- | :- | :- |
| `enabled` | on | Hand off on its own past the threshold. Off, only `/handoff-now` hands off. `/handoff-off` and `/handoff-on` override it for one conversation |
| `threshold` | 40 | How full the context window is, in percent, before the hand-off starts |
| `retriggerStep` | 5 | After an interrupted or failed hand-off, try again once the context has grown this many points |
| `fallback` | `compact` | When `/clear` does not start a fresh session: `compact` the conversation down to the notes here and continue, or `none` (give up and say so) |
| `closeCommand` | `session-close` | The project skill Claude is told to run to record the hand-off, when the project has it |
| `closePrompt` | empty | Replaces the built-in hand-off prompt and the close skill. `{percent}` and `{threshold}` are filled in |
| `resumePrompt` | empty | Replaces the built-in prompt submitted in the fresh session |
| `endPhrases` | `세션 종료, session 종료, 세션 end, end session` | Comma-separated phrases. A message of yours holding every word of one, in any order and ignoring case, starts no hand-off when its turn ends. Empty, every turn past the threshold hands off |

To change them in a terminal session, run `/plugin configure context-handoff-cli@gun-marketplace`, or pass them when you install:

```bash
claude plugin install context-handoff-cli@gun-marketplace --config threshold=50
```

### session-end-unpin

The other half of `auto-pin`: when you ask to end a session and Claude finds nothing left in it, the mod unpins it.

1. A message of yours that holds one of the phrases (by default `세션` or `session` and `종료` or `end`, in any order, ignoring case; `end` only as a word of its own, not in `send`) carries a note for Claude (Claude reads it; you don't see it): first do the project's end-of-session steps (progress notes, wiki or knowledge-base candidates, a close skill where the project has one), then judge whether the session can really end.
2. Only when nothing waits on you (no question, decision or approval), no task is unfinished and no follow-up is worth proposing does Claude call the mod's `accept_session_end` tool, with one line on what it checked.
3. When that turn ends with an answer, the mod unpins the session, shows a toast and leaves a dim `session-end-unpin:` line in the transcript.

- The session stays pinned when the turn is interrupted or fails, or when Claude, in the same turn, asks you something (a question in its wrap-up, `AskUserQuestion`) or proposes or starts another session. The `session-end-unpin:` line says which.
- When Claude has to ask you something first, your next two messages still belong to the ending: answer, and Claude can end the session then.
- A message that only mentions a phrase, such as one about how sessions end, is left to Claude: the note tells it to ignore a mere mention.
- The tool is in Claude's tool list in every session, and records nothing unless you asked to end the session.
- With [`context-handoff`](#context-handoff) 0.5.0 or later, or [`context-handoff-cli`](#context-handoff-cli), a message that asks to end is not handed off to a new session, even past its threshold. Keep both mods' phrases the same.
- In auto mode the unpin needs the same allow rule as `auto-pin`'s pin: `mcp__ccd_sidebar__set_pinned`.
- Outside the Desktop app there is no sidebar to unpin from; the line says so.

#### Options

| Option | Default | What it does |
| :- | :- | :- |
| `phrases` | `세션 종료, session 종료, 세션 end, end session` | Comma-separated phrases. A message holding every word of one of them, in any order and ignoring case, asks to end the session. An English word counts only on its own (`end`, not `send`) |

### Uninstall

```bash
claude plugin uninstall context-meter@gun-marketplace
```

```bash
claude plugin uninstall auto-pin@gun-marketplace
```

```bash
claude plugin uninstall context-handoff@gun-marketplace
```

```bash
claude plugin uninstall context-handoff-cli@gun-marketplace
```

```bash
claude plugin uninstall session-end-unpin@gun-marketplace
```

### License

[MIT](LICENSE). Shared as is, without support.

---

## 한국어

mod는 Claude Code의 모양과 동작을 바꾸는 플러그인입니다. [gun-marketplace](../..)의 이 분류에는 mod 다섯 개가 들어 있습니다. 리포 자체가 플러그인 마켓플레이스 역할을 하므로 이름으로 골라 설치할 수 있습니다.

| Mod | 하는 일 | 동작하는 곳 |
| :- | :- | :- |
| [`context-meter`](context-meter) | git 브랜치, 컨텍스트 창이 얼마나 찼는지, 직전 턴이 얼마나 늘렸는지, 플랜 한도를 얼마나 썼는지를 입력창 위 한 줄로 표시 | 터미널, 데스크톱 앱 Code 탭 |
| [`auto-pin`](auto-pin) | 새 세션이 시작되면 사이드바에 바로 고정 | 데스크톱 앱 Code 탭 |
| [`context-handoff`](context-handoff) | 컨텍스트 창이 40% 차면 Claude가 인계 기록을 쓰게 하고, 데스크톱 앱 새 세션(또는 컨텍스트 초기화 뒤)에서 기록을 읽어 이어감 | 데스크톱 앱 Code 탭 (터미널에서는 제자리 압축만 가능) |
| [`context-handoff-cli`](context-handoff-cli) | 컨텍스트 창이 40% 차면 Claude가 인계 기록을 쓰게 하고, 같은 터미널에서 `/clear`로 새 세션을 시작해 기록을 읽어 이어감 | 터미널 |
| [`session-end-unpin`](session-end-unpin) | 세션 종료를 요청했을 때 Claude가 남은 일이 없다고 판단하면 사이드바 고정을 해제 | 데스크톱 앱 Code 탭 |

인계 mod는 둘 중 하나만 설치하세요. 데스크톱 앱에서 작업하면 `context-handoff`, 터미널에서 작업하면 `context-handoff-cli`입니다. `context-handoff-cli`는 대화형 터미널 세션 밖에서는 아무것도 하지 않지만, 둘 다 설치하면 터미널 세션에서 인계가 두 번 일어납니다.

### 요구 사항

- **터미널**: Claude Code v2.1.287 이상. `claude --version`으로 확인합니다.
- **데스크톱 앱**: Claude Code v2.1.286 이상이 포함된 버전. Code 탭의 로컬 세션에서 `/status`를 입력하고 **Claude Code** 행을 봅니다.

### 설치

mod는 사용자 권한으로 실행되는 코드입니다. 파일을 읽고 쓰고, 프로세스를 실행하고, 네트워크 요청을 보낼 수 있습니다. 설치하기 전에 소스를 읽거나 [mod가 하는 일을 먼저 확인](#mod가-하는-일-먼저-확인하기)하세요.

이 리포를 마켓플레이스로 추가한 뒤 원하는 mod를 설치합니다.

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

```bash
claude plugin install context-meter@gun-marketplace
```

```bash
claude plugin install auto-pin@gun-marketplace
```

```bash
claude plugin install context-handoff@gun-marketplace
```

```bash
claude plugin install context-handoff-cli@gun-marketplace
```

```bash
claude plugin install session-end-unpin@gun-marketplace
```

Claude Code 세션 안에서는 같은 명령을 `/plugin marketplace add gunkr-com/gun-marketplace`, `/plugin install context-meter@gun-marketplace`로 입력합니다.

mod는 다음에 세션을 시작할 때 로드됩니다. 이미 열려 있는 세션에서는 `/reload-plugins`를 실행합니다.

### 설치하지 않고 써 보기

리포를 클론한 뒤 터미널 세션 하나에만 mod 폴더를 로드합니다.

```bash
git clone https://github.com/gunkr-com/gun-marketplace.git
```

```bash
claude --plugin-dir ./gun-marketplace/plugins/mods/context-meter
```

### mod가 하는 일 먼저 확인하기

리포를 클론한 상태에서 아래 명령을 실행하면, mod를 실행하지 않고 어떤 이벤트를 처리하고 Claude Code에 무엇을 요청하는지 나열합니다.

```bash
claude plugin validate ./gun-marketplace/plugins/mods/context-meter
```

### context-meter

입력창 위에 한 줄을 그립니다.

```text
main   Ctx 12% (119k/1M)   Last +119k   5H 1% ↻17:30   1W 25% ↻Wed 11:00
```

| 항목 | 의미 |
| :- | :- |
| `main` | 현재 git 브랜치. 세션 폴더가 git 리포가 아니면 생략됩니다. detached HEAD에서는 짧은 커밋 해시 |
| `Ctx 12% (119k/1M)` | 컨텍스트 창: 찬 비율, 사용한 토큰, 창 크기 |
| `Last +119k` | 직전에 끝난 턴이 늘린 토큰. 음수면 그 턴에서 대화가 압축된 것 |
| `5H 1% ↻17:30` | 5시간 플랜 한도: 사용률과 초기화 시각 |
| `1W 25% ↻Wed 11:00` | 주간 플랜 한도: 사용률과 초기화 시각 |

- 각 항목은 70%부터 노란색, 90%부터 굵은 빨간색으로 바뀝니다.
- 초기화 시각은 밴드 폭이 100칸 이상일 때만 표시됩니다.
- 플랜 한도는 구독 플랜에서만 표시됩니다. API 키로 쓰면 나머지 항목만 나옵니다.
- `/context-meter`는 같은 내용을 텍스트로 출력합니다. VS Code 확장처럼 밴드를 그리지 않는 곳에서 씁니다.

#### 옵션

항목마다 켜고 끌 수 있습니다.

| 옵션 | 기본값 | 표시 내용 |
| :- | :- | :- |
| `showBranch` | 켜짐 | 현재 git 브랜치 |
| `showDirty` | 꺼짐 | 커밋하지 않은 변경이 있으면 브랜치 이름 뒤에 `*` 표시 (예: `main*`). 턴마다 `git status`를 실행합니다 |
| `showModel` | 꺼짐 | 세션의 모델 |
| `showEffort` | 꺼짐 | 세션의 모델 요청에 적용된 effort 수준 (예: `Effort xhigh`). 첫 응답부터 표시되고, effort를 받지 않는 모델에서는 생략됩니다 |
| `showContext` | 켜짐 | `Ctx`, 컨텍스트 창 |
| `showLastTurn` | 켜짐 | `Last`, 직전 턴이 늘린 양 |
| `showFiveHour` | 켜짐 | `5H`, 5시간 플랜 한도 |
| `showWeekly` | 켜짐 | `1W`, 주간 플랜 한도 |
| `showOtherLimits` | 켜짐 | 계정이 보고하는 그 밖의 한도. 예: 게이트웨이의 지출 한도(`Spend`) |
| `showResetTimes` | 켜짐 | 각 한도의 초기화 시각 |
| `showCost` | 꺼짐 | 세션 비용(미국 달러, 예: `$1.24`). 구독 플랜에서는 실제 청구액이 아니라 API 가격 기준 추정치입니다 |

터미널 세션에서는 `/plugin configure context-meter@gun-marketplace`로 바꿉니다. 셸에서는 설치할 때 하나씩 넘깁니다.

```bash
claude plugin install context-meter@gun-marketplace --config showModel=true --config showCost=true
```

변경은 다음 세션부터, 또는 `/reload-plugins` 후에 적용됩니다.

### auto-pin

데스크톱 앱 Code 탭에서 새 세션을 시작하면 사이드바에 고정합니다. 작업이 끝나면 직접 고정을 해제하거나, 세션을 끝낼 때 [`session-end-unpin`](#session-end-unpin-1)이 해제합니다.

- 다시 연 세션은 건드리지 않으므로, 고정을 해제한 세션은 해제된 채로 남습니다.
- 세션이 시작될 때 사이드바에 아직 닿지 않으면, 처음 세 번의 프롬프트가 시작하고 끝날 때마다 다시 시도합니다.
- `/auto-pin`은 현재 세션을 직접 고정하고, 고정하지 못하면 이유를 알려 주며, 이 세션의 이전 시도 기록을 보여 줍니다.
- auto 모드에서는 고정을 요청한 사용자 요청이 없어서 앱의 분류기가 mod의 고정을 거절합니다. `~/.claude/settings.json`에 `"permissions": { "allow": ["mcp__ccd_sidebar__set_pinned"] }`를 넣어 고정을 허용하세요. 그러면 Claude가 직접 하는 고정·해제 호출도 확인 없이 실행됩니다.
- 데스크톱 앱 밖에는 사이드바가 없으므로 아무 일도 하지 않습니다.
- 예약 작업처럼 앱이 스스로 시작하는 세션도 고정될 수 있습니다.

### context-handoff

긴 세션은 컨텍스트가 찰수록 품질이 떨어집니다. 이 mod는 그 전에 작업을 새 컨텍스트로 넘깁니다. 새 세션을 직접 열 필요가 없습니다. 데스크톱 앱 Code 탭용이며, 터미널에서는 [`context-handoff-cli`](#context-handoff-cli-1)를 쓰세요.

턴이 끝날 때마다 컨텍스트 창이 얼마나 찼는지 읽고, 임계값(기본 40%)을 넘으면 다음을 차례로 합니다.

1. Claude가 인계 기록을 쓰게 합니다. 프로젝트에 `session-close` 스킬이 있으면 그 스킬을 실행하라고 지시하고, 없으면 프로젝트 `CLAUDE.md`의 세션 종료 절차를 따르거나, `PROGRESS.md`를 갱신하거나, 프로젝트 루트에 `HANDOFF.md`를 씁니다.
2. 기본(`reset`이 `session`)은 사용자가 다음 메시지를 보낼 때 인계합니다. 데스크톱 앱은 사용자가 시작한 턴에서만 새 세션을 열어 주는데, mod가 제출한 프롬프트의 턴은 여기에 해당하지 않습니다. 그래서 mod는 인계 지시를 그 메시지에 붙여 보냅니다(Claude만 읽고 화면에는 보이지 않음). Claude는 그 메시지를 여기서 처리하지 않습니다. 메시지를 다음 단계로 삼아 기록을 쓰고, 같은 폴더로 데스크톱 앱 새 세션을 엽니다. 새 세션의 첫 프롬프트는 기록을 읽고 그 메시지부터 처리하라는 것이며, 이 세션의 모델·effort·권한 모드로 시작합니다. 턴이 끝나면 mod가 새 세션을 최상위로 옮기고(독립적으로 남고, 새 세션의 턴이 끝날 때마다 이 세션이 깨어나지 않음) 이 세션의 고정을 풉니다(`oldSession`). 새 세션을 열 수 없으면(데스크톱 앱 밖이거나 앱이 거부하면) 아래처럼 여기서 압축합니다.
3. `reset`이 `compact`면 인계 프롬프트를 바로 제출하고, 그 턴이 끝날 때 대화를 "기록 위치와 다음 단계"만 남기고 압축합니다(`/compact`에 지시문을 붙인 것과 같음). 프로세스·모델·설정이 그대로 유지됩니다. 데스크톱 앱의 세션에는 압축 호출이 없으므로, 거기서는 직접 입력한 것처럼 같은 지시문으로 `/compact`를 실행합니다. `reset`을 `clear`로 두면 대신 데스크톱 앱에 대화를 비워 달라고 요청합니다(`/clear`와 같음). 세션은 사이드바의 같은 행에 남고 이전 대화는 **Resume previous session**으로 되돌릴 수 있지만, 앱은 다음 메시지를 보낼 때에야 새 Claude Code 프로세스를 띄웁니다. 어느 쪽이든 그 뒤 Claude가 기록을 읽고 기록된 다음 시작점부터 이어가도록 프롬프트를 제출합니다.

단계마다 토스트로 알립니다. `compact`·`clear`일 때 이미 대기 중이던 메시지가 있으면 그것이 먼저 실행됩니다. 인계 턴을 중단하거나 초기화에 실패하면 포기하고 이유를 알린 뒤, 컨텍스트가 5포인트 더 차면 다시 시도합니다.

- `/handoff-now`는 컨텍스트 크기와 상관없이 바로 인계합니다. mod에 딸린 스킬이라 입력한 그 턴에서 실행되므로, 새 세션 모드에서는 그 턴이 새 세션을 엽니다. `/handoff-status`는 인계가 어느 단계인지와 마지막으로 한 일을 보여 줍니다.
- `/handoff-off`는 이 세션에서만 자동 인계를 끕니다. 임계값을 막 넘었는데 곧 세션을 끝낼 때 씁니다. 다음 메시지를 기다리던 인계는 취소되고, 이후 어떤 턴도 인계를 시작하지 않습니다. 인계 턴이 이미 요청된 뒤라면 그 인계는 계속되며, 멈추려면 그 턴을 중단합니다. `/handoff-now`는 그대로 쓸 수 있고, `/handoff-on`은 자동 인계를 다시 켭니다(`enabled`가 꺼져 있어도). 다시 켜면 임계값을 넘긴 채 끝나는 다음 턴에서 인계가 시작됩니다. 둘 다 대화가 끝나면 사라지며, 직접 `/clear`하면 다시 `enabled`를 따릅니다.
- Team·Enterprise 플랜이나 managed settings가 있는 PC에서는 Claude Code 내장 보안 기본값(`cc-plugin-sec-default`)이 사람이 설치한 플러그인에게 일부 이벤트(스킬 본문 포함)를 넘기지 않습니다. 그래서 mod는 `/handoff-now`를 입력하는 순간 인계를 준비하고, 설정대로 만든 지시를 스킬 본문(기본 지시) 옆에 함께 붙입니다. 이때 볼 수 없는 압축은 압축 뒤 컨텍스트가 얼마나 찼는지로 판단합니다.
- mod가 제출하는 프롬프트는 `[context-handoff]` 표시와 함께 대화에 보이고, 단계마다 흐릿한 `context-handoff:` 줄이 대화에 남습니다.
- 세션을 끝내자는 메시지(`endPhrases`: 기본값은 `세션`·`session` 중 하나와 `종료`·`end` 중 하나가 모두 든 메시지, 순서·대소문자 무시, `end`는 `send` 안이 아니라 따로 쓴 단어일 때만)에는 인계 지시를 붙이지 않고, 그 턴이 끝나도 인계를 시작하지 않습니다. 세션이 끝나는 중이기 때문입니다. 이미 대기 중인 인계는 그다음 메시지에서 진행합니다.
- 새 세션일 때: 사용자가 보낸 메시지(직접 입력, 데스크톱 앱, Remote Control)만 인계 지시를 실어 갑니다. 슬래시 명령, 다른 세션의 메시지, 백그라운드 알림, 턴이 도는 중에 입력한 메시지는 해당하지 않습니다. 다른 세션의 worktree를 함께 쓰는 세션은 최상위로 옮길 수 없어 이 세션 아래에 남습니다.
- `/compact`로 압축할 때(데스크톱 앱, 또는 `compaction`을 `command`로 둔 경우): `/compact` 줄이 대화에 보이고, 그 압축이 끝나면 재개합니다. 5분 안에 압축되지 않으면 포기합니다.
- `clear`일 때: 인계 턴이 시작될 때 앱에 요청하고 턴이 끝날 때 비워집니다. 8초 안에 비워지지 않으면 포기합니다. 대기 중이던 메시지가 인계 턴 뒤에 실행되면 기록을 다시 씁니다. 재개 지시는 mod 저장소에 적어 두므로 앱이 다음에 띄우는 프로세스가 기록을 읽고 이어갑니다. 앱은 비운 뒤 아무리 시간이 지나도 다음 메시지를 보낼 때에야 그 프로세스를 띄우며, 그 메시지가 먼저 실행된 뒤 재개합니다. 그때까지 대화는 비어 있습니다. 다른 기기에서 시작한 세션은 비울 수 없으므로 비우는 동안 Remote Control을 끄고 재개 후 다시 켭니다(`pauseRemoteControl`). 데스크톱 앱 밖에는 비워 줄 앱이 없으므로 기록만 쓴 뒤 포기합니다.

#### 옵션

| 옵션 | 기본값 | 하는 일 |
| :- | :- | :- |
| `enabled` | 켜짐 | 임계값을 넘으면 자동으로 인계. 끄면 `/handoff-now`로만 인계. `/handoff-off`·`/handoff-on`으로 세션 하나만 바꿀 수 있음 |
| `threshold` | 40 | 인계를 시작하는 컨텍스트 창 사용률(%) |
| `retriggerStep` | 5 | 중단되거나 실패한 인계를 컨텍스트가 몇 포인트 더 찼을 때 다시 시도할지 |
| `reset` | `session` | 작업을 이어갈 곳: `session`(다음 메시지와 함께 여는 데스크톱 앱 새 세션, 열 수 없으면 여기서 압축), `compact`(제자리 압축, 프로세스·설정 유지, 입력 불필요) 또는 `clear`(데스크톱 앱의 비우기: 새 대화, 다음 메시지를 보내야 이어감) |
| `oldSession` | `unpin` | 새 세션일 때 인계한 세션의 고정을 풀지(`unpin`), 그대로 둘지(`keep`) |
| `compaction` | `auto` | 압축 방법: `auto`(엔진의 압축 호출, 데스크톱 앱처럼 호출이 없는 세션에서는 `/compact`), `call`(호출만), `command`(`/compact`만, 입력한 것처럼 큐에 넣음) |
| `closeCommand` | `session-close` | 프로젝트에 있을 때 인계 기록용으로 실행하라고 지시할 스킬 |
| `closePrompt` | 비어 있음 | 내장 인계 프롬프트와 스킬 지시를 대체. `{percent}`, `{threshold}`가 채워짐 |
| `resumePrompt` | 비어 있음 | 작업을 이어가는 내장 프롬프트를 대체: 새 세션의 첫 프롬프트, 또는 초기화 뒤 제출하는 프롬프트 |
| `pauseRemoteControl` | 켜짐 | `clear`일 때 비우는 동안 Remote Control을 끄고 재개 후 다시 켬. 끄면 그런 세션은 비우지 않음 |
| `endPhrases` | `세션 종료, session 종료, 세션 end, end session` | 쉼표로 구분한 문구. 이 중 하나의 단어가 순서·대소문자 무관하게 모두 든 메시지에는 인계 지시를 붙이지 않고, 그 턴 뒤에 인계를 시작하지도 않음. 비우면 모든 메시지를 평소처럼 인계 |

터미널 세션에서는 `/plugin configure context-handoff@gun-marketplace`로 바꾸거나, 설치할 때 넘깁니다.

```bash
claude plugin install context-handoff@gun-marketplace --config threshold=50
```

### context-handoff-cli

터미널용 `context-handoff`입니다. 터미널 세션에는 새 세션을 열어 줄 데스크톱 앱이 없으므로, 이 mod가 같은 터미널에서 `/clear`로 직접 새 세션을 시작합니다. 세션 ID와 기록 파일이 새로 생기고, 이전 대화는 `claude --resume`으로 다시 열 수 있습니다.

턴이 끝날 때마다 컨텍스트 창이 얼마나 찼는지 읽고, 임계값(기본 40%)을 넘으면 다음을 차례로 합니다.

1. `context-handoff`처럼 Claude가 인계 기록을 쓰게 하는 프롬프트를 제출합니다. 프로젝트에 `session-close` 스킬이 있으면 그 스킬, 없으면 `CLAUDE.md`의 세션 종료 절차, `PROGRESS.md`, 프로젝트 루트의 `HANDOFF.md` 순서입니다. 기록을 다 쓰면 Claude는 멈춥니다.
2. 그 턴이 끝나면 직접 입력한 것처럼 `/clear`를 실행합니다.
3. 새 세션이 시작되면 Claude가 기록을 읽고, 무엇을 이어받는지 한 줄로 말한 뒤 기록된 다음 단계부터 이어가도록 프롬프트를 제출합니다. 기록에 사용자에게 물을 질문이 있으면 그것부터 묻고 기다립니다.

단계마다 토스트로 알리고 대화에 흐릿한 `context-handoff-cli:` 줄을 남깁니다. mod가 제출하는 프롬프트에는 `[context-handoff-cli]` 표시가 붙습니다.

- `/handoff-now`(`/context-handoff-cli:handoff-now`)는 컨텍스트 크기와 상관없이 입력한 그 턴에서 바로 인계합니다. `/handoff-status`, `/handoff-off`, `/handoff-on`은 `context-handoff`와 같고, 현재 대화에만 적용됩니다.
- 대기 중이던 메시지가 `/clear` 전에 시작되면 그 메시지를 여기서 먼저 처리하고 기록을 다시 씁니다. `/clear`가 큐에 들어간 뒤 실행된 메시지는 새 세션에 그대로 인용해 주어, 새 세션이 그 결과를 확인합니다.
- 인계 턴이 중단되거나 오류로 끝나면 대화를 비우지 않습니다. 포기하고 이유를 알린 뒤, 컨텍스트가 5포인트 더 차면 다시 시도합니다. 기록을 쓰는 중에 직접 `/clear`해도 인계를 포기합니다.
- `/clear`를 실행할 수 없거나, 실행했는데 새 세션이 시작되지 않으면 대신 여기서 대화를 기록 위치만 남기고 압축한 뒤 이어갑니다(`fallback`).
- 새 세션에서는 임계값을 처음부터 다시 셉니다.
- 세션을 끝내자는 메시지(`endPhrases`, 기본값은 `context-handoff`와 같음)는 그 턴이 끝나도 인계를 시작하지 않습니다.
- 대화형 터미널 세션 밖(`claude -p` 실행, SDK 호스트, 데스크톱 앱)에서는 아무것도 하지 않습니다. 그래서 스크립트로 돌리는 실행이 비워질 일은 없습니다. 거기서 `/handoff-now`를 쓰면 기록만 쓰고 새 세션은 시작되지 않는다고 알립니다.

#### 옵션

| 옵션 | 기본값 | 하는 일 |
| :- | :- | :- |
| `enabled` | 켜짐 | 임계값을 넘으면 자동으로 인계. 끄면 `/handoff-now`로만 인계. `/handoff-off`·`/handoff-on`으로 대화 하나만 바꿀 수 있음 |
| `threshold` | 40 | 인계를 시작하는 컨텍스트 창 사용률(%) |
| `retriggerStep` | 5 | 중단되거나 실패한 인계를 컨텍스트가 몇 포인트 더 찼을 때 다시 시도할지 |
| `fallback` | `compact` | `/clear`로 새 세션이 시작되지 않을 때: `compact`(여기서 기록 위치만 남기고 압축한 뒤 이어감) 또는 `none`(포기하고 알림) |
| `closeCommand` | `session-close` | 프로젝트에 있을 때 인계 기록용으로 실행하라고 지시할 스킬 |
| `closePrompt` | 비어 있음 | 내장 인계 프롬프트와 스킬 지시를 대체. `{percent}`, `{threshold}`가 채워짐 |
| `resumePrompt` | 비어 있음 | 새 세션에 제출하는 내장 프롬프트를 대체 |
| `endPhrases` | `세션 종료, session 종료, 세션 end, end session` | 쉼표로 구분한 문구. 이 중 하나의 단어가 순서·대소문자 무관하게 모두 든 메시지는 그 턴이 끝나도 인계를 시작하지 않음. 비우면 임계값을 넘은 모든 턴에서 인계 |

터미널 세션에서는 `/plugin configure context-handoff-cli@gun-marketplace`로 바꾸거나, 설치할 때 넘깁니다.

```bash
claude plugin install context-handoff-cli@gun-marketplace --config threshold=50
```

### session-end-unpin

`auto-pin`의 반대쪽입니다. 세션을 끝내자고 했을 때 Claude가 남은 일이 없다고 판단하면 고정을 해제합니다.

1. 문구(기본값은 `세션`·`session` 중 하나와 `종료`·`end` 중 하나, 순서·대소문자 무시, `end`는 따로 쓴 단어일 때만)가 들어 있는 메시지에 Claude용 메모를 붙입니다(Claude만 읽고 화면에는 보이지 않음). 먼저 프로젝트의 세션 종료 절차(진행 기록, 위키·지식 베이스 후보, 프로젝트에 있으면 종료 스킬)를 하고, 그다음 세션을 정말 끝내도 되는지 판단하라는 내용입니다.
2. 사용자를 기다리는 것(질문·결정·승인)이 없고, 끝나지 않은 작업이 없고, 제안할 후속 작업도 없을 때만 Claude가 mod의 `accept_session_end` 도구를 호출합니다. 무엇을 확인했는지 한 줄을 함께 넘깁니다.
3. 그 턴이 응답으로 끝나면 mod가 세션 고정을 해제하고, 토스트를 띄우고, 대화에 흐릿한 `session-end-unpin:` 줄을 남깁니다.

- 턴이 중단되거나 실패한 경우, 또는 같은 턴에서 Claude가 사용자에게 무언가를 묻거나(wrap-up의 질문, `AskUserQuestion`) 다른 세션을 제안·시작한 경우에는 고정을 유지합니다. `session-end-unpin:` 줄에 이유가 나옵니다.
- Claude가 먼저 물어봐야 하는 경우 다음 두 메시지까지는 종료 요청이 이어집니다. 답하면 그때 세션을 끝낼 수 있습니다.
- 세션 종료 방식에 관한 이야기처럼 문구가 들어 있기만 한 메시지는 Claude가 판단합니다. 메모에 그런 언급은 무시하라고 적혀 있습니다.
- 도구는 모든 세션의 도구 목록에 있지만, 사용자가 종료를 요청하지 않았으면 아무것도 기록하지 않습니다.
- [`context-handoff`](#context-handoff-1) 0.5.0 이상이나 [`context-handoff-cli`](#context-handoff-cli-1)와 함께 쓰면, 임계값을 넘었더라도 세션 종료 메시지는 새 세션으로 인계되지 않습니다. 두 mod의 문구를 같게 맞춰 두세요.
- auto 모드에서는 `auto-pin`의 고정과 같은 허용 규칙 `mcp__ccd_sidebar__set_pinned`가 필요합니다.
- 데스크톱 앱 밖에는 해제할 사이드바가 없으며, 그 사실을 줄로 남깁니다.

#### 옵션

| 옵션 | 기본값 | 하는 일 |
| :- | :- | :- |
| `phrases` | `세션 종료, session 종료, 세션 end, end session` | 쉼표로 구분한 문구. 이 중 하나의 단어가 순서·대소문자 무관하게 모두 들어 있는 메시지를 세션 종료 요청으로 봅니다. 영어 단어는 따로 쓴 경우만 셉니다(`send` 안의 `end`는 아님) |

### 제거

```bash
claude plugin uninstall context-meter@gun-marketplace
```

```bash
claude plugin uninstall auto-pin@gun-marketplace
```

```bash
claude plugin uninstall context-handoff@gun-marketplace
```

```bash
claude plugin uninstall context-handoff-cli@gun-marketplace
```

```bash
claude plugin uninstall session-end-unpin@gun-marketplace
```

### 라이선스

[MIT](LICENSE). 지원 없이 있는 그대로 공유합니다.
