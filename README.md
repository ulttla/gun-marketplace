# gun-marketplace

Claude Code and Codex plugins by [gunkr-com](https://github.com/gunkr-com). Add the marketplace to your CLI, then install a plugin by name.

This is an independent personal project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC.

**[English](#english)** · **[한국어](#한국어)**

---

## English

### Claude Code plugins

| Category | Plugin | What it does | Where it works |
| :- | :- | :- | :- |
| [mods](plugins/mods) | [`context-meter`](plugins/mods/context-meter) | Shows the git branch, how full the context window is, how much the last turn added, and how much of your plan limits you have used, in a band above the prompt | Terminal and the Desktop app's Code tab |
| [mods](plugins/mods) | [`auto-pin`](plugins/mods/auto-pin) | Pins a new session in the sidebar as soon as it starts | The Desktop app's Code tab |
| [mods](plugins/mods) | [`context-handoff`](plugins/mods/context-handoff) | Once the context window is 40% full, has Claude write hand-off notes and continues from them in a new Desktop app session | The Desktop app's Code tab |
| [mods](plugins/mods) | [`context-handoff-cli`](plugins/mods/context-handoff-cli) | Once the context window is 40% full, has Claude write hand-off notes, then starts a fresh session in the same terminal with `/clear` and continues from them | Terminal |
| [mods](plugins/mods) | [`session-end-unpin`](plugins/mods/session-end-unpin) | When you ask to end a session and Claude finds nothing left, unpins it from the sidebar | The Desktop app's Code tab |
| [herdr](plugins/herdr) | [`herdr-bg-status`](plugins/herdr/herdr-bg-status) | Keeps a session shown as working in [herdr](https://herdr.dev) while its background shells, agents or backgrounded MCP calls still run after the turn ends | Terminal, inside herdr |
| [herdr](plugins/herdr) | [`herdr-usage`](plugins/herdr/herdr-usage) | Shows Codex, Claude Code, Antigravity and Ollama Cloud subscription usage in the Herdr app's status bar, with a detail popup. Its skill installs it when you ask; also for Codex | The Herdr app (macOS, Linux, Windows) |

Each category's README has the details, options and requirements: [mods](plugins/mods/README.md), [herdr](plugins/herdr/README.md).

### Install Claude Code plugins

A plugin is code that runs with your permissions: it can read and write your files, start processes, and make network requests. Read the source before you install.

Add the marketplace:

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

Then install a plugin by name, for example:

```bash
claude plugin install context-meter@gun-marketplace
```

In a Claude Code session the same commands are `/plugin marketplace add gunkr-com/gun-marketplace` and `/plugin install context-meter@gun-marketplace`. A plugin loads the next time you start a session; in a session that is already open, run `/reload-plugins`.

### Codex plugins

[Codex Context Handoff](plugins/codex/codex-context-handoff) starts a fresh Codex chat in the same Herdr terminal when the active context exceeds 40% and work remains. Existing Herdr workers keep their parent terminal.

```bash
codex plugin marketplace add gunkr-com/gun-marketplace
codex plugin add codex-context-handoff@gun-marketplace
```

See the [setup guide](plugins/codex/codex-context-handoff/README.md) for hook review, the `codex` launcher that opts a Herdr terminal in, and the per-chat `handoff off|on|status` prompts.

[herdr-usage](plugins/herdr/herdr-usage) is in both catalogs. In Codex, install it with `codex plugin add herdr-usage@gun-marketplace`, then ask Codex to install herdr-usage.

### Moving from claude-mod-repo

The mods used to live in [`gunkr-com/claude-mod-repo`](https://github.com/gunkr-com/claude-mod-repo), which no longer gets updates. Plugins installed from it keep working as they are. To switch, install each mod again from here, then remove the old one, so it does not run twice:

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
claude plugin install context-meter@gun-marketplace
claude plugin uninstall context-meter@claude-mod-repo
```

Repeat the last two lines for each mod you use, then remove the old marketplace:

```bash
claude plugin marketplace remove claude-mod-repo
```

Options you set (`/plugin configure`) belong to the old plugin name, so set them again for the new one.

### License

[MIT](LICENSE)

---

## 한국어

### Claude Code 플러그인

| 분류 | 플러그인 | 하는 일 | 동작하는 곳 |
| :- | :- | :- | :- |
| [mods](plugins/mods) | [`context-meter`](plugins/mods/context-meter) | git 브랜치, 컨텍스트 창이 얼마나 찼는지, 직전 턴이 얼마나 늘렸는지, 플랜 한도를 얼마나 썼는지를 입력창 위 한 줄로 표시 | 터미널, 데스크톱 앱 Code 탭 |
| [mods](plugins/mods) | [`auto-pin`](plugins/mods/auto-pin) | 새 세션이 시작되면 사이드바에 바로 고정 | 데스크톱 앱 Code 탭 |
| [mods](plugins/mods) | [`context-handoff`](plugins/mods/context-handoff) | 컨텍스트 창이 40% 차면 Claude가 인계 기록을 쓰게 하고, 데스크톱 앱 새 세션에서 기록을 읽어 이어감 | 데스크톱 앱 Code 탭 |
| [mods](plugins/mods) | [`context-handoff-cli`](plugins/mods/context-handoff-cli) | 컨텍스트 창이 40% 차면 Claude가 인계 기록을 쓰게 하고, 같은 터미널에서 `/clear`로 새 세션을 시작해 기록을 읽어 이어감 | 터미널 |
| [mods](plugins/mods) | [`session-end-unpin`](plugins/mods/session-end-unpin) | 세션 종료를 요청했을 때 Claude가 남은 일이 없다고 판단하면 사이드바 고정을 해제 | 데스크톱 앱 Code 탭 |
| [herdr](plugins/herdr) | [`herdr-bg-status`](plugins/herdr/herdr-bg-status) | 턴이 끝난 뒤에도 백그라운드 셸·에이전트·백그라운드로 넘어간 MCP 호출이 돌고 있으면 [herdr](https://herdr.dev)에서 세션을 working으로 계속 표시 | 터미널(herdr 안) |
| [herdr](plugins/herdr) | [`herdr-usage`](plugins/herdr/herdr-usage) | Codex, Claude Code, Antigravity, Ollama Cloud 구독 사용량을 Herdr 앱 하단 바와 상세 팝업에 표시. 요청하면 플러그인의 스킬이 설치함. Codex용도 있음 | Herdr 앱(macOS, Linux, Windows) |

자세한 설명, 옵션, 요구 사항은 분류별 README에 있습니다: [mods](plugins/mods/README.md), [herdr](plugins/herdr/README.md).

### Claude Code 플러그인 설치

플러그인은 내 권한으로 실행되는 코드입니다. 파일을 읽고 쓰고, 프로세스를 띄우고, 네트워크 요청을 보낼 수 있습니다. 설치하기 전에 소스를 읽어 보세요.

마켓플레이스를 추가합니다.

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
```

그다음 플러그인을 이름으로 설치합니다. 예:

```bash
claude plugin install context-meter@gun-marketplace
```

Claude Code 세션 안에서는 같은 명령을 `/plugin marketplace add gunkr-com/gun-marketplace`, `/plugin install context-meter@gun-marketplace`로 입력합니다. 플러그인은 다음에 세션을 시작할 때 로드됩니다. 이미 열린 세션에서는 `/reload-plugins`를 실행합니다.

### Codex 플러그인

[Codex Context Handoff](plugins/codex/codex-context-handoff)는 컨텍스트 사용량이 40%를 넘고 할 일이 남아 있으면 같은 Herdr 터미널의 새 Codex 대화에서 이어갑니다. 실행 중인 Herdr 워커는 기존 부모 터미널에 연결된 상태로 유지됩니다.

```bash
codex plugin marketplace add gunkr-com/gun-marketplace
codex plugin add codex-context-handoff@gun-marketplace
```

훅 검토, Herdr 터미널에서 자동으로 활성화하는 `codex` 런처, 대화별 `handoff off|on|status` 명령은 [설정 가이드](plugins/codex/codex-context-handoff/README.md)를 참고하세요.

[herdr-usage](plugins/herdr/herdr-usage)는 두 카탈로그에 모두 있습니다. Codex에서는 `codex plugin add herdr-usage@gun-marketplace`로 설치한 뒤 Codex에게 herdr-usage 설치를 요청합니다.

### claude-mod-repo에서 옮기기

mod들은 원래 [`gunkr-com/claude-mod-repo`](https://github.com/gunkr-com/claude-mod-repo)에 있었고, 그 리포는 더 이상 업데이트되지 않습니다. 거기서 설치한 플러그인은 지금처럼 계속 동작합니다. 옮기려면 각 mod를 여기서 다시 설치한 뒤 옛 것을 제거합니다. 그래야 두 번 실행되지 않습니다.

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
claude plugin install context-meter@gun-marketplace
claude plugin uninstall context-meter@claude-mod-repo
```

쓰는 mod마다 마지막 두 줄을 반복한 뒤 옛 마켓플레이스를 제거합니다.

```bash
claude plugin marketplace remove claude-mod-repo
```

`/plugin configure`로 바꾼 옵션은 옛 플러그인 이름에 묶여 있으므로 새 플러그인에서 다시 설정합니다.

### 라이선스

[MIT](LICENSE)
