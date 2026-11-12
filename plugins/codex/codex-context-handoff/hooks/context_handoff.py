#!/usr/bin/env python3
"""Rotate an opted-in Codex CLI chat without replacing its Herdr terminal."""

import fcntl
import json
import math
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
TERMINAL = re.compile(r"t[0-9a-z]+\Z")
# Found anywhere in a prompt, so a continuation mixed with other text is caught too.
RESUME = re.compile(r"Codex Context Handoff: ([\w-]+) ([\w-]+) ([0-9a-f]{24})(?![0-9a-f])")
COMPOSER = re.compile(r"^›(?:\s+Ask Codex to do anything)?\s*$")
PLACEHOLDER = "› Ask Codex to do anything"
TRANSCRIPT_TAIL = 4 * 1024 * 1024
MAX_NOTE = 12_000
POLL = 0.2
CLEAR_ECHO = 3.0  # seconds after /clear in which the old status and screen may still show
SETTLE = 2.0  # seconds the fresh chat must stay idle with an empty prompt before the continuation
CONTROLS = {
    "handoff off": "off", "handoff cancel": "off", "handoff on": "on", "handoff status": "status",
    "핸드오프 끄기": "off", "핸드오프 취소": "off", "핸드오프 켜기": "on", "핸드오프 상태": "status",
}
CLOSING = {"end session", "wrap up", "세션 종료", "마무리"}
DONE = (".received", ".cancelled", ".closed")
RESTART = (
    "Exit Codex, then reopen this chat with `codex resume {session}` in this Herdr terminal so the "
    "launcher adds --no-daemon and CODEX_CONTEXT_HANDOFF=1."
)
HC_ENV = {key: value for key, value in os.environ.items() if key != "HC_TERMINAL_ID"}


def transcript_rows(path, tail=TRANSCRIPT_TAIL):
    with Path(path).open("rb") as stream:
        offset = max(stream.seek(0, os.SEEK_END) - tail, 0)
        stream.seek(offset)
        if offset:
            stream.readline()
        for line in stream:
            if b'"event_msg"' not in line and b'"compacted"' not in line:
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(row, dict) and isinstance(row.get("payload"), dict):
                yield row.get("type"), row["payload"]


def recent_turn(path):
    """Read the latest turn only, ignoring usage preceding a compaction.

    A long turn can start before the usual tail window; widen it until the turn's start shows.
    """
    tail = TRANSCRIPT_TAIL
    while True:
        turn = None
        for row_type, event in transcript_rows(path, tail):
            kind = event.get("type")
            if row_type == "compacted" and turn:
                turn["usage"] = None
            if row_type != "event_msg":
                continue
            if kind == "task_started":
                turn = {"id": event.get("turn_id"), "usage": None, "complete": False}
            elif turn and kind == "token_count":
                turn["usage"] = event.get("info")
            elif turn and kind == "task_complete" and event.get("turn_id") == turn["id"]:
                turn["complete"] = True
        if turn or tail >= os.path.getsize(path):
            return turn
        tail *= 4


def last_usage(path):
    usage = None
    for row_type, event in transcript_rows(path):
        if row_type == "compacted":
            usage = None
        elif event.get("type") == "token_count":
            usage = event.get("info")
    return usage


def is_interactive_root(transcript, session):
    with Path(transcript).open("rb") as stream:
        row = json.loads(stream.readline(1024 * 1024))
    if not isinstance(row, dict) or row.get("type") != "session_meta":
        return False
    meta = row.get("payload")
    return (
        isinstance(meta, dict)
        # A daemon-born chat resumed under --no-daemon keeps source "vscode"; the
        # foreground process-tree check still excludes real IDE and daemon hooks.
        and meta.get("source") in {"cli", "vscode"} and meta.get("thread_source") == "user"
        and meta.get("id") == session and meta.get("session_id") == session
    )

def usage_percent(usage):
    if not isinstance(usage, dict):
        return None
    last = usage.get("last_token_usage")
    used = last.get("total_tokens") if isinstance(last, dict) else None
    window = usage.get("model_context_window")
    if type(used) is int and used >= 0 and type(window) is int and window > 0:
        return 100 * used / window
    return None


def env_number(name, default, low, high, inclusive=False):
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        return None
    ok = low <= value <= high if inclusive else low < value < high
    return value if math.isfinite(value) and ok else None


def threshold():
    return env_number("CODEX_CONTEXT_HANDOFF_THRESHOLD", "40", 0, 100)


def grace():
    value = env_number("CODEX_CONTEXT_HANDOFF_GRACE", "10", 0, 60, inclusive=True)
    return 10.0 if value is None else value


def startup_wait():
    value = env_number("CODEX_CONTEXT_HANDOFF_STARTUP_WAIT", "150", 12, 600, inclusive=True)
    return 150.0 if value is None else value


def exceeds_threshold(usage, threshold):
    if not isinstance(usage, dict):
        return False
    last = usage.get("last_token_usage")
    used = last.get("total_tokens") if isinstance(last, dict) else None
    window = usage.get("model_context_window")
    return (
        type(used) is int and used >= 0 and type(window) is int and window > 0
        and 100 * used > threshold * window
    )


def hc(*args):
    result = subprocess.run(
        ["hc", *args], check=True, capture_output=True, text=True, timeout=8, env=HC_ENV
    )
    return json.loads(result.stdout)


def same_cwd(left, right):
    return isinstance(left, str) and isinstance(right, str) and (
        Path(left).resolve() == Path(right).resolve()
    )


def in_foreground_tree(pid):
    current = os.getpid()
    while current > 1:
        if current == pid:
            return True
        row = subprocess.check_output(
            ["ps", "-o", "ppid=", "-o", "comm=", "-p", str(current)], text=True, timeout=2
        )
        parent, command = row.strip().split(maxsplit=1)
        if Path(command).name == "codex":
            return False
        current = int(parent)
    return False


def terminal_info(terminal, cwd, expected_pid=None):
    info = hc("get", terminal)
    foreground = info.get("foreground") or {}
    if (
        info.get("state") != "live" or foreground.get("name") != "codex"
        or not same_cwd(foreground.get("cwd"), cwd)
    ):
        return None
    pid = foreground.get("pid")
    if type(pid) is not int or (expected_pid is not None and expected_pid != pid):
        return None
    return info


def new_private_file(path, content):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(content)
    return True


def store_for(root, session, turn):
    if not ID.fullmatch(session) or not ID.fullmatch(turn):
        raise ValueError("invalid session or turn id")
    return root / session / turn


def handoff_request(nonce):
    return (
        "The context threshold was crossed. Prepare a handoff now if any work can continue "
        "without user input, including work reserved for the fresh chat. Do not perform that "
        "remaining work in this chat. Start your final answer with this exact plain-text line "
        "so the handoff can run:\n"
        f"HANDOFF READY {nonce}\n"
        "Then write a short Markdown handoff with the goal, user constraints, decisions, "
        "worktree and branch, changes, validation, next action, and the IDs and state of any "
        "live Herdr workers. Include only necessary work context. If everything is complete, "
        "the user asked to end, or the remaining work needs the user or an approval, respond "
        "normally and omit the marker."
    )


def nudge(limit):
    return (
        f"Codex Context Handoff: this chat has passed {limit:g}% of its context window. Do not "
        "abandon the current step. If work will remain after this turn, bring it to a safe "
        "checkpoint (no half-applied edits; note running workers), avoid starting large new "
        "subtasks, and end the turn soon; the Stop hook will then ask for a handoff note and "
        "continue in a fresh chat. If the task is nearly done, finish it normally."
    )


def ids(payload):
    session = payload.get("session_id") or ""
    turn = payload.get("turn_id") or ""
    return (session, turn) if ID.fullmatch(session) and ID.fullmatch(turn) else (None, None)


def disabled(root, session, turn):
    return (root / session / ".off").exists() or (root / session / f"{turn}.skip").is_file()


def check_chat(payload, terminal):
    """Return (Herdr info, None) for the opted-in foreground root chat, else (None, why not)."""
    session = payload.get("session_id") or ""
    if os.environ.get("CODEX_CONTEXT_HANDOFF") != "1":
        return None, (
            "this Codex process was not started with CODEX_CONTEXT_HANDOFF=1 and --no-daemon "
            "(a daemon-backed session keeps its daemon's stale launch environment). "
            + RESTART.format(session=session)
        )
    if not TERMINAL.fullmatch(terminal):
        return None, "this Codex process is not running in a Herdr terminal."
    if threshold() is None:
        return None, "CODEX_CONTEXT_HANDOFF_THRESHOLD must be a number between 0 and 100."
    transcript, cwd = payload.get("transcript_path"), payload.get("cwd")
    if not transcript or not cwd or not is_interactive_root(transcript, session):
        return None, "this is not an interactive root Codex chat."
    info = terminal_info(terminal, cwd)
    if not info or not in_foreground_tree(info["foreground"]["pid"]):
        return None, (
            f"the hooks do not belong to the foreground Codex of Herdr terminal {terminal} in this "
            "worktree. " + RESTART.format(session=session)
        )
    return info, None


def stop_hook(payload, root, terminal):
    session, turn_id = ids(payload)
    transcript = payload.get("transcript_path")
    if not session or not transcript or not payload.get("cwd") or disabled(root, session, turn_id):
        return {}
    state = store_for(root, session, turn_id)
    if state.is_file():
        # Our request already ran this turn; capture its answer whatever else continued the turn.
        return capture(payload, state)
    # stop_hook_active alone may come from another plugin's Stop hook, so it is not a reason to skip.
    latest = recent_turn(transcript)
    limit = threshold()
    if limit is None or not latest or latest["id"] != turn_id or not exceeds_threshold(latest["usage"], limit):
        return {}
    info, _ = check_chat(payload, terminal)
    if not info:
        return {}
    nonce = secrets.token_hex(12)
    state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not new_private_file(state, json.dumps({
        "session": session, "turn": turn_id, "cwd": payload["cwd"], "terminal": terminal,
        "pid": info["foreground"]["pid"], "transcript": transcript, "nonce": nonce,
    })):
        return {}
    return {"decision": "block", "reason": handoff_request(nonce)}


def capture(payload, state):
    if any(state.with_suffix(suffix).exists() for suffix in (".md", *DONE)):
        return {}
    record = json.loads(state.read_text(encoding="utf-8"))
    answer = (payload.get("last_assistant_message") or "").strip()
    marker, _, body = answer.partition("\n")
    if marker != f"HANDOFF READY {record['nonce']}" or not 0 < len(body.strip()) <= MAX_NOTE:
        new_private_file(state.with_suffix(".closed"), "no handoff note\n")
        return {}
    if not new_private_file(state.with_suffix(".md"), body.strip() + "\n"):
        return {}
    if not guard_busy(state, record):
        arm_guard(state, record)  # the switch arms it again once it holds the terminal lock
    with os.fdopen(
        os.open(state.with_suffix(".log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as output:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--switch", str(state)],
            stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True,
        )
    return {"systemMessage": (
        f"Context handoff ready: a fresh chat starts in about {grace():g}s. Type anything or "
        "submit `handoff off` to cancel; the note stays in the plugin data directory."
    )}


def tool_hook(payload, root, terminal):
    session, turn_id = ids(payload)
    transcript = payload.get("transcript_path")
    if not session or not transcript or disabled(root, session, turn_id):
        return {}
    state = store_for(root, session, turn_id)
    marker = state.with_suffix(".nudged")
    if state.exists() or marker.exists():
        return {}
    latest = recent_turn(transcript)
    limit = threshold()
    if limit is None or not latest or latest["id"] != turn_id or not exceeds_threshold(latest["usage"], limit):
        return {}
    state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not new_private_file(marker, "") or not check_chat(payload, terminal)[0]:
        return {}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": nudge(limit)}}


def pending(folder):
    if not folder.is_dir():
        return []
    return sorted(
        path for path in folder.iterdir()
        if ID.fullmatch(path.name) and path.is_file()
        and not any(path.with_suffix(suffix).exists() for suffix in DONE)
    )


def control_hook(payload, root, terminal):
    command = CONTROLS.get(" ".join((payload.get("prompt") or "").split()).lower())
    if not command:
        return None
    session = payload.get("session_id") or ""
    if not ID.fullmatch(session):
        return {"decision": "block", "reason": "Codex Context Handoff: could not identify this chat."}
    folder = root / session
    flag = folder / ".off"
    lines = []
    if command == "off":
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        flag.touch(mode=0o600)
        cancelled = [s for s in pending(folder) if new_private_file(s.with_suffix(".cancelled"), "handoff off\n")]
        lines.append("Handoff is off for this chat." + (
            f" Cancelled {len(cancelled)} armed or pending handoff(s)." if cancelled else ""
        ))
    elif command == "on":
        flag.unlink(missing_ok=True)
    requested = "off" if flag.exists() else "on"
    lines.append(f"Requested for this chat: {requested}.")
    try:
        info, why = check_chat(payload, terminal)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        info, why = None, f"could not verify the Herdr terminal ({error})."
    if info:
        used = usage_percent(last_usage(payload["transcript_path"]))
        lines.append(f"Operational: yes (threshold {threshold():g}%" + (
            f", last request used {used:.1f}%)." if used is not None else ").")
        )
    else:
        lines.append(f"Operational: no; {why}")
    for state in pending(folder):
        stage = "switch pending" if state.with_suffix(".md").exists() else "armed, waiting for a note"
        lines.append(f"Pending handoff {state.name}: {stage}.")
    return {"decision": "block", "reason": "Codex Context Handoff: " + " ".join(lines)}


def mark_closing(payload, root):
    session, turn = ids(payload)
    text = " ".join((payload.get("prompt") or "").split()).lower().rstrip(".!")
    if session and text in CLOSING:
        skip = store_for(root, session, turn).with_suffix(".skip")
        skip.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        new_private_file(skip, "")


def read_screen(terminal):
    result = hc("read", "--json", "--lines", "0", terminal)
    return result.get("text", "") if result.get("complete") else None


def footer_prompt(screen):
    """(prompt line, line beneath it) from the footer, or None when the footer has no prompt."""
    lines = screen.rstrip().splitlines()
    # The prompt must be in the footer, beneath any transcript or dialogs.
    for index in range(len(lines) - 1, max(len(lines) - 5, -1), -1):
        if lines[index].startswith("›"):
            return lines[index], lines[index + 1] if index + 1 < len(lines) else ""
    return None


def composer_text(screen):
    """The composer's text: "" when empty, None when the footer has no prompt."""
    found = footer_prompt(screen)
    if found is None:
        return None
    prompt, below = found
    if below.strip():  # a multi-line draft (or one starting with a newline) continues beneath
        return f"{prompt[1:].strip()}\n{below.strip()}".strip()
    return "" if COMPOSER.fullmatch(prompt) else prompt[1:].strip()


def read_composer(terminal):
    screen = read_screen(terminal)
    return screen if screen is not None and composer_text(screen) == "" else None


def active_status(info):
    status = info.get("status") or {}
    return status.get("state") if status.get("app") == "codex" else None


def log(message):
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def replace_private(path, content):
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(content)
    os.replace(temporary, path)


def guard_path(state, record):
    return state.parent.parent / f"{record['terminal']}.switch"


def arm_guard(state, record):
    """Point the terminal at this handoff: any other prompt submitted there now stops it."""
    replace_private(guard_path(state, record), f"{record['session']} {record['turn']} {record['nonce']}\n")


def guard_armed(state, record):
    try:
        return guard_path(state, record).read_text(encoding="utf-8").split() == [
            record["session"], record["turn"], record["nonce"],
        ]
    except OSError:
        return False


def guard_busy(state, record):
    """Whether the terminal's guard points at another handoff that is still pending."""
    try:
        session, turn, _ = guard_path(state, record).read_text(encoding="utf-8").split()
        other = store_for(state.parent.parent, session, turn)
    except (OSError, ValueError):
        return False
    return other != state and other.is_file() and not any(other.with_suffix(s).exists() for s in DONE)


def disarm_guard(state, record):
    if guard_armed(state, record):
        guard_path(state, record).unlink(missing_ok=True)


def note_prompt_hook(payload, root, terminal):
    """Record that UserPromptSubmit hooks run in this terminal's foreground Codex for this chat.

    That hook is what stops a switch when a prompt is submitted, so only with this evidence does
    the switch wait out a long startup after /clear. A resumed chat records its new process.
    """
    session = payload.get("session_id") or ""
    if not ID.fullmatch(session):
        return
    evidence = root / session / ".prompt-hook"
    try:
        if in_foreground_tree(int(evidence.read_text(encoding="utf-8"))):
            return
    except (OSError, ValueError):
        pass
    info = terminal_info(terminal, payload.get("cwd"))
    if info and in_foreground_tree(info["foreground"]["pid"]):
        evidence.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        replace_private(evidence, f"{info['foreground']['pid']}\n")


def prompt_hook_evidence(state, record):
    try:
        return (state.parent / ".prompt-hook").read_text(encoding="utf-8").strip() == str(record["pid"])
    except OSError:
        return False


def stopped(state):
    return (state.parent / ".off").exists() or state.with_suffix(".cancelled").exists()


def continuation(record, state):
    return (
        f"Codex Context Handoff: {record['session']} {record['turn']} {record['nonce']} "
        f"Read the local handoff note at {json.dumps(str(state.with_suffix('.md')))}. Check the working "
        "tree and live Herdr workers before resuming the remaining work. Preserve the user's scope and "
        "decisions."
    )


def herdr_turn(info):
    turn = info.get("turn") if info else None
    if type(turn) is not int:
        raise RuntimeError("Could not read Herdr's turn counter for the original Codex terminal.")
    return turn


def await_old_chat(record, start_turn):
    """Return (screen, Herdr turn) once the finished turn's chat shows an empty, idle prompt."""
    deadline = time.monotonic() + 12
    previous = None
    while time.monotonic() < deadline:
        turn = recent_turn(record["transcript"])
        info = terminal_info(record["terminal"], record["cwd"], record["pid"])
        if not turn or turn["id"] != record["turn"] or not info:
            break
        status = active_status(info)
        # Only the turn that wrote the note may end here: one step past the switch's start.
        if not start_turn <= herdr_turn(info) <= start_turn + 1:
            break
        if status in {"blocked", "error"} or (turn["complete"] and status == "working" and previous is not None):
            break
        if turn["complete"] and status in {"done", "idle"}:
            current = (read_composer(record["terminal"]), info["turn"])
            if current[0] is not None and current == previous:
                return current
            previous = current
        else:
            previous = None
        time.sleep(POLL)
    raise RuntimeError("The original chat did not reach an empty, idle Codex prompt.")


def look(record):
    """(status, Herdr turn, status time, screen) of the recorded Codex; None once it changed hands."""
    info = terminal_info(record["terminal"], record["cwd"], record["pid"])
    if not info:
        return None
    return active_status(info), info.get("turn"), info.get("status_ms"), read_screen(record["terminal"])


def prompt_state(screen, old_screen):
    if screen is None:
        return "unreadable"
    if not screen.strip():
        return "blank"
    found = footer_prompt(screen)
    if found is None:
        return "no prompt in the footer"
    if composer_text(screen):
        return "text in the composer"
    if screen == old_screen:
        return "old screen"
    if sum(line.startswith("›") for line in screen.splitlines()) != 1:
        return "old history"
    # A fresh chat shows its placeholder; a bare prompt may hide a draft starting with a newline.
    return "fresh" if found[0].rstrip() == PLACEHOLDER else "no placeholder"


def describe(view, old_screen):
    if view is None:
        return "terminal changed hands"
    return f"status {view[0]}, Herdr turn {view[1]}, prompt {prompt_state(view[3], old_screen)}"


def source_moved(record, cache):
    """Whether the old chat's transcript shows another turn (re-read only when the file changes)."""
    stat = os.stat(record["transcript"])
    signature = (stat.st_size, stat.st_mtime_ns)
    if cache.get("signature") != signature:
        latest = recent_turn(record["transcript"])
        cache.update(signature=signature, moved=not latest or latest["id"] != record["turn"])
    return cache["moved"]


def fresh_chat_problem(view, state, record, old_screen, cleared_turn, echo, cache):
    """Why the switch must stop now, or None while the fresh chat may still be starting.

    Codex reports `working` while MCP servers start after /clear, with the fresh, empty prompt
    on screen. That one busy period is allowed; a prompt, a draft, a dialog, a finished turn or
    a second busy period is not. `echo` covers the moment before Codex redraws after /clear.
    """
    if stopped(state):
        return "Handoff was cancelled (a prompt was submitted or the handoff was turned off)"
    if not guard_armed(state, record):
        return "The takeover guard for this terminal is missing"
    if source_moved(record, cache):
        return "The old chat started another turn"
    if view is None:
        return "The terminal no longer runs the original Codex in this worktree"
    status, turn, since, screen = view
    if type(turn) is not int or type(since) is not int:
        return "Herdr did not report the turn counter and status time"
    # Herdr's turn goes up each time the status leaves working: startup may end once.
    if not cleared_turn <= turn <= cleared_turn + 1 or (status in {"working", "done"} and turn != cleared_turn):
        return "The fresh chat ran something besides its startup"
    if status in {"blocked", "error"}:
        return f"The fresh chat reported {status}"
    shown = prompt_state(screen, old_screen)
    if echo:
        # Until Codex redraws, only the old chat, the typed /clear itself, or the blank frame
        # /clear draws before the fresh chat may show.
        draft = composer_text(screen) if screen is not None else None
        if shown in {"old screen", "blank"} or (draft and "/clear".startswith(draft)):
            return None
    elif status not in {"working", "idle"}:
        return f"The fresh chat reported {status}"
    elif shown == "fresh":
        return None
    if shown == "text in the composer":
        return "Text appeared in the composer"
    return f"No fresh, empty prompt after /clear ({shown})"


def await_fresh_chat(record, state, old_screen, cleared_turn, cache):
    """Return (turn, status time, screen) once the fresh chat has stayed idle at an empty prompt."""
    start = time.monotonic()
    evidence = prompt_hook_evidence(state, record)
    # Without proof that the takeover hook runs in this process, a long busy startup is not trusted.
    limit = startup_wait() if evidence else 12.0
    log(f"waiting up to {limit:g}s for the fresh chat (prompt hook evidence: {'yes' if evidence else 'no'})")
    settled = shown = None
    echo = True  # until Codex has redrawn: closed after CLEAR_ECHO or at the first fresh prompt
    while True:
        now = time.monotonic()
        elapsed = now - start
        view = look(record)
        summary = describe(view, old_screen)
        if summary != shown:
            log(f"+{elapsed:.1f}s after /clear: {summary}")
            shown = summary
        fresh = view is not None and prompt_state(view[3], old_screen) == "fresh"
        echo = echo and elapsed < CLEAR_ECHO and not fresh
        problem = fresh_chat_problem(view, state, record, old_screen, cleared_turn, echo, cache)
        if problem:
            raise RuntimeError(f"{problem} {elapsed:.1f}s after /clear ({summary}).")
        if view[0] == "idle" and fresh:
            if settled is None or settled[0] != view[1:]:
                settled = (view[1:], now)
            elif now - settled[1] >= SETTLE:
                log(f"+{elapsed:.1f}s after /clear: fresh chat settled at an empty, idle prompt")
                return view[1:]
        else:
            settled = None
        if elapsed >= limit:
            raise RuntimeError(
                f"The fresh chat did not settle at an idle prompt within {limit:g}s after /clear ({summary})."
            )
        time.sleep(POLL)


def worker_status(terminal):
    result = hc("ls")
    entries = result.get("terminals", []) if isinstance(result, dict) else result
    workers = []
    for entry in entries:
        address = entry.get("address", "")
        if entry.get("parent") != terminal or entry.get("state") != "live" or not TERMINAL.fullmatch(address):
            continue
        status = entry.get("status")
        if isinstance(status, dict):
            status = status.get("state")
        workers.append(f"- {address} ({status or 'live'})")
    return "\n".join(workers)


def hold_for_cancel(record, state, screen, seconds, turn):
    """Keep the idle, unchanged prompt and Herdr turn for the grace window; any change fails closed."""
    deadline = time.monotonic() + seconds
    while True:
        if stopped(state):
            raise RuntimeError("Handoff was cancelled before /clear.")
        info = terminal_info(record["terminal"], record["cwd"], record["pid"])
        if (
            not info or active_status(info) not in {"done", "idle"} or info.get("turn") != turn
            or read_composer(record["terminal"]) != screen
        ):
            raise RuntimeError("The terminal changed before /clear; the handoff note is left for manual recovery.")
        if time.monotonic() >= deadline:
            return
        time.sleep(POLL)


def switch_chat(state):
    record = json.loads(state.read_text(encoding="utf-8"))
    terminal = record["terminal"]
    lock_path = state.parent.parent / f"{terminal}.lock"
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError(f"Another handoff is switching terminal {terminal}.") from None
            switch_locked(record, state)
        except BaseException as error:
            # Close before disarming, so a late continuation always meets .closed or the guard.
            new_private_file(state.with_suffix(".closed"), f"{error}\n")
            raise
        finally:
            disarm_guard(state, record)


def switch_locked(record, state):
    terminal = record["terminal"]
    note = state.with_suffix(".md")
    receipt = state.with_suffix(".received")
    arm_guard(state, record)
    start_turn = herdr_turn(terminal_info(terminal, record["cwd"], record["pid"]))
    log(f"switch for {terminal} (pid {record['pid']}) started at Herdr turn {start_turn}")
    workers = worker_status(terminal)
    if workers:
        with note.open("a", encoding="utf-8") as stream:
            stream.write(f"\nLive Herdr children of {terminal} at handoff:\n{workers}\n")
    screen, turn = await_old_chat(record, start_turn)
    log(f"old chat idle at Herdr turn {turn}; holding {grace():g}s for cancellation")
    hold_for_cancel(record, state, screen, grace(), turn)
    latest = recent_turn(record["transcript"])
    if not latest or latest["id"] != record["turn"]:
        raise RuntimeError("A new turn started before /clear.")
    hold_for_cancel(record, state, screen, 0, turn)  # final recheck immediately before /clear
    cleared = hc("keys", "--json", terminal, "/", "c", "l", "e", "a", "r", "enter")
    log(f"/clear sent: {json.dumps(cleared)}")
    # hc keys waits for a quiet moment first; the chat must still be the one just checked.
    if cleared.get("turn") != turn or cleared.get("status") not in {"done", "idle"}:
        raise RuntimeError(f"The terminal changed while /clear was typed ({json.dumps(cleared)}).")
    cache = {}
    settled = await_fresh_chat(record, state, screen, turn, cache)
    # Final recheck immediately before the continuation; one send, never retried.
    view = look(record)
    problem = fresh_chat_problem(view, state, record, screen, turn, False, cache)
    if problem or view[0] != "idle" or view[1:] != settled:
        raise RuntimeError(
            f"{problem or 'The fresh chat changed'} just before the continuation ({describe(view, screen)})."
        )
    sent = hc("send", "--json", "--if", "idle", terminal, continuation(record, state))
    log(f"continuation sent: {json.dumps(sent)}")
    if not sent.get("started"):
        raise RuntimeError("Herdr did not accept the continuation prompt.")
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if receipt.is_file():
            log(f"Continuation received by {receipt.read_text(encoding='utf-8').strip()}.")
            return
        time.sleep(POLL)
    raise RuntimeError("Continuation delivery could not be confirmed. Inspect the terminal before retrying.")


def mark_takeover(payload, root, terminal):
    """Stop this terminal's pending handoff on any prompt other than its exact continuation."""
    try:
        session, turn, nonce = (root / f"{terminal}.switch").read_text(encoding="utf-8").split()
        state = store_for(root, session, turn)
        record = json.loads(state.read_text(encoding="utf-8"))
        if record["nonce"] != nonce or record["terminal"] != terminal:
            return None
        expected = continuation(record, state)
    except (OSError, ValueError, KeyError, TypeError):
        return None  # no armed guard; the switch itself fails closed without one
    if any(state.with_suffix(suffix).exists() for suffix in DONE):
        return None
    if (payload.get("prompt") or "").strip() == expected:
        return None
    chat = payload.get("session_id") or ""
    new_private_file(state.with_suffix(".cancelled"), (
        f"a prompt was submitted in chat {chat if ID.fullmatch(chat) else 'unknown'} before the continuation\n"
    ))
    return (
        "Context handoff stopped: a prompt was submitted before the continuation. "
        "The handoff note stays in the plugin data directory."
    )


def prompt_hook(payload, root, terminal):
    text = (payload.get("prompt") or "").strip()
    match = RESUME.search(text)
    if not match:
        return {}
    source, turn, nonce = match.groups()
    try:
        state = store_for(root, source, turn)
    except ValueError:
        return {}
    note = state.with_suffix(".md")
    if not note.is_file():
        return {}
    record = json.loads(state.read_text(encoding="utf-8"))
    if nonce != record["nonce"] or terminal != record["terminal"]:
        return {}
    manual = f" Read the handoff note at {note} yourself if the work should continue."
    if text != continuation(record, state):
        # A draft or another message got mixed in; never run it as a handoff.
        new_private_file(state.with_suffix(".cancelled"), "the continuation arrived mixed with other text\n")
        return {"decision": "block", "reason": "The handoff prompt arrived mixed with other text, so it was not run." + manual}
    if state.with_suffix(".cancelled").exists():
        return {"decision": "block", "reason": "This handoff was cancelled before its continuation arrived." + manual}
    if state.with_suffix(".closed").exists():
        return {"decision": "block", "reason": "This handoff stopped before its continuation arrived." + manual}
    destination = payload.get("session_id", "")
    if destination == source or not same_cwd(payload.get("cwd"), record["cwd"]):
        return {"decision": "block", "reason": "This handoff must open in a fresh chat in the original worktree."}
    destination_turn = payload.get("turn_id") or ""
    if not ID.fullmatch(destination) or not ID.fullmatch(destination_turn):
        return {"decision": "block", "reason": "Could not confirm the destination chat and turn."}
    if not new_private_file(state.with_suffix(".received"), destination + "\n"):
        return {"decision": "block", "reason": "This handoff has already been delivered."}
    skip = store_for(root, destination, destination_turn).with_suffix(".skip")
    skip.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    new_private_file(skip, "")
    return {}


def main():
    if sys.argv[1:2] == ["--switch"]:
        switch_chat(Path(sys.argv[2]))
        return
    payload = json.load(sys.stdin)
    terminal = os.environ.get("HC_TERMINAL_ID", "")
    root = os.environ.get("PLUGIN_DATA")
    if not root:
        return
    root = Path(root)
    event = payload.get("hook_event_name")
    opted_in = os.environ.get("CODEX_CONTEXT_HANDOFF") == "1" and TERMINAL.fullmatch(terminal)
    if event == "UserPromptSubmit":
        notice = mark_takeover(payload, root, terminal) if opted_in else None
        # Controls work even without the opt-in so `handoff status` can explain why.
        result = control_hook(payload, root, terminal)
        if result is not None:
            if notice:
                result["reason"] += f" {notice}"
        elif opted_in:
            mark_closing(payload, root)
            result = prompt_hook(payload, root, terminal)
            if notice and "decision" not in result:
                result["systemMessage"] = notice
        else:
            return
        print(json.dumps(result), flush=True)
        if opted_in:
            try:
                note_prompt_hook(payload, root, terminal)
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                pass  # missing evidence only shortens a later startup wait
        return
    if not opted_in:
        return
    if event == "Stop":
        print(json.dumps(stop_hook(payload, root, terminal)))
    elif event == "PostToolUse":
        print(json.dumps(tool_hook(payload, root, terminal)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Codex Context Handoff: {error}", file=sys.stderr)
        if sys.argv[1:2] == ["--switch"]:
            try:
                new_private_file(Path(sys.argv[2]).with_suffix(".closed"), f"{error}\n")
            except OSError:
                pass
            sys.exit(1)
