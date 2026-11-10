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
HC_ENV = {key: value for key, value in os.environ.items() if key != "HC_TERMINAL_ID"}


def recent_turn(path):
    """Read the latest turn only, ignoring usage preceding a compaction."""
    turn = None
    with Path(path).open("rb") as stream:
        offset = max(stream.seek(0, os.SEEK_END) - TRANSCRIPT_TAIL, 0)
        stream.seek(offset)
        if offset:
            stream.readline()
        for line in stream:
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict):
                continue
            event = row.get("payload")
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if row.get("type") == "compacted" and turn:
                turn["usage"] = None
            if row.get("type") != "event_msg":
                continue
            if kind == "task_started":
                turn = {"id": event.get("turn_id"), "usage": None, "complete": False}
            elif turn and kind == "token_count":
                turn["usage"] = event.get("info")
            elif turn and kind == "task_complete" and event.get("turn_id") == turn["id"]:
                turn["complete"] = True
    return turn



def is_interactive_root(transcript, session):
    with Path(transcript).open("rb") as stream:
        row = json.loads(stream.readline(1024 * 1024))
    if not isinstance(row, dict) or row.get("type") != "session_meta":
        return False
    meta = row.get("payload")
    return (
        isinstance(meta, dict)
        and meta.get("source") == "cli" and meta.get("thread_source") == "user"
        and meta.get("id") == session and meta.get("session_id") == session
    )

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


def stop_hook(payload, root, terminal):
    session = payload.get("session_id") or ""
    turn_id = payload.get("turn_id") or ""
    transcript = payload.get("transcript_path")
    cwd = payload.get("cwd")
    if not transcript or not cwd or not session or not turn_id:
        return {}
    state = store_for(root, session, turn_id)
    if state.with_suffix(".skip").is_file():
        return {}
    if payload.get("stop_hook_active"):
        if state.is_file():
            capture(payload, state)
        return {}
    latest = recent_turn(transcript)
    threshold = float(os.environ.get("CODEX_CONTEXT_HANDOFF_THRESHOLD", "40"))
    if not math.isfinite(threshold) or not 0 < threshold < 100:
        return {}
    if not latest or latest["id"] != turn_id or not exceeds_threshold(latest["usage"], threshold):
        return {}
    info = terminal_info(terminal, cwd)
    if not info or not is_interactive_root(transcript, session) or not in_foreground_tree(info["foreground"]["pid"]):
        return {}
    nonce = secrets.token_hex(12)
    state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not new_private_file(state, json.dumps({
        "session": session, "turn": turn_id, "cwd": cwd, "terminal": terminal,
        "pid": info["foreground"]["pid"], "transcript": transcript, "nonce": nonce,
    })):
        return {}
    return {"decision": "block", "reason": handoff_request(nonce)}


def capture(payload, state):
    record = json.loads(state.read_text(encoding="utf-8"))
    answer = (payload.get("last_assistant_message") or "").strip()
    marker, _, body = answer.partition("\n")
    if marker != f"HANDOFF READY {record['nonce']}" or not 0 < len(body.strip()) <= MAX_NOTE:
        return
    note = state.with_suffix(".md")
    if not new_private_file(note, body.strip() + "\n"):
        return
    result = state.with_suffix(".log")
    with os.fdopen(
        os.open(result, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as log:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--switch", str(state)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
        )


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
    if os.environ.get("CODEX_CONTEXT_HANDOFF") != "1" or not TERMINAL.fullmatch(terminal) or not root:
        return
    event = payload.get("hook_event_name")
    if event == "Stop":
        print(json.dumps(stop_hook(payload, Path(root), terminal)))
    elif event == "UserPromptSubmit":
        print(json.dumps(prompt_hook(payload, Path(root), terminal)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Codex Context Handoff: {error}", file=sys.stderr)
        if sys.argv[1:2] == ["--switch"]:
            sys.exit(1)
