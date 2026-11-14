# herdr

Plugins that connect Claude Code to [herdr](https://herdr.dev), the terminal and agent-session app (Herdr.app with the `herdr-core` CLI, `hc`).

**[English](#english)** · **[한국어](#한국어)**

---

## English

| Plugin | What it does |
| :- | :- |
| [`herdr-bg-status`](herdr-bg-status) | Keeps a Claude Code session shown as **working** in herdr while its background work still runs after the turn ends |
| [`herdr-usage`](herdr-usage) | Shows Codex, Claude Code, Antigravity and Ollama Cloud subscription usage in the Herdr app's status bar, with a detail popup |
| [`herdr-files`](herdr-files) | A Files panel for the Herdr app that goes to parent and other folders and edits local Markdown and text files with an explicit, conflict-guarded Save |

### herdr-bg-status

Claude Code tells herdr its status itself (OSC 7501), but only for the turn it is running: when the turn ends it reports **done** or **idle**, even while a background shell or a backgrounded MCP call is still going. herdr then shows the session as finished while it is not.

This plugin adds a `Stop` hook. When a turn ends with background work left, it starts a small watcher that reports **working** (with a note such as `background: 1 shell` or `background: aside/exec`) whenever Claude Code reports done or idle. It leaves Claude Code's own working, blocked and error reports alone. When the work ends, Claude Code normally starts a new turn for the task notification and reports for itself again; if it does not within a few seconds, the watcher reports **done**, so the status does not stay stuck.

What counts as background work:

| Work | How it is found |
| :- | :- |
| Background shells (`run_in_background`, Ctrl+B, Monitor) | Shells Claude Code started that are still running after the turn ended |
| Background agents | The per-task status records Claude Code already sends to herdr |
| MCP calls moved to the background (for example after running for 120 s) | The session transcript, from the "moved to the background as task …" result to its task notification. Not counted after 30 minutes |

A shell whose processes listen on a TCP port, such as a dev server, is not counted: a server left running is not work in progress.

#### Requirements

- herdr, with Claude Code running in a herdr terminal (the hook does nothing elsewhere)
- macOS. Linux is untested.
- `python3` on your `PATH`, and `lsof` (to tell dev servers apart)

#### Install

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

```bash
claude plugin install herdr-bg-status@gun-marketplace
```

#### Turn it off

- For one session: start Claude Code with `HERDR_BG_STATUS=0`.
- For good: `claude plugin disable herdr-bg-status@gun-marketplace`.

#### Limits

- It relies on how Claude Code names its shell snapshots, words its background-task messages and sends OSC 7501. If a Claude Code update changes these, the plugin stops finding the work and herdr falls back to Claude Code's own status; it does not make things worse.
- Backgrounded MCP calls made inside a subagent are not tracked.
- What it did and why is logged to `~/.cache/claude-herdr-bg/watch.log`.

### herdr-usage

A status bar for the Herdr app (a copy of Herdr's main layout) that adds how much of each subscription window is left, and a popup with every window, its reset time and when the value was observed. The plugin ships a skill; nothing is installed until you ask for it. It works with Claude Code and Codex.

```bash
claude plugin install herdr-usage@gun-marketplace     # or: codex plugin add herdr-usage@gun-marketplace
```

Then ask the agent to install herdr-usage. Requirements, what it changes, update and uninstall: [herdr-usage/README.md](herdr-usage/README.md).

### herdr-files

Replaces the mod behind the Herdr app's Files panel in a personal layout. The panel gains parent, picked and typed folders, and editing of local Markdown and text files. Nothing is written until you Save, and Save never overwrites a file that changed on disk. Remote, truncated and other files stay read-only. The installer changes only the layout's `files` block and never switches layouts. macOS and Linux. The plugin ships a skill; nothing is installed until you ask for it. It works with Claude Code and Codex.

```bash
claude plugin install herdr-files@gun-marketplace     # or: codex plugin add herdr-files@gun-marketplace
```

Then ask the agent to install herdr-files. Requirements, what it changes, limits and uninstall: [herdr-files/README.md](herdr-files/README.md).

---

## 한국어

| 플러그인 | 하는 일 |
| :- | :- |
| [`herdr-bg-status`](herdr-bg-status) | 턴이 끝난 뒤에도 백그라운드 작업이 돌고 있으면 herdr에서 Claude Code 세션을 **working**으로 계속 보여 줍니다 |
| [`herdr-usage`](herdr-usage) | Codex, Claude Code, Antigravity, Ollama Cloud 구독 사용량을 Herdr 앱 하단 바와 상세 팝업에 보여 줍니다 |
| [`herdr-files`](herdr-files) | Herdr 앱 Files 패널에서 상위·다른 폴더로 이동하고, 로컬 Markdown·텍스트 파일을 편집해 확인을 거쳐 저장합니다 |

### herdr-bg-status

Claude Code는 자기 상태를 herdr에 직접 알립니다(OSC 7501). 하지만 지금 돌고 있는 턴만 기준으로 합니다. 그래서 턴이 끝나면 백그라운드 셸이나 백그라운드로 넘어간 MCP 호출이 아직 돌고 있어도 **done**이나 **idle**로 보고합니다. herdr에는 작업이 끝나지 않았는데도 끝난 것처럼 보입니다.

이 플러그인은 `Stop` 훅을 추가합니다. 백그라운드 작업이 남은 채 턴이 끝나면 작은 감시 프로세스를 띄웁니다. 감시 프로세스는 Claude Code가 done이나 idle을 보고할 때마다 **working**으로 바꿔 보고합니다. 이때 `background: 1 shell`, `background: aside/exec` 같은 메모를 붙입니다. Claude Code가 직접 보내는 working, blocked, error는 건드리지 않습니다. 작업이 끝나면 Claude Code는 보통 완료 알림을 처리하려고 새 턴을 열고 다시 직접 보고합니다. 몇 초 안에 새 턴이 열리지 않으면 감시 프로세스가 **done**으로 정리합니다. 그래서 상태가 working에 멈춰 있지 않습니다.

백그라운드 작업으로 세는 것:

| 작업 | 찾는 방법 |
| :- | :- |
| 백그라운드 셸(`run_in_background`, Ctrl+B, Monitor) | 턴이 끝난 뒤에도 돌고 있는, Claude Code가 띄운 셸 |
| 백그라운드 에이전트 | Claude Code가 herdr에 이미 보내는 작업별 상태 기록 |
| 백그라운드로 넘어간 MCP 호출(예: 120초를 넘긴 호출) | 세션 기록(transcript)에서 "moved to the background as task …" 결과부터 완료 알림까지 추적. 30분이 지나면 세지 않음 |

dev 서버처럼 프로세스가 TCP 포트를 열고 대기 중인 셸은 세지 않습니다. 켜 둔 서버는 진행 중인 작업이 아니기 때문입니다.

#### 요구 사항

- herdr, 그리고 herdr 터미널에서 실행한 Claude Code. 다른 곳에서는 훅이 아무것도 하지 않습니다.
- macOS. Linux는 시험하지 않았습니다.
- `PATH`에 있는 `python3`, 그리고 dev 서버를 구분하는 데 쓰는 `lsof`

#### 설치

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

```bash
claude plugin install herdr-bg-status@gun-marketplace
```

#### 끄기

- 한 세션만: `HERDR_BG_STATUS=0`을 설정하고 Claude Code를 시작합니다.
- 계속: `claude plugin disable herdr-bg-status@gun-marketplace`

#### 한계

- Claude Code가 셸 스냅샷 이름을 붙이는 방식, 백그라운드 작업 안내 문구, OSC 7501 형식에 기대어 동작합니다. Claude Code 업데이트로 이것들이 바뀌면 작업을 찾지 못하게 됩니다. 그때 herdr는 Claude Code 자체 상태로 돌아갈 뿐, 지금보다 나빠지지는 않습니다.
- 서브에이전트 안에서 백그라운드로 넘어간 MCP 호출은 추적하지 않습니다.
- 무엇을 했고 왜 했는지는 `~/.cache/claude-herdr-bg/watch.log`에 남습니다.

### herdr-usage

Herdr 앱의 하단 바(Herdr 기본 main 레이아웃의 복사본)에 구독 한도 창마다 남은 비율을 더하고, 클릭하면 모든 창의 리셋 시각과 값을 받은 시각을 보여 주는 팝업을 엽니다. 플러그인에는 스킬이 들어 있고, 요청하기 전에는 아무것도 설치하지 않습니다. Claude Code와 Codex에서 쓸 수 있습니다.

```bash
claude plugin install herdr-usage@gun-marketplace     # 또는: codex plugin add herdr-usage@gun-marketplace
```

그다음 에이전트에게 herdr-usage 설치를 요청합니다. 요구 사항, 바뀌는 것, 업데이트와 제거: [herdr-usage/README.md](herdr-usage/README.md#한국어)

### herdr-files

개인 레이아웃에서 Herdr 앱 Files 패널의 mod를 바꿉니다. 패널에서 상위 폴더, 고른 폴더, 입력한 폴더로 갈 수 있고, 로컬 Markdown·텍스트 파일을 편집할 수 있습니다. Save를 누르기 전에는 쓰지 않고, 디스크에서 바뀐 파일은 덮어쓰지 않습니다. 원격, 잘린 파일, 그 밖의 형식은 읽기 전용입니다. 설치 스크립트는 레이아웃의 `files` 블록만 바꾸고 레이아웃을 전환하지 않습니다. macOS와 Linux용입니다. 플러그인에는 스킬이 들어 있고, 요청하기 전에는 아무것도 설치하지 않습니다. Claude Code와 Codex에서 쓸 수 있습니다.

```bash
claude plugin install herdr-files@gun-marketplace     # 또는: codex plugin add herdr-files@gun-marketplace
```

그다음 에이전트에게 herdr-files 설치를 요청합니다. 요구 사항, 바뀌는 것, 한계와 제거: [herdr-files/README.md](herdr-files/README.md#한국어)
