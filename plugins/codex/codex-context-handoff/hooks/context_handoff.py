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
RESUME = re.compile(r"\ACodex Context Handoff: ([\w-]+) ([\w-]+) ([0-9a-f]{24}) ")
COMPOSER = re.compile(r"^›(?:\s+Ask Codex to do anything)?\s*$")
TRANSCRIPT_TAIL = 4 * 1024 * 1024
MAX_NOTE = 12_000
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


def transcript_rows(path):
    with Path(path).open("rb") as stream:
        offset = max(stream.seek(0, os.SEEK_END) - TRANSCRIPT_TAIL, 0)
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
    """Read the latest turn only, ignoring usage preceding a compaction."""
    turn = None
    for row_type, event in transcript_rows(path):
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
    return turn


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
    with os.fdopen(
        os.open(state.with_suffix(".log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as log:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--switch", str(state)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
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


def read_composer(terminal):
    result = hc("read", "--json", "--lines", "0", terminal)
    screen = result.get("text", "")
    lines = screen.rstrip().splitlines()
    # The prompt must be in the footer, beneath any transcript or dialogs.
    prompt = next((line for line in reversed(lines[-4:]) if line.startswith("›")), "")
    if not result.get("complete") or not COMPOSER.fullmatch(prompt):
        return None
    return screen


def active_status(info):
    status = info.get("status") or {}
    return status.get("state") if status.get("app") == "codex" else None


def await_old_chat(record):
    deadline = time.monotonic() + 12
    previous = None
    while time.monotonic() < deadline:
        turn = recent_turn(record["transcript"])
        info = terminal_info(record["terminal"], record["cwd"], record["pid"])
        if not turn or turn["id"] != record["turn"] or not info:
            break
        status = active_status(info)
        if status in {"blocked", "error"} or (turn["complete"] and status == "working" and previous is not None):
            break
        if turn["complete"] and status in {"done", "idle"}:
            screen = read_composer(record["terminal"])
            if screen is not None and screen == previous:
                return screen
            previous = screen
        else:
            previous = None
        time.sleep(0.2)
    raise RuntimeError("The original chat did not reach an empty, idle Codex prompt.")


def await_fresh_chat(record, old_screen):
    deadline = time.monotonic() + 12
    status = None
    while time.monotonic() < deadline:
        info = terminal_info(record["terminal"], record["cwd"], record["pid"])
        if not info:
            break
        status = active_status(info)
        if status in {"blocked", "error"}:
            break
        if status == "idle":
            screen = read_composer(record["terminal"])
            if (
                screen and screen != old_screen
                and sum(line.startswith("›") for line in screen.splitlines()) == 1
            ):
                return
        time.sleep(0.2)
    raise RuntimeError(f"Could not confirm a fresh, idle prompt after /clear (status: {status}).")


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


def hold_for_cancel(record, state, screen, seconds):
    """Keep the idle, unchanged prompt for the grace window; any input or cancel fails closed."""
    off = state.parent / ".off"
    deadline = time.monotonic() + seconds
    while True:
        if off.exists() or state.with_suffix(".cancelled").exists():
            raise RuntimeError("Handoff was cancelled before /clear.")
        info = terminal_info(record["terminal"], record["cwd"], record["pid"])
        if (
            not info or active_status(info) not in {"done", "idle"}
            or read_composer(record["terminal"]) != screen
        ):
            raise RuntimeError("The terminal changed before /clear; the handoff note is left for manual recovery.")
        if time.monotonic() >= deadline:
            return
        time.sleep(0.2)


def switch_chat(state):
    record = json.loads(state.read_text(encoding="utf-8"))
    terminal = record["terminal"]
    note = state.with_suffix(".md")
    receipt = state.with_suffix(".received")
    lock_path = state.parent.parent / f"{terminal}.lock"
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        workers = worker_status(terminal)
        if workers:
            with note.open("a", encoding="utf-8") as stream:
                stream.write(f"\nLive Herdr children of {terminal} at handoff:\n{workers}\n")
        screen = await_old_chat(record)
        hold_for_cancel(record, state, screen, grace())
        turn = recent_turn(record["transcript"])
        if not turn or turn["id"] != record["turn"]:
            raise RuntimeError("A new turn started before /clear.")
        hold_for_cancel(record, state, screen, 0)  # final recheck immediately before /clear
        hc("keys", "--json", terminal, "/", "c", "l", "e", "a", "r", "enter")
        await_fresh_chat(record, screen)
        prompt = (
            f"Codex Context Handoff: {record['session']} {record['turn']} {record['nonce']} "
            f"Read the local handoff note at {json.dumps(str(note))}. Check the working tree and live Herdr "
            "workers before resuming the remaining work. Preserve the user's scope and decisions."
        )
        sent = hc("send", "--json", "--if", "idle", terminal, prompt)
        if not sent.get("started"):
            raise RuntimeError("Herdr did not accept the continuation prompt.")
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if receipt.is_file():
                print(f"Continuation received by {receipt.read_text(encoding='utf-8').strip()}.")
                return
            time.sleep(0.2)
        raise RuntimeError("Continuation delivery could not be confirmed. Inspect the terminal before retrying.")


def prompt_hook(payload, root, terminal):
    match = RESUME.match(payload.get("prompt") or "")
    if not match:
        return {}
    source, turn, nonce = match.groups()
    state = store_for(root, source, turn)
    if not state.with_suffix(".md").is_file():
        return {}
    record = json.loads(state.read_text(encoding="utf-8"))
    if nonce != record["nonce"] or terminal != record["terminal"]:
        return {}
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
    if event == "UserPromptSubmit":
        # Controls work even without the opt-in so `handoff status` can explain why.
        result = control_hook(payload, root, terminal)
        if result is not None:
            print(json.dumps(result))
            return
    if os.environ.get("CODEX_CONTEXT_HANDOFF") != "1" or not TERMINAL.fullmatch(terminal):
        return
    if event == "Stop":
        print(json.dumps(stop_hook(payload, root, terminal)))
    elif event == "PostToolUse":
        print(json.dumps(tool_hook(payload, root, terminal)))
    elif event == "UserPromptSubmit":
        mark_closing(payload, root)
        print(json.dumps(prompt_hook(payload, root, terminal)))


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
