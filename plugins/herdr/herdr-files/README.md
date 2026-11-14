# herdr-files

A Files panel for the [Herdr](https://herdr.dev) app that can go to parent and other folders, and edit local Markdown and text files with an explicit, conflict-guarded Save.

**[English](#english)** · **[한국어](#한국어)**

---

## English

herdr-files replaces the mod behind Herdr's Files panel (the one the tab bar's Files button opens) in a personal layout. It keeps everything the shipped panel does (the lazy tree, git marks, the 10-second refresh) and adds:

- **Other folders.**
  - `↑` goes to the parent folder.
  - `Open…` picks a folder with the system dialog.
  - `Path` takes a typed or pasted path. Spaces, quotes, `My\ Folder` escapes, `~` and relative paths work, and the folder is checked before the panel switches to it.
  - `Project` goes back to following the focused pane's folder.
  - The chosen folder is kept per space. The full path and a `manual` mark show under the header.
- **Editing local Markdown and text.**
  - `.md`, `.markdown`, `.mdx`, `.txt`, `.text` and files with no extension open in an editor.
  - The header shows `●` and `Modified` while there are unsaved changes, with Revert and Save buttons.
  - Nothing is written until you press Save or Cmd-S/Ctrl-S.
- **No silent overwrite.**
  - Save writes only if the file is still what was opened (Herdr's `writeTextFile` with an expected snapshot).
  - If it changed on disk, you choose: discard yours and reload, overwrite the disk (checked again against what is there now), or copy yours to the clipboard.
  - If it was deleted, you can recreate it.
- **No lost edits inside the panel.**
  - Closing the file or opening another one with unsaved changes asks to Save, Discard or Cancel.
  - Switching spaces or panes keeps an unsaved document open.
  - Slow loads that were overtaken are dropped.

Read-only, with a label:

- remote files (a space on another machine)
- files over 400,000 characters or near the 1 MiB read limit (shown truncated)
- other file types (code, JSON, …)

Binary files show no text.

### Requirements

- macOS or Linux. Checked on macOS with Herdr 0.1.15 (`herdr-app check`, an installer smoke run against a temporary Herdr home, and the self-test of an equivalent local copy); not reviewed visually. Linux runs the automated tests only. Windows is not supported: path handling is POSIX.
- The Herdr app, opened at least once (`herdr-app` on `PATH`, in `~/.local/bin`, or set `HERDR_APP_BIN`).
- Node.js 22 or newer for the installer (tested with 24). The mod itself runs inside Herdr.
- A personal layout with a block whose id is `files`, such as a copy of Herdr's main layout. The installer can make that copy for you.

### Install

The plugin carries a skill, `herdr-files`, for Claude Code and Codex. Installing the plugin installs nothing in Herdr; ask the agent to "install herdr-files" and it runs the bundled installer after telling you what changes.

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
claude plugin install herdr-files@gun-marketplace
```

```bash
codex plugin marketplace add gunkr-com/gun-marketplace
codex plugin add herdr-files@gun-marketplace
```

Or run the installer yourself from a checkout or the installed plugin folder:

```bash
node install.mjs                                    # the mod, and the selected layout if it is a personal one
node install.mjs --layout my-layout                 # the mod, and that personal layout
node install.mjs --create-layout files --from main  # the mod, and a new personal copy of main (not shown)
node install.mjs --no-layout                        # the mod only
node status.mjs                                     # what is installed (exits 1 if not)
```

The installer never switches layouts and never changes focus, spaces, tabs or panes; Herdr reloads an edited layout in place. To show a created layout:

```bash
herdr-app do layout.switch '{"name":"files"}'
```

Herdr's own layouts (`main`, `terminals`, `win98`) are replaced on every start, so the installer never edits them. If one of them is selected, it installs only the mod and tells you to use `--create-layout`.

### What changes

- `<Herdr home>/mods/herdr-files`: the mod. The Herdr home is `$HERDR_APP_HOME`, or `~/.config/herdr-app`.
- In one personal layout, only the block with id `files` changes from `"mod": "files"` to `"mod": "herdr-files"`. The id stays, so the tab bar's Files button still opens it. A block that shows any other mod is left alone, and the installer stops.
- `<Herdr home>/herdr-files/`:
  - `install.json`: which layouts were changed, and what each block showed before.
  - `backups/`: a copy of each layout before its first change.

Everything is checked before the layout, the mod folder or the state is written (platform, Node.js, Herdr home, `herdr-app`, name collisions, the layout, and `herdr-app check` of the staged mod); a failed check changes nothing. If writing fails partway, the installer puts the previous mod, layout and state back. Running it again updates in place, keeps the recorded original and makes no new backup when nothing changes.

The mod runs programs through Herdr: `sh` to list folders, `git` for status marks, and `test -d` and `mktemp` for the path check and the self-test. It reads and writes files only through Herdr's file API, and makes no network requests.

### Update

Update the plugin (`claude plugin update herdr-files@gun-marketplace`, or `codex plugin add` again), then run `install.mjs` again from the new plugin folder, or ask the agent to update herdr-files.

### Uninstall

```bash
node uninstall.mjs
```

- In each recorded layout, the `files` block goes back to `files`, but only while it still shows `herdr-files`.
- A layout the installer created is deleted only if it is unchanged and not the selected one; otherwise it is kept with its block restored.
- The mod and `<Herdr home>/herdr-files` are removed only when no layout still shows the mod and every layout file can be read. Otherwise it keeps them, says why, and exits 1.
- It never switches layouts.

### Limits

- Unsaved text lives in the panel. It is lost if the panel restarts: a layout switch, quitting Herdr, or an update of the mod's files. The panel asks before closing a file, but nothing can ask before Herdr itself closes it.
- The panel does not warn while you edit that the file changed on disk. Save catches it.
- Remote files are read-only: Herdr's `writeTextFile` writes only on this computer. The system folder picker is local only too.
- Only the extensions above are editable; other text files are read-only previews.
- Paths are POSIX. On Windows the shipped panel's folder listing is kept, but navigation and editing are not supported.
- There is no automated visual test of the panel; the tests cover its logic, the installer, and (through the self-test) Herdr's real file and editor APIs.

### Self-test

While the panel is shown, run:

```bash
herdr-app do herdr-files.selftest
```

It drives the editor with Herdr's real `readTextFile`, `writeTextFile` and editor in a fresh `/tmp/herdr-files-selftest.XXXXXX` folder: edit, save, external change, overwrite, delete and recreate, stale load, truncated, binary and read-only files. It writes nothing outside that folder, and posts the result as a notification with the path to `result.json`.

### Tests

```bash
npm test          # or: node --test test/*.test.mjs
node test/catalog-check.mjs
```

- `test/core.test.mjs` drives the document logic with fake file IO: dirty state, guarded saves, conflicts, deletion, saves in flight, stale loads, and the unsaved-changes prompt.
- `test/setup.test.mjs` runs install, update, status and uninstall against a temporary Herdr home and a stub `herdr-app`. It covers rollback after a write failure, refusals, ownership and unreadable layouts, and proves no window command is sent.

### License

MIT for this package's own code. `mod/herdr-files/main.js` is a modified version of Herdr's shipped `files` mod and stays under the Apache License 2.0. The four icons are Lucide (ISC; the chevrons come from Feather, MIT). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), [LICENSE](LICENSE) and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). This package is not affiliated with Herdr.

---

## 한국어

herdr-files는 개인 레이아웃에서 Herdr의 Files 패널(탭 바의 Files 버튼으로 여는 패널) 뒤에 있는 mod를 바꿉니다. 기본 패널이 하던 일(필요할 때 펼치는 트리, git 표시, 10초 새로 고침)은 그대로 하고, 다음을 더합니다.

- **다른 폴더로 이동.**
  - `↑`는 상위 폴더로 갑니다.
  - `Open…`은 시스템 대화 상자로 폴더를 고릅니다.
  - `Path`는 입력하거나 붙여 넣은 경로로 갑니다. 공백, 따옴표, `My\ Folder` 같은 이스케이프, `~`, 상대 경로를 받고, 옮기기 전에 폴더인지 확인합니다.
  - `Project`는 다시 포커스된 pane의 폴더를 따라갑니다.
  - 고른 폴더는 space마다 따로 기억합니다. 헤더 아래에 전체 경로와 `manual` 표시가 보입니다.
- **로컬 Markdown·텍스트 편집.**
  - `.md`, `.markdown`, `.mdx`, `.txt`, `.text`와 확장자 없는 파일은 편집기로 열립니다.
  - 저장하지 않은 변경이 있으면 헤더에 `●`와 `Modified`가 뜨고, Revert와 Save 버튼이 생깁니다.
  - Save나 Cmd-S/Ctrl-S를 누르기 전에는 아무것도 쓰지 않습니다.
- **조용히 덮어쓰지 않음.**
  - Save는 파일이 연 때와 같을 때만 씁니다(Herdr `writeTextFile`의 expected 스냅샷).
  - 디스크에서 바뀌었으면 고르게 합니다: 내 수정을 버리고 다시 읽기, 디스크 덮어쓰기(지금 디스크 내용을 기준으로 다시 확인), 내 수정을 클립보드로 복사.
  - 지워졌으면 다시 만들 수 있습니다.
- **패널 안에서 수정을 잃지 않음.**
  - 저장하지 않은 변경이 있는 채로 파일을 닫거나 다른 파일을 열면 Save, Discard, Cancel을 묻습니다.
  - space나 pane을 바꿔도 저장하지 않은 문서는 열린 채 남습니다.
  - 늦게 끝난 이전 로드는 버립니다.

다음은 라벨을 붙여 읽기 전용으로 엽니다.

- 원격 파일(다른 머신의 space)
- 400,000자를 넘거나 1 MiB 읽기 한도에 가까운 파일(잘라서 표시)
- 그 밖의 형식(코드, JSON 등)

바이너리 파일은 내용을 보여 주지 않습니다.

### 요구 사항

- macOS 또는 Linux. macOS의 Herdr 0.1.15에서 `herdr-app check`, 임시 Herdr home 대상 설치 smoke, 같은 내용의 로컬 사본 self-test로 확인했고, 화면은 따로 검토하지 않았습니다. Linux에서는 자동 테스트만 돌립니다. Windows는 지원하지 않습니다(경로 처리가 POSIX 기준).
- 한 번 이상 실행한 Herdr 앱(`herdr-app`이 `PATH`나 `~/.local/bin`에 있거나 `HERDR_APP_BIN` 설정)
- 설치 스크립트용 Node.js 22 이상(24로 시험). mod는 Herdr 안에서 돕니다.
- id가 `files`인 블록이 있는 개인 레이아웃(예: Herdr main 레이아웃의 복사본). 설치 스크립트가 복사본을 만들어 줄 수 있습니다.

### 설치

플러그인에는 Claude Code와 Codex용 스킬 `herdr-files`가 들어 있습니다. 플러그인을 설치해도 Herdr에는 아무것도 설치되지 않습니다. 에이전트에게 "herdr-files 설치"를 요청하면, 무엇이 바뀌는지 알린 뒤 들어 있는 설치 스크립트를 실행합니다.

```bash
claude plugin marketplace add gunkr-com/gun-marketplace
claude plugin install herdr-files@gun-marketplace
```

```bash
codex plugin marketplace add gunkr-com/gun-marketplace
codex plugin add herdr-files@gun-marketplace
```

또는 checkout이나 설치된 플러그인 폴더에서 직접 실행합니다.

```bash
node install.mjs                                    # mod, 그리고 선택된 레이아웃이 개인 레이아웃이면 그 레이아웃
node install.mjs --layout my-layout                 # mod, 그리고 지정한 개인 레이아웃
node install.mjs --create-layout files --from main  # mod, 그리고 main의 새 개인 복사본(표시하지 않음)
node install.mjs --no-layout                        # mod만
node status.mjs                                     # 설치 상태(설치되지 않았으면 exit 1)
```

설치 스크립트는 레이아웃을 전환하지 않고 포커스, space, 탭, pane도 바꾸지 않습니다. Herdr가 바뀐 레이아웃 파일을 그 자리에서 다시 읽습니다. 만든 레이아웃을 보려면 다음을 실행합니다.

```bash
herdr-app do layout.switch '{"name":"files"}'
```

Herdr 자체 레이아웃(`main`, `terminals`, `win98`)은 시작할 때마다 새로 덮어쓰이므로 설치 스크립트가 고치지 않습니다. 그중 하나가 선택돼 있으면 mod만 설치하고 `--create-layout`을 쓰라고 알려 줍니다.

### 바뀌는 것

- `<Herdr home>/mods/herdr-files`: mod. Herdr home은 `$HERDR_APP_HOME`, 없으면 `~/.config/herdr-app`입니다.
- 개인 레이아웃 하나에서 id가 `files`인 블록만 `"mod": "files"`에서 `"mod": "herdr-files"`로 바뀝니다. id는 그대로라 탭 바의 Files 버튼으로 계속 열 수 있습니다. 다른 mod를 보여 주는 블록은 건드리지 않고 설치를 멈춥니다.
- `<Herdr home>/herdr-files/`:
  - `install.json`: 바꾼 레이아웃과 각 블록이 원래 보여 주던 mod
  - `backups/`: 레이아웃을 처음 바꾸기 전의 사본

레이아웃, mod 폴더, 상태를 쓰기 전에 모두 확인합니다(플랫폼, Node.js, Herdr home, `herdr-app`, 이름 충돌, 레이아웃, 미리 복사한 mod의 `herdr-app check`). 확인에 실패하면 아무것도 바꾸지 않습니다. 쓰는 도중 실패하면 이전 mod, 레이아웃, 상태를 되돌립니다. 다시 실행하면 그 자리에서 업데이트하고, 기록한 원래 값을 유지하며, 바뀐 게 없으면 새 백업을 만들지 않습니다.

mod는 Herdr를 통해 프로그램을 실행합니다. 폴더 목록에 `sh`, 상태 표시에 `git`, 경로 확인과 self-test에 `test -d`와 `mktemp`를 씁니다. 파일은 Herdr 파일 API로만 읽고 쓰며, 네트워크 요청은 하지 않습니다.

### 업데이트

플러그인을 업데이트한 뒤(`claude plugin update herdr-files@gun-marketplace`, 또는 `codex plugin add` 다시 실행) 새 플러그인 폴더에서 `install.mjs`를 다시 실행하거나, 에이전트에게 herdr-files 업데이트를 요청합니다.

### 제거

```bash
node uninstall.mjs
```

- 기록된 레이아웃마다 `files` 블록을 `files`로 되돌립니다. 아직 `herdr-files`를 보여 줄 때만 되돌립니다.
- 설치 스크립트가 만든 레이아웃은 바뀌지 않았고 선택된 레이아웃이 아닐 때만 지웁니다. 아니면 블록만 되돌리고 남겨 둡니다.
- mod와 `<Herdr home>/herdr-files`는 어떤 레이아웃도 mod를 보여 주지 않고 모든 레이아웃 파일을 읽을 수 있을 때만 지웁니다. 아니면 남겨 두고 이유를 알린 뒤 exit 1로 끝납니다.
- 레이아웃을 전환하지 않습니다.

### 한계

- 저장하지 않은 텍스트는 패널 안에만 있습니다. 패널이 다시 시작되면(레이아웃 전환, Herdr 종료, mod 파일 업데이트) 사라집니다. 패널은 파일을 닫기 전에 묻지만, Herdr가 패널 자체를 닫을 때는 물을 방법이 없습니다.
- 편집 중에 디스크 파일이 바뀌어도 바로 알리지 않습니다. Save할 때 잡아냅니다.
- 원격 파일은 읽기 전용입니다. Herdr `writeTextFile`은 이 컴퓨터에서만 씁니다. 시스템 폴더 선택 창도 로컬 전용입니다.
- 위 확장자만 편집할 수 있고, 다른 텍스트 파일은 읽기 전용 미리 보기입니다.
- 경로는 POSIX 기준입니다. Windows에서는 기본 패널의 폴더 목록 코드가 남아 있지만 이동과 편집은 지원하지 않습니다.
- 패널 화면을 자동으로 확인하는 테스트는 없습니다. 테스트는 로직, 설치 스크립트, 그리고 (self-test로) Herdr의 실제 파일·편집기 API를 다룹니다.

### Self-test

패널이 보이는 동안 다음을 실행합니다.

```bash
herdr-app do herdr-files.selftest
```

새 `/tmp/herdr-files-selftest.XXXXXX` 폴더에서 Herdr의 실제 `readTextFile`, `writeTextFile`과 편집기로 편집, 저장, 외부 변경, 덮어쓰기, 삭제 후 다시 만들기, 늦은 로드, 잘린·바이너리·읽기 전용 파일을 확인합니다. 그 폴더 밖에는 쓰지 않으며, 결과를 `result.json` 경로와 함께 알림으로 띄웁니다.

### 테스트

```bash
npm test          # 또는: node --test test/*.test.mjs
node test/catalog-check.mjs
```

- `test/core.test.mjs`는 가짜 파일 IO로 문서 로직을 검사합니다: 수정 상태, 확인을 거치는 저장, 충돌, 삭제, 진행 중인 저장, 늦은 로드, 저장 안 한 변경 확인.
- `test/setup.test.mjs`는 임시 Herdr home과 가짜 `herdr-app`으로 설치, 업데이트, 상태, 제거를 돌립니다. 쓰기 실패 후 되돌리기, 거부, 소유 확인, 읽을 수 없는 레이아웃을 다루고, 창에 명령을 보내지 않는다는 것도 확인합니다.

### 라이선스

이 패키지의 자체 코드는 MIT입니다. `mod/herdr-files/main.js`는 Herdr 기본 `files` mod를 고친 파일이라 Apache License 2.0을 따릅니다. 아이콘 네 개는 Lucide(ISC, chevron은 Feather에서 온 MIT)입니다. 자세한 내용은 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), [LICENSE](LICENSE), [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)를 보세요. 이 패키지는 Herdr와 관계가 없습니다.
