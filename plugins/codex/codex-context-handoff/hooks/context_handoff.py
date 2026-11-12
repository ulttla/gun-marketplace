#!/usr/bin/env python3
"""Rotate an opted-in Codex CLI chat without replacing its Herdr terminal."""

import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

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
# Submitted as the whole prompt, this reaches the model and arms a handoff (and a Goal transfer) right away.
NOW = {"handoff now", "핸드오프 지금"}
GOAL_TOOLS = {"get_goal", "update_goal", "create_goal"}
CODE_MODE = "exec"  # code mode's script tool; each nested tool call gets its own PreToolUse
MAX_ATTEMPTS = 3  # Goal transfer attempts per chat that user input may put off
RETRY_GROWTH = 5.0  # percentage points of context a put-off attempt waits for before trying again
MAX_DENIALS = 12  # denied tool calls before the gate gives up for the turn
CONTROLS = {
    "handoff off": "off", "handoff cancel": "off", "handoff on": "on", "handoff status": "status",
    "핸드오프 끄기": "off", "핸드오프 취소": "off", "핸드오프 켜기": "on", "핸드오프 상태": "status",
    "handoff goal transfer on": "goal-on", "handoff goal transfer off": "goal-off",
    "핸드오프 목표 이전 켜기": "goal-on", "핸드오프 목표 이전 끄기": "goal-off",
}
GOAL_STATUSES = {"active", "paused", "blocked", "usage_limited", "budget_limited", "complete"}
CONSENT = "goal-transfer.json"
CLOSING = {"end session", "wrap up", "세션 종료", "마무리"}
DONE = (".received", ".cancelled", ".closed")
RESTART = (
    "Exit Codex, then reopen this chat with `codex resume {session}` in this Herdr terminal so the "
    "launcher adds --no-daemon and CODEX_CONTEXT_HANDOFF=1."
)
HC_ENV = {key: value for key, value in os.environ.items() if key != "HC_TERMINAL_ID"}


def parse_rows(stream, kinds):
    for line in stream:
        if not any(kind in line for kind in kinds):
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if isinstance(row, dict) and isinstance(row.get("payload"), dict):
            yield row.get("type"), row["payload"]


def transcript_rows(path, tail=TRANSCRIPT_TAIL, kinds=(b'"event_msg"', b'"compacted"')):
    with Path(path).open("rb") as stream:
        offset = max(stream.seek(0, os.SEEK_END) - tail, 0)
        stream.seek(offset)
        if offset:
            stream.readline()
        yield from parse_rows(stream, kinds)


def rows_after(path, offset):
    """Transcript rows written after byte `offset` (the transcript's size when a handoff was armed)."""
    with Path(path).open("rb") as stream:
        if type(offset) is not int or not 0 <= offset <= stream.seek(0, os.SEEK_END):
            return None
        stream.seek(max(offset - 1, 0))
        if offset and stream.read(1) != b"\n":
            stream.readline()  # armed while a line was being written: that line came before the arm
        return list(parse_rows(stream, (b'"event_msg"', b'"response_item"')))


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
                attribution = event.get("turn_attribution")
                trigger = attribution.get("turn_trigger") if isinstance(attribution, dict) else None
                turn = {"id": event.get("turn_id"), "usage": None, "complete": False, "trigger": trigger}
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


def checkpoint_calls():
    value = env_number("CODEX_CONTEXT_HANDOFF_CHECKPOINT_CALLS", "3", 0, 10, inclusive=True)
    return 3 if value is None else int(value)


def min_progress():
    value = env_number("CODEX_CONTEXT_HANDOFF_MIN_PROGRESS", "10", 0, 90, inclusive=True)
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


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def goals_db(transcript):
    """`<CODEX_HOME>/goals_1.sqlite` for a `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` transcript."""
    override = os.environ.get("CODEX_HANDOFF_GOALS_DB")
    if override:
        return Path(override)
    path = Path(transcript)
    parents = path.parents
    if (
        path.name.startswith("rollout-") and len(parents) > 4 and parents[3].name == "sessions"
        and all(parent.name.isdigit() for parent in parents[:3])
    ):
        return parents[4] / "goals_1.sqlite"
    return None


def goal_state(transcript, session, trigger=None):
    """("none", None), ("unknown", why) or ("row", goal) from a read-only look at Codex's Goal DB."""
    db = goals_db(transcript)
    if db is None:
        return "unknown", "the transcript is not in a Codex sessions directory"
    row = None
    if db.exists():
        try:
            connection = sqlite3.connect(f"file:{quote(str(db))}?mode=ro", uri=True, timeout=1)
            try:
                row = connection.execute(
                    "SELECT goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, "
                    "updated_at_ms FROM thread_goals WHERE thread_id = ?", (session,),
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error as error:
            return "unknown", f"{type(error).__name__}: {error}"
    if row is None:
        if trigger == "goal":
            return "unknown", "this turn was started by a Goal but no Goal row was found"
        return "none", None
    goal_id, objective, status, budget, used, seconds, created, updated = row
    if (
        not isinstance(goal_id, str) or not isinstance(objective, str) or status not in GOAL_STATUSES
        or not (budget is None or type(budget) is int)
        or any(type(value) is not int for value in (used, seconds, created, updated))
    ):
        return "unknown", "unexpected Goal row"
    return "row", {
        "goal_id": goal_id, "status": status, "objective": objective, "objective_sha256": digest(objective),
        "token_budget": budget, "tokens_used": used, "time_used_seconds": seconds,
        "created_at_ms": created, "updated_at_ms": updated,
    }


def consent_file(root):
    """The plugin-wide Goal transfer consent as written by `handoff goal transfer on`, or None."""
    try:
        data = json.loads((root / CONSENT).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("enabled") is True and isinstance(data.get("since"), str) else None


def goal_killed():
    return os.environ.get("CODEX_CONTEXT_HANDOFF_GOAL", "").strip().lower() in {"off", "0", "false", "no"}


def goal_consent(root):
    # The environment can only turn transfer off; consent is the persisted file.
    return None if goal_killed() else consent_file(root)


def goal_wait(folder, why, marker=".goal-wait"):
    """Tell the chat once why no handoff will be requested; later Stops stay silent."""
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not new_private_file(folder / marker, why + "\n"):
        return {}
    return {"systemMessage": f"Context handoff is waiting: {why}. Codex auto-compaction will handle context."}


def goal_request(goal, nonce):
    if not goal:
        return ""
    if goal["mode"] == "left":
        return (
            f"\nThere is a Goal in this chat with status {goal['arm']['status']}. Do not change it and do not "
            "mention recreating it."
        )
    return (
        "\n\nGOAL TRANSFER (authorized by the user's standing Goal transfer instruction in AGENTS.md; "
        f"plugin consent since {goal['since']}):\n"
        "1. Call get_goal and print its raw result with text().\n"
        '2. Only if its status is "active": call update_goal with status "paused" and print its raw result. '
        "This pause only moves the Goal to the fresh chat. Do no more Goal work after it.\n"
        f"3. Start your final answer with: HANDOFF READY {nonce} GOAL transferred\n"
        f'   If the status was not "active", do not change it and use: HANDOFF READY {nonce} GOAL left\n'
        "Do not create, resume or edit any Goal in this chat."
    )


def handoff_turn_rows(path, nonce):
    """Transcript rows after our handoff request in the current turn, or None if it is not found.

    The request shows as a user-role <hook_prompt> message and an item_completed HookPrompt event,
    possibly combined with other plugins' Stop requests.
    """
    needle = f"HANDOFF READY {nonce}"
    tail = TRANSCRIPT_TAIL
    while True:
        rows, found = [], False
        for row_type, item in transcript_rows(path, tail, (b'"event_msg"', b'"response_item"')):
            if is_request(row_type, item, needle):
                rows, found = [], True
            else:
                rows.append((row_type, item))
        if found:
            return rows
        if tail >= os.path.getsize(path):
            return None
        tail *= 4


def is_request(row_type, item, needle):
    if row_type == "event_msg" and item.get("type") == "item_completed":
        hook = item.get("item")
        return isinstance(hook, dict) and hook.get("type") == "HookPrompt" and any(
            isinstance(part, dict) and needle in str(part.get("text", "")) for part in hook.get("fragments") or ()
        )
    if row_type == "response_item" and item.get("type") == "message" and item.get("role") == "user":
        return any(
            isinstance(part, dict) and str(part.get("text", "")).startswith("<hook_prompt")
            and needle in part["text"] for part in item.get("content") or ()
        )
    return False


def message_text(content):
    return "".join(
        str(part.get("text", "")) for part in content or () if isinstance(part, dict)
    ) if isinstance(content, list) else ""


def user_input(rows, exempt=None):
    """Whether the user acted after our request: a prompt or steer (UserMessage), a /goal change
    (a user-role <codex_internal_context source="user_goal">), or any other user-role message that is
    not a hook prompt Codex itself recorded (paired with a HookPrompt event of the same id).

    `exempt` is the exact prompt that armed the handoff (`handoff now`), which is not an objection to it.
    """
    def armed_it(content):
        return exempt is not None and " ".join(message_text(content).split()) == exempt

    hooks = set()
    for row_type, item in rows:
        if row_type == "event_msg" and item.get("type") == "item_completed" and isinstance(item.get("item"), dict):
            if item["item"].get("type") == "UserMessage" and not armed_it(item["item"].get("content")):
                return True
            if item["item"].get("type") == "HookPrompt":
                hooks.add(item["item"].get("id"))
    return any(
        row_type == "response_item" and item.get("type") == "message" and item.get("role") == "user"
        and not armed_it(item.get("content"))
        and not (item.get("id") in hooks and all(
            isinstance(part, dict) and str(part.get("text", "")).startswith("<hook_prompt")
            for part in item.get("content") or ()
        ))
        for row_type, item in rows
    )


def armed_rows(record):
    """The evidence rows for a handoff: after our Stop request, or after the arm for one armed mid-turn.

    A record armed mid-turn (by the tool gate, `handoff now` or the transfer helper) has no persisted
    request, so its boundary is the transcript size at the arm. A tool call that was running at the
    arm (the helper's own call, or a script whose nested call the gate denied) is included when its
    output lands after the arm; the Goal was active in the DB at the arm, so a pause it printed
    happened after the arm.
    """
    if record.get("origin") not in {"tool", "manual"}:
        return handoff_turn_rows(record["transcript"], record["nonce"])
    after = rows_after(record["transcript"], record["offset"])
    if after is None:
        return None
    outputs = {item.get("call_id") for row_type, item in after if row_type == "response_item"
               and item.get("type") in {"custom_tool_call_output", "function_call_output"}}
    calls = {item.get("call_id") for row_type, item in after if row_type == "response_item"
             and item.get("type") in {"custom_tool_call", "function_call"}}
    return calls_before(record["transcript"], record["offset"], outputs - calls) + after


def calls_before(path, offset, wanted):
    """The tool call rows written before `offset` for the given call ids (a call running at the arm),
    looking back as far as needed (a long script can start well before the arm)."""
    found, tail = {}, TRANSCRIPT_TAIL
    while wanted - set(found):
        with Path(path).open("rb") as stream:
            start = max(offset - tail, 0)
            stream.seek(start)
            if start:
                stream.readline()
            while stream.tell() < offset:
                line = stream.readline()
                if not line:
                    break
                for row_type, item in parse_rows([line], (b'"response_item"',)):
                    if item.get("type") in {"custom_tool_call", "function_call"} and item.get("call_id") in wanted:
                        found[item["call_id"]] = item
        if start == 0:
            break
        tail *= 4
    return [("response_item", item) for item in found.values()]


def goal_calls(rows):
    """(update_goal, create_goal) invocations in the model's tool calls."""
    updates = creates = 0
    for row_type, item in rows:
        if row_type != "response_item":
            continue
        if item.get("type") == "custom_tool_call":
            code = str(item.get("input") or "")
            updates, creates = updates + code.count("update_goal"), creates + code.count("create_goal")
        elif item.get("type") == "function_call":
            updates += item.get("name") == "update_goal"
            creates += item.get("name") == "create_goal"
    return updates, creates


def output_goals(output):
    """Goal objects printed in a tool output, in order (one `{"goal":...}` JSON line each)."""
    if isinstance(output, str):
        texts = [output]
    elif isinstance(output, list):
        texts = [part.get("text") for part in output if isinstance(part, dict) and isinstance(part.get("text"), str)]
    else:
        return []
    goals = []
    for text in texts:
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith('{"goal":'):
                continue
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("goal"), dict):
                goals.append(value["goal"])
    return goals


def goal_snapshots(rows):
    """(goal, came from an update_goal call asking for paused) for each Goal tool output, in order."""
    calls, snapshots = {}, []
    for row_type, item in rows:
        if row_type != "response_item":
            continue
        kind, call = item.get("type"), item.get("call_id")
        if not isinstance(call, str):
            continue
        if kind == "custom_tool_call" and item.get("name") == "exec":
            code = str(item.get("input") or "")
            if "tools.get_goal" in code or "tools.update_goal" in code:
                calls[call] = "tools.update_goal" in code and "paused" in code
        elif kind == "function_call" and item.get("name") in {"get_goal", "update_goal"}:
            calls[call] = item["name"] == "update_goal" and "paused" in str(item.get("arguments") or "")
        elif kind in {"custom_tool_call_output", "function_call_output"} and call in calls:
            update = calls.pop(call)
            snapshots.extend((goal, update) for goal in output_goals(item.get("output")))
    return snapshots


def prior_lineage(folder, goal):
    """The lineage this chat's Goal arrived with, if it was a verified restore of the same Goal."""
    try:
        restored = json.loads((folder / ".goal-restored").read_text(encoding="utf-8"))
        lineage = json.loads((folder / ".goal-lineage.json").read_text(encoding="utf-8"))
        if (
            restored["objective_sha256"] == goal["objective_sha256"] == lineage["objective_sha256"]
            and restored["created_at_ms"] == goal["created_at_ms"] and restored["goal_id"] == goal["goal_id"] and ID.fullmatch(lineage["root_session"])
            and all(type(lineage[key]) is int for key in ("hops", "total_tokens_used", "total_time_used_seconds"))
        ):
            return lineage
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def verify_transfer(record, state):
    """(transfer, None) when the rollout and the DB prove the armed Goal was paused for us, else (None, why)."""
    arm, session = record["goal"]["arm"], record["session"]
    rows = armed_rows(record)
    if rows is None:
        return None, "the handoff request was not found in the transcript"
    if user_input(rows, record.get("prompt")):
        return None, "user input arrived during the handoff turn"
    # Exactly the one pause asked for: no second update, no create, so nothing changed after it.
    if goal_calls(rows) != (1, 0):
        return None, "the Goal tools were not called exactly as requested (one update_goal, no create_goal)"

    def armed(goal):
        objective = goal.get("objective")
        return (
            goal.get("threadId") == session and goal.get("createdAt") == arm["created_at_ms"] // 1000
            and isinstance(objective, str) and digest(objective) == arm["objective_sha256"]
        )

    snapshots = goal_snapshots(rows)
    paused = next((index for index, (goal, _) in enumerate(snapshots) if goal.get("status") == "paused"), None)
    if paused is None:
        return None, "no paused Goal in the tool output"
    goal, from_update = snapshots[paused]
    if not from_update:
        return None, "the first paused Goal was not printed by update_goal paused"
    if not armed(goal):
        return None, "the paused Goal is not the Goal armed for transfer"
    # A mid-turn arm read the Goal as active from the DB at the arm, before any row counted here.
    if record.get("origin") not in {"tool", "manual"} and not any(
        earlier.get("status") == "active" and armed(earlier) for earlier, _ in snapshots[:paused]
    ):
        return None, "no active Goal was printed before the pause"
    status, row = goal_state(record["transcript"], session)
    if status != "row":
        return None, f"the Goal DB shows {status}" + (f" ({row})" if row else "")
    if (
        row["status"] != "paused" or row["created_at_ms"] != arm["created_at_ms"]
        or row["objective_sha256"] != arm["objective_sha256"] or row["token_budget"] != arm["token_budget"]
        or row["goal_id"] != arm["goal_id"] or row["token_budget"] != goal.get("tokenBudget")
        or row["updated_at_ms"] // 1000 != goal.get("updatedAt") or row["tokens_used"] != goal.get("tokensUsed")
        or row["time_used_seconds"] != goal.get("timeUsedSeconds")
    ):
        return None, "the Goal DB does not match the paused Goal"
    budget = row["token_budget"]
    remaining = None if budget is None else budget - row["tokens_used"]
    if remaining is not None and remaining <= 0:
        return None, "the Goal's token budget is exhausted"
    lineage = {"root_session": session, "hops": 1, "total_tokens_used": row["tokens_used"],
               "total_time_used_seconds": row["time_used_seconds"]}
    prior = prior_lineage(state.parent, row)
    if prior:
        lineage = {"root_session": prior["root_session"], "hops": prior["hops"] + 1,
                   "total_tokens_used": prior["total_tokens_used"] + row["tokens_used"],
                   "total_time_used_seconds": prior["total_time_used_seconds"] + row["time_used_seconds"]}
    return {
        "source_session": session, "source_turn": record["turn"], "goal_id": row["goal_id"], "objective": row["objective"],
        "objective_sha256": row["objective_sha256"], "created_at_ms": row["created_at_ms"],
        "paused_at_ms": row["updated_at_ms"], "token_budget": budget, "tokens_used": row["tokens_used"],
        "time_used_seconds": row["time_used_seconds"], "remaining": remaining, "lineage": lineage,
    }, None


def verify_left(record):
    """Why a Goal that was not active at arm changed during the handoff turn, or None."""
    arm = record["goal"]["arm"]
    rows = armed_rows(record)
    if rows is None:
        return "the handoff request was not found in the transcript"
    if goal_calls(rows) != (0, 0):
        return "update_goal or create_goal was called"
    status, row = goal_state(record["transcript"], record["session"])
    if status != "row" or any(
        row[key] != arm.get(key) for key in ("goal_id", "status", "created_at_ms", "updated_at_ms", "objective_sha256")
    ):
        return "the Goal changed"
    return None


def create_goal_args(transfer):
    args = {"objective": transfer["objective"]}
    if transfer["remaining"] is not None:
        args["token_budget"] = transfer["remaining"]
    return json.dumps(args, ensure_ascii=False)


def goal_note(transfer):
    lineage = transfer["lineage"]
    budget = (
        f"token_budget {transfer['remaining']}" if transfer["remaining"] is not None
        else "no token_budget (the Goal is unbounded; omit it)"
    )
    return (
        "\n## Goal transfer\n\n"
        f"- Objective (JSON string): {json.dumps(transfer['objective'], ensure_ascii=False)}\n"
        f"- create_goal: {budget}; exact arguments {create_goal_args(transfer)}\n"
        f"- This segment (chat {transfer['source_session']}): {transfer['tokens_used']} tokens, "
        f"{transfer['time_used_seconds']} s.\n"
        f"- Lineage: {lineage['hops']} transfer(s) from chat {lineage['root_session']}, "
        f"{lineage['total_tokens_used']} tokens and {lineage['total_time_used_seconds']} s in all.\n"
    )


def goal_paused_line(state):
    """The cancellation notice for a handoff whose source Goal was paused for transfer."""
    if not state.with_suffix(".goal.json").is_file() or state.with_suffix(".received").exists():
        return ""
    return (
        f"The Goal of chat {state.parent.name} was paused for this handoff and stays paused; resume it with "
        "/goal in that chat to continue there."
    )


def consent_revoked(state):
    """Why a handoff that carries a paused Goal may not go on: transfer consent was withdrawn since."""
    if state.with_suffix(".goal.json").is_file() and not goal_consent(state.parent.parent):
        return "Goal transfer was turned off"
    return None


def goal_failure(state, record, why):
    """Fail a Goal transfer closed: no switch, one message, and no further requests in this chat."""
    status, row = goal_state(record["transcript"], record["session"])
    if status == "row" and row["status"] == "complete":
        new_private_file(state.with_suffix(".closed"), f"goal completed instead of transferred: {why}\n")
        return {"systemMessage": "Context handoff: the Goal was completed, so nothing was transferred."}
    if status == "row" and row["status"] == "active":
        reason = "active goal was not paused"
        message = "Context handoff skipped: the active Goal was not paused for transfer. Work continues here."
    elif status == "unknown":
        reason = f"goal state unknown ({why})"
        message = (
            "Context handoff stopped: the Goal state could not be read, so the Goal may be paused and its "
            "transfer could not be verified. If it is paused, resume it with /goal to continue here."
        )
    elif status == "row" and row["status"] == "paused":
        reason = f"goal transfer not verified: {why}"
        message = (
            "Context handoff stopped: the Goal is paused but its transfer could not be verified. Resume it "
            "with /goal to continue here."
        )
    else:
        reason = f"goal transfer not verified: {why}"
        message = (
            f"Context handoff stopped: the Goal transfer could not be verified ({why}); the Goal is now "
            f"{row['status'] if status == 'row' else 'gone'}."
        )
    new_private_file(state.with_suffix(".closed"), reason + "\n")
    new_private_file(state.parent / ".goal-wait", reason + "\n")
    return {"systemMessage": message}


def restore_instruction(transfer, lead):
    return (
        f"Codex Context Handoff: {lead} Call create_goal with exactly these arguments and print its raw "
        f"result: {create_goal_args(transfer)}. This recreates the Goal paused in chat {transfer['source_session']} "
        "for the handoff (authorized by the user's standing Goal transfer instruction). Do not create, pause or "
        "edit any other Goal."
    )


def recreated(row, expected):
    # A fresh chat has no Goal of its own, so an exact objective and budget prove the recreation; the
    # Goal may already have finished natively (complete, budget_limited) by this chat's first Stop.
    return (
        row["status"] != "paused" and row["objective"] == expected["objective"]
        and row["token_budget"] == expected["remaining"]
    )


def restored_record(row, expected):
    return json.dumps({
        "goal_id": row["goal_id"], "objective_sha256": row["objective_sha256"], "created_at_ms": row["created_at_ms"],
        "source": expected["source_session"], "status": row["status"],
    })


def pending_restore(folder):
    """(path, expected Goal or None if unreadable) for a chat waiting to confirm a transferred Goal."""
    path = folder / ".goal-restore"
    if not path.is_file():
        return None, None
    try:
        expected = json.loads(path.read_text(encoding="utf-8"))
        create_goal_args(expected)
        if not ID.fullmatch(expected["source_session"]) or not isinstance(expected["objective"], str):
            raise ValueError("bad restore record")
    except (OSError, ValueError, KeyError, TypeError):
        expected = None
    return path, expected


def cancel_restore(payload, root):
    """Any prompt after the continuation ends the restore check, so no reminder lands in a new task."""
    session = payload.get("session_id") or ""
    if not ID.fullmatch(session):
        return None
    folder = root / session
    path, expected = pending_restore(folder)
    if path is None:
        return None
    if expected and payload.get("transcript_path"):
        status, row = goal_state(payload["transcript_path"], session)
        if status == "row" and recreated(row, expected):
            new_private_file(folder / ".goal-restored", restored_record(row, expected))
            path.unlink(missing_ok=True)
            return None
    new_private_file(folder / ".goal-mismatch", "a prompt arrived before the Goal was confirmed\n")
    path.unlink(missing_ok=True)
    source = f"chat {expected['source_session']}" if expected else "the old chat"
    return (
        "Context handoff: a prompt arrived before the transferred Goal was recreated, so the plugin no longer "
        f"asks for it. The Goal of {source} stays paused; resume it there with /goal, or create it here."
    )


def restore_check(payload, root, session):
    """In a chat that received a Goal, confirm the Goal was recreated exactly; at most one reminder."""
    folder = root / session
    path, expected = pending_restore(folder)
    if path is None:
        return None

    def finish(marker, content, message=None):
        new_private_file(folder / marker, content)
        path.unlink(missing_ok=True)
        return {"systemMessage": message} if message else None

    if expected is None:
        return finish(".goal-mismatch", "unreadable restore record\n", (
            "Context handoff: the transferred Goal's record could not be read. The old chat's Goal stays "
            "paused; create it with /goal."
        ))
    if not goal_consent(root):
        return finish(".goal-mismatch", "Goal transfer was turned off\n", (
            "Context handoff: Goal transfer was turned off, so the transferred Goal is no longer checked here. "
            f"The Goal of chat {expected['source_session']} stays paused."
        ))

    status, row = goal_state(payload["transcript_path"], session)
    if status == "unknown":
        return finish(".goal-mismatch", f"goal state unknown: {row}\n", (
            f"Context handoff: could not read the Goal state to confirm the transferred Goal ({row}). The old "
            "chat's Goal stays paused; check /goal."
        ))
    if status == "none":
        if new_private_file(folder / ".goal-reminded", ""):
            return {"decision": "block", "reason": restore_instruction(expected, "the transferred Goal does not exist yet.")}
        return finish(".goal-mismatch", "not recreated\n", (
            "Goal not recreated; the old chat's Goal stays paused; create it with /goal."
        ))
    if recreated(row, expected):
        return finish(".goal-restored", restored_record(row, expected), None if row["status"] in {
            "active", "complete", "budget_limited",
        } else (
            f"Context handoff: the transferred Goal was recreated here and is now {row['status']}."
        ))
    why = (
        f"status {row['status']}" if row["status"] == "paused"
        else "different objective" if row["objective"] != expected["objective"]
        else f"token_budget {row['token_budget']} instead of {expected['remaining']}"
    )
    return finish(".goal-mismatch", why + "\n", (
        f"Context handoff: the Goal in this chat does not match the transferred Goal ({why}). The old chat's "
        "Goal stays paused; fix it with /goal."
    ))


def baseline(folder, transcript):
    """Context use at the first request of a chat that received a handoff; None for any other chat."""
    if not (folder / ".received-from").is_file():
        return None
    cached = folder / ".baseline"
    try:
        return float(cached.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    for row_type, event in transcript_rows(transcript, os.path.getsize(transcript)):
        if row_type == "event_msg" and event.get("type") == "token_count":
            used = usage_percent(event.get("info"))
            if used is not None:
                new_private_file(cached, f"{used}\n")
                return used
    return None


def headroom(folder, transcript, usage, limit):
    """Whether this chat may hand off now: past the threshold, and for a chat that received a handoff
    whose first request was already past it, after real progress since (no handoff loops)."""
    if not exceeds_threshold(usage, limit):
        return False
    base = baseline(folder, transcript)
    return base is None or base <= limit or usage_percent(usage) >= base + min_progress()


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def transfer_blocked(folder, used):
    """Why an automatic Goal transfer may not be armed in this chat now, or None."""
    if (folder / ".goal-wait").exists():
        return "waiting"
    if (folder / ".goal-requested").exists():
        return "requested"
    retry = folder / ".goal-retry"
    if retry.exists():
        data = read_json(retry)
        if not data or type(data.get("count")) is not int or data["count"] >= MAX_ATTEMPTS:
            return "attempts used up"
        if used is None or used < float(data.get("usage") or 0) + RETRY_GROWTH:
            return "waiting for more context use"
    return None


def confirm_restore(folder, transcript, session):
    """True unless this chat still waits for a transferred Goal to be recreated (confirmed here if it was)."""
    path, expected = pending_restore(folder)
    if path is None:
        return True
    if expected is None:
        return False
    status, row = goal_state(transcript, session)
    if status == "row" and recreated(row, expected):
        new_private_file(folder / ".goal-restored", restored_record(row, expected))
        path.unlink(missing_ok=True)
        return True
    return False


def arm_record(payload, root, terminal, info, goal, origin, used, prompt=None):
    """Write the per-turn handoff record (once), or return None if this turn is already armed."""
    session, turn = ids(payload)
    transcript = payload["transcript_path"]
    folder, state = root / session, store_for(root, session, turn)
    state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.exists():
        return None  # this turn already had a handoff, even a closed one
    latch = goal and goal["mode"] == "transfer"
    if latch and not new_private_file(folder / ".goal-requested", turn + "\n"):
        return None
    record = {
        "session": session, "turn": turn, "cwd": payload["cwd"], "terminal": terminal,
        "pid": info["foreground"]["pid"], "transcript": transcript, "nonce": secrets.token_hex(12),
        "origin": origin, "offset": os.path.getsize(transcript), "usage": used,
    }
    if prompt is not None:
        record["prompt"] = prompt
    if goal:
        record["goal"] = goal
    if not new_private_file(state, json.dumps(record)):
        if latch:
            (folder / ".goal-requested").unlink(missing_ok=True)  # ours: never leave a latch without a record
        return None
    return record


def mid_turn_request(record, lead):
    goal = record.get("goal")
    return f"Codex Context Handoff: {lead}\n" + handoff_request(record["nonce"]) + goal_request(goal, record["nonce"])


def gate_lead(checkpoint):
    return (
        "this tool call was not run. The context threshold was crossed while a Goal is active, so the Goal "
        "moves to a fresh chat now. " + (
            f"You may make at most {checkpoint} more tool call(s), only to reach a safe checkpoint (finish a "
            "half-applied edit, note running workers); start no new work. " if checkpoint else "Start no new work. "
        ) + "Other tool calls are denied until this turn ends."
    )


def manual_lead(record):
    return (
        "the user asked to hand this chat off now. " + (
            "Until this turn ends, tool calls other than the Goal steps below are limited to reaching a safe "
            "checkpoint." if goal_moves(record) else ""
        )
    )


def goal_moves(record):
    return bool(record.get("goal")) and record["goal"]["mode"] == "transfer"


def tool_name(payload):
    name = payload.get("tool_name")
    if not isinstance(name, str):
        return ""
    return name[len("functions."):] if name.startswith("functions.") else name


def tool_args(payload):
    value = payload.get("tool_input")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def deny(text):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": text,
    }}


def gate_hook(payload, root, terminal):
    """PreToolUse: arm a Goal transfer at a tool boundary and hold the turn to it until the turn ends."""
    session, turn = ids(payload)
    transcript = payload.get("transcript_path")
    if not session or not transcript or not payload.get("cwd") or disabled(root, session, turn):
        return {}
    folder, state = root / session, store_for(root, session, turn)
    if state.is_file():
        record = json.loads(state.read_text(encoding="utf-8"))
        if not goal_moves(record) or record.get("origin") not in {"tool", "manual"} or any(
            state.with_suffix(suffix).exists() for suffix in (".md", ".released", *DONE)
        ):
            return {}
        with open_lock(state.with_suffix(".gate-lock")):
            return gate_decision(payload, state, record)
    name = tool_name(payload)
    if name in GOAL_TOOLS or not goal_consent(root) or (folder / ".off").exists():
        return {}
    latest = recent_turn(transcript)
    limit = threshold()
    if limit is None or not latest or latest["id"] != turn or not headroom(folder, transcript, latest["usage"], limit):
        return {}
    used = usage_percent(latest["usage"])
    notice = settle_orphans(folder, turn)
    shown = {"systemMessage": notice} if notice else {}
    if transfer_blocked(folder, used) or pending(folder) or not confirm_restore(folder, transcript, session):
        return shown
    status, row = goal_state(transcript, session, latest.get("trigger"))
    if status != "row" or row["status"] != "active" or (
        row["token_budget"] is not None and row["token_budget"] - row["tokens_used"] <= 0
    ):
        return shown  # the Stop hook reports unknown state and exhausted budgets once
    info, _ = check_chat(payload, terminal)
    consent = goal_consent(root)
    if not info or not consent:
        return shown
    record = arm_record(payload, root, terminal, info, {"mode": "transfer", "since": consent["since"], "arm": row},
                        "tool", used)
    if not record:
        return shown
    budget = checkpoint_calls()
    replace_private(state.with_suffix(".gate"), json.dumps({"checkpoint": budget, "denied": 0, "updated": None}))
    return dict(deny(mid_turn_request(record, gate_lead(budget))), **shown)


class open_lock:
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        self.stream = os.fdopen(os.open(self.path, os.O_WRONLY | os.O_CREAT, 0o600), "w")
        fcntl.flock(self.stream, fcntl.LOCK_EX)
        return self.stream

    def __exit__(self, *_):
        self.stream.close()


def gate_reminder(record, locked, why):
    nonce = record["nonce"]
    if locked:
        return (
            f"Codex Context Handoff: {why} The Goal is paused for the transfer; make no more tool calls. End the "
            f"turn now: start your final answer with HANDOFF READY {nonce} GOAL transferred, then the handoff note."
        )
    return (
        f"Codex Context Handoff: {why} Call get_goal and update_goal with status \"paused\" (print both raw "
        f"results), then end the turn: start your final answer with HANDOFF READY {nonce} GOAL transferred, then "
        "the handoff note. Do not create or edit any other Goal."
    )


def gate_decision(payload, state, record):
    """Allow the native Goal steps, a bounded checkpoint, and nothing else, while a transfer is armed.

    Codex may not run PreToolUse for its native Goal tools, so the pause is read from the Goal DB on
    every call: once the armed Goal is no longer active, nothing but get_goal runs until the turn ends.
    """
    gate = read_json(state.with_suffix(".gate")) or {"checkpoint": 0, "denied": 0, "updated": None}
    rows = rows_after(record["transcript"], record["offset"])
    if rows is None or user_input(rows, record.get("prompt")):
        # The user (or a worker message) spoke after the arm: their request wins. Settle the attempt now,
        # since an interrupted turn may never reach Stop.
        return settle(state, record, "user input arrived before the Goal was paused")
    name = tool_name(payload)
    status, row = goal_state(record["transcript"], record["session"])
    unreadable = status == "unknown"
    locked = bool(gate.get("updated")) or (status == "row" and (
        row["goal_id"] != record["goal"]["arm"]["goal_id"] or row["status"] != "active"
    )) or status == "none"
    if not locked and not unreadable and record.get("origin") == "tool":
        latest = recent_turn(record["transcript"])
        limit = threshold()
        if latest and latest["id"] == record["turn"] and (limit is None or not exceeds_threshold(latest["usage"], limit)):
            # Auto-compaction already made room: stop holding the turn and try again later if needed.
            new_private_file(state.with_suffix(".released"), "context was compacted below the threshold\n")
            put_off(state, record, "the context was compacted below the threshold")
            return {}
    allowed, why = False, "this tool call was denied while the Goal transfer is armed."
    if name == "get_goal" or (name == CODE_MODE and not locked):
        allowed = True  # after the pause even a script is not needed: only the final answer is
    elif unreadable:
        why = f"the Goal state could not be read ({row}), so no other work may run during the transfer."
    elif name == "update_goal":
        if not locked and tool_args(payload).get("status") == "paused":
            allowed, gate["updated"] = True, "paused"
        else:
            why = "only one update_goal, with status paused, is allowed for the Goal transfer."
    elif name == "create_goal":
        why = "create_goal is not allowed in this chat during a Goal transfer."
    elif not locked and gate.get("checkpoint", 0) > 0:
        allowed, gate["checkpoint"] = True, gate["checkpoint"] - 1
    elif not locked:
        why = "the safe-checkpoint allowance is used up."
    if allowed:
        replace_private(state.with_suffix(".gate"), json.dumps(gate))
        return {}
    gate["denied"] = gate.get("denied", 0) + 1
    replace_private(state.with_suffix(".gate"), json.dumps(gate))
    if gate["denied"] > MAX_DENIALS:
        return give_up(state, record, gate)
    result = deny(gate_reminder(record, locked and not unreadable, why))
    if unreadable and gate["denied"] == 1:
        result["systemMessage"] = f"Context handoff: the Goal state could not be read during the transfer ({row})."
    return result


def settle(state, record, why):
    """End an armed transfer that will not complete in this turn, at once: put off while the Goal is
    untouched, otherwise fail closed (the Goal stays paused). Returns the hook output."""
    new_private_file(state.with_suffix(".released"), why + "\n")
    if untouched(state, record):
        result = put_off(state, record, why)
    else:
        result = goal_failure(state, record, why)
    return {"systemMessage": result.get("systemMessage", "")} if result.get("systemMessage") else {}


def settle_orphans(folder, turn):
    """A handoff armed in an earlier turn that ended without its note (an interrupt, say) is over: a
    Goal transfer is settled (put off while the Goal is untouched, else failed closed), any other
    handoff is closed. Without this it would stay pending and block every later handoff in the chat.
    Returns the messages for the user, joined."""
    messages = []
    for state in pending(folder):
        if state.name == turn or state.with_suffix(".md").exists():
            continue
        try:
            record = json.loads(state.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            new_private_file(state.with_suffix(".closed"), "unreadable handoff record\n")
            continue
        if goal_moves(record):
            messages.append(settle(state, record, "the turn ended without a handoff note").get("systemMessage"))
        else:
            new_private_file(state.with_suffix(".closed"), "the turn ended without a handoff note\n")
    return " ".join(filter(None, messages))


def give_up(state, record, gate):
    """The model kept working through MAX_DENIALS denials: stop holding the turn, visibly."""
    new_private_file(state.with_suffix(".released"), f"gave up after {MAX_DENIALS} denied tool calls\n")
    status, row = goal_state(record["transcript"], record["session"])
    if status != "row" or row["status"] != "active" or row["goal_id"] != record["goal"]["arm"]["goal_id"]:
        result = goal_failure(state, record, f"the model kept calling tools after {MAX_DENIALS} denials")
    else:
        result = put_off(state, record, f"the model kept calling tools after {MAX_DENIALS} denials")
    return {"systemMessage": result.get("systemMessage", "")}


def put_off(state, record, why):
    """End this transfer attempt with the Goal still active and untouched; a later one may try again."""
    folder = state.parent
    count = ((read_json(folder / ".goal-retry") or {}).get("count") or 0) + 1
    new_private_file(state.with_suffix(".closed"), f"goal transfer put off: {why}\n")
    replace_private(folder / ".goal-retry", json.dumps({"count": count, "usage": record.get("usage") or 0}))
    (folder / ".goal-requested").unlink(missing_ok=True)
    if count >= MAX_ATTEMPTS:
        new_private_file(folder / ".goal-wait", f"goal transfer put off {count} times\n")
        return {"systemMessage": (
            f"Context handoff: the Goal transfer was put off ({why}) and will not be tried again in this chat "
            f"after {count} attempts. The Goal keeps running here; Codex auto-compaction will handle context."
        )}
    return {"systemMessage": (
        f"Context handoff: the Goal transfer was put off ({why}). The Goal keeps running here; the transfer "
        f"will be tried again after {RETRY_GROWTH:g} more percentage points of context use."
    )}


def user_put_off(state, record):
    """The user spoke after the arm and the Goal was never touched: put the attempt off, not fail it."""
    rows = armed_rows(record)
    return rows is not None and user_input(rows, record.get("prompt")) and untouched(state, record)


def untouched(state, record):
    """Whether the armed Goal is still active and no Goal tool ran since the arm."""
    rows = armed_rows(record)
    status, row = goal_state(record["transcript"], record["session"])
    arm = record["goal"]["arm"]
    if status != "row" or row["status"] != "active" or row["goal_id"] != arm["goal_id"]:
        return False
    if rows is None:
        # Our request never reached the transcript (interrupted first), so the model never saw it.
        return row["updated_at_ms"] == arm["updated_at_ms"]
    return goal_calls(rows) == (0, 0)


def stop_request_again(record, state):
    gate = read_json(state.with_suffix(".gate")) or {}
    nonce = record["nonce"]
    status, row = goal_state(record["transcript"], record["session"])
    if goal_moves(record) and (gate.get("updated") == "paused" or (
        status == "row" and row["status"] == "paused" and row["goal_id"] == record["goal"]["arm"]["goal_id"]
    )):
        return (
            "Codex Context Handoff: the Goal was paused for the transfer. Do not call any Goal tool again. Start "
            f"your final answer with this exact plain-text line:\nHANDOFF READY {nonce} GOAL transferred\nThen write "
            "a short Markdown handoff with the goal, user constraints, decisions, worktree and branch, changes, "
            "validation, next action, and the IDs and state of any live Herdr workers."
        )
    return handoff_request(nonce) + goal_request(record.get("goal"), nonce)


def arm_now(payload, root, terminal, prompt=None):
    """(record, None) after arming an explicit handoff for this turn, else (None, why not)."""
    session, turn = ids(payload)
    if not session or not payload.get("transcript_path") or not payload.get("cwd"):
        return None, "could not identify this chat and turn"
    folder, transcript = root / session, payload["transcript_path"]
    if (folder / ".off").exists():
        return None, "handoff is off for this chat (submit `handoff on` first)"
    info, why = check_chat(payload, terminal)
    if not info:
        return None, why
    settle_orphans(folder, turn)
    if pending(folder):
        return None, "a handoff is already pending in this chat"
    status, row = goal_state(transcript, session)
    goal = None
    if status == "unknown":
        return None, f"the Goal state could not be read ({row})"
    if status == "row" and row["status"] != "active":
        goal = {"mode": "left", "arm": row}  # paused before this request: never recreated
    elif status == "row":
        consent = goal_consent(root)
        if not consent:
            return None, "this chat has an active Goal and Goal transfer is off (submit `handoff goal transfer on`)"
        if row["token_budget"] is not None and row["token_budget"] - row["tokens_used"] <= 0:
            return None, "the active Goal's token budget is exhausted"
        (folder / ".goal-requested").unlink(missing_ok=True)  # an explicit request is a new attempt
        goal = {"mode": "transfer", "since": consent["since"], "arm": row}
    record = arm_record(payload, root, terminal, info, goal, "manual", usage_percent(last_usage(transcript)), prompt)
    if not record:
        return None, "this turn already has a handoff"
    if goal_moves(record):
        state = store_for(root, session, turn)
        replace_private(state.with_suffix(".gate"), json.dumps({"checkpoint": checkpoint_calls(), "denied": 0,
                                                                "updated": None}))
    return record, None


def manual_hook(payload, root, terminal):
    """`handoff now` typed as the whole prompt: arm this turn and give the model the request with it."""
    text = " ".join((payload.get("prompt") or "").split())
    if text.lower() not in NOW:
        return None
    record, why = arm_now(payload, root, terminal, prompt=text)
    if not record:
        return {"decision": "block", "reason": f"Codex Context Handoff: no handoff was started: {why}."}
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": mid_turn_request(
        record, manual_lead(record),
    )}}


def find_transcript(session):
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    found = sorted((home / "sessions").glob(f"*/*/*/rollout-*-{session}.jsonl"))
    return found[-1] if found else None


def user_asked(transcript, turn):
    """Whether a user message (not this plugin's continuation) arrived in the given turn."""
    tail = TRANSCRIPT_TAIL
    while True:
        started = asked = False
        for row_type, item in transcript_rows(transcript, tail, (b'"event_msg"',)):
            kind = item.get("type")
            if kind == "task_started":
                started, asked = item.get("turn_id") == turn, False
            elif started and kind == "item_completed" and isinstance(item.get("item"), dict) and (
                item["item"].get("type") == "UserMessage"
            ):
                text = message_text(item["item"].get("content")).strip()
                asked = asked or (bool(text) and not text.startswith("Codex Context Handoff:"))
        if started or tail >= os.path.getsize(transcript):
            return started and asked
        tail *= 4


def request_transfer(root):
    """`codex context-handoff request-transfer`: the model arms the transfer the user asked for in words.

    Run from a tool call in the chat itself, before the Goal is paused. The same guards as the hooks
    apply, plus a user message in the running turn; plugin consent is still required for an active Goal.
    """
    root = Path(root).resolve()
    session = os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID") or ""
    terminal = os.environ.get("HC_TERMINAL_ID", "")

    def refuse(why):
        print(f"Codex Context Handoff: the transfer was not armed: {why}.", file=sys.stderr)
        return 2

    if not ID.fullmatch(session):
        return refuse("CODEX_THREAD_ID is missing; run this from a tool call in the Codex chat")
    transcript = find_transcript(session)
    if not transcript:
        return refuse(f"no transcript was found for chat {session}")
    with transcript.open("rb") as stream:
        meta = json.loads(stream.readline(1024 * 1024)).get("payload") or {}
    latest = recent_turn(transcript)
    if not latest or latest["complete"]:
        return refuse("no turn is running in this chat")
    payload = {"session_id": session, "turn_id": latest["id"], "cwd": meta.get("cwd"),
               "transcript_path": str(transcript)}
    if disabled(root, session, latest["id"]):
        return refuse("handoff is off for this chat or this turn")
    if not user_asked(transcript, latest["id"]):
        return refuse("no user message in this turn asked for it")
    info, why = check_chat(payload, terminal)
    if not info:
        return refuse(why)
    try:
        current = (root / session / ".hook-script").read_text(encoding="utf-8") == hook_script_record(
            info["foreground"]["pid"]
        )
    except OSError:
        current = False
    if not current:
        return refuse(
            "this chat's Codex process has not run this version of the handoff hooks. If it loaded an older plugin "
            "version, restart Codex through the launcher or continue in a new chat (a prompt does not upgrade it); "
            "otherwise submit any prompt in this chat first"
        )
    record, why = arm_now(payload, root, terminal)
    if not record:
        return refuse(why)
    print(mid_turn_request(record, "the transfer the user asked for is armed. Make each Goal call below in a new "
                           "tool call; this helper must have been the only call in its own tool call, or the transfer "
                           "fails closed. " + (
        "Until this turn ends, tool calls other than the Goal steps below are limited to reaching a safe "
        "checkpoint." if goal_moves(record) else ""
    )))
    return 0


def stop_hook(payload, root, terminal):
    session, turn_id = ids(payload)
    transcript = payload.get("transcript_path")
    if not session or not transcript or not payload.get("cwd") or (root / session / ".off").exists():
        return {}
    # Before the .skip test: the turn that received a handoff is skipped, but it must create the Goal.
    restored = restore_check(payload, root, session)
    if restored is not None:
        return restored
    if disabled(root, session, turn_id):
        return {}
    state = store_for(root, session, turn_id)
    if state.is_file():
        # Our request already ran this turn; capture its answer whatever else continued the turn.
        return capture(payload, state)
    # stop_hook_active alone may come from another plugin's Stop hook, so it is not a reason to skip.
    latest = recent_turn(transcript)
    limit = threshold()
    folder, goal = root / session, None
    if limit is None or not latest or latest["id"] != turn_id or not headroom(folder, transcript, latest["usage"], limit):
        return {}
    info, _ = check_chat(payload, terminal)
    if not info:
        return {}
    used = usage_percent(latest["usage"])
    notice = settle_orphans(folder, turn_id)
    if notice:
        return {"systemMessage": notice}  # the next Stop past the threshold arms again if it may
    status, row = goal_state(transcript, session, latest.get("trigger"))
    if status == "unknown":
        return goal_wait(folder, f"could not read Goal state: {row}")  # never treated as no Goal
    if status == "row" and row["status"] != "active":
        goal = {"mode": "left", "arm": row}
    elif status == "row":
        if transfer_blocked(folder, used):
            return {}  # a failed transfer, one in progress, or one put off until more context is used
        consent = goal_consent(root)
        if not consent:
            # A separate marker: turning transfer on later lets this chat try once.
            return goal_wait(folder, (
                "this chat has an active Goal and Goal transfer is not enabled (handoff goal transfer on)"
            ), ".goal-consent-wait")
        if row["token_budget"] is not None and row["token_budget"] - row["tokens_used"] <= 0:
            return goal_wait(folder, "the active Goal's token budget is exhausted")
        goal = {"mode": "transfer", "since": consent["since"], "arm": row}
    record = arm_record(payload, root, terminal, info, goal, "stop", used)
    if not record:
        return {}
    return {"decision": "block", "reason": handoff_request(record["nonce"]) + goal_request(goal, record["nonce"])}


def capture(payload, state):
    if any(state.with_suffix(suffix).exists() for suffix in (".md", *DONE)):
        return {}
    record = json.loads(state.read_text(encoding="utf-8"))
    goal = record.get("goal")
    transfer = goal and goal["mode"] == "transfer"
    answer = (payload.get("last_assistant_message") or "").strip()
    marker, _, body = answer.partition("\n")
    base = f"HANDOFF READY {record['nonce']}"
    # The GOAL suffix is informative only; the transfer is proven from the rollout and the DB.
    if marker.rstrip() not in {base, f"{base} GOAL transferred", f"{base} GOAL left"} or not (
        0 < len(body.strip()) <= MAX_NOTE
    ):
        mid_turn = record.get("origin") in {"tool", "manual"}
        if transfer and user_put_off(state, record):
            return put_off(state, record, "user input arrived before the Goal was paused")
        if mid_turn and not record.get("stop_requested"):
            # Armed mid-turn: the turn ended without the note, so ask once more here, with the same nonce.
            record["stop_requested"] = True
            replace_private(state, json.dumps(record))
            return {"decision": "block", "reason": stop_request_again(record, state)}
        if transfer:
            return goal_failure(state, record, "no handoff note")
        new_private_file(state.with_suffix(".closed"), "no handoff note\n")
        return {}
    note = body.strip() + "\n"
    if transfer:
        # Consent can be withdrawn while the turn runs (a blocked control or another terminal).
        moved, why = (None, "Goal transfer was turned off") if not goal_consent(state.parent.parent) else (
            verify_transfer(record, state)
        )
        if not moved:
            if user_put_off(state, record):
                return put_off(state, record, "user input arrived before the Goal was paused")
            return goal_failure(state, record, why)
        if not new_private_file(state.with_suffix(".goal.json"), json.dumps(moved, ensure_ascii=False)):
            return {}
        note += goal_note(moved)
    elif goal:
        why = verify_left(record)
        if why:
            new_private_file(state.with_suffix(".closed"), f"goal changed during the handoff: {why}\n")
            new_private_file(state.parent / ".goal-wait", f"goal changed during the handoff: {why}\n")
            return {"systemMessage": (
                f"Context handoff stopped: the Goal in this chat changed during the handoff turn ({why}), so "
                "nothing was handed off. Work continues here."
            )}
    if not new_private_file(state.with_suffix(".md"), note):
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
        + (" The Goal is paused here and will be recreated in the fresh chat; if the handoff is "
           "cancelled it stays paused (resume it with /goal)." if transfer else "")
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
    folder = root / session
    if limit is None or not latest or latest["id"] != turn_id or not headroom(folder, transcript, latest["usage"], limit):
        return {}
    if latest.get("trigger") == "goal":
        return {}  # Goal turns chain without a user; the PreToolUse gate arms their transfer instead
    text = nudge(limit)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not new_private_file(marker, "") or not check_chat(payload, terminal)[0]:
        return {}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}


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
        cancelled = [s for s in pending(folder) if new_private_file(
            s.with_suffix(".cancelled"), "handoff off\n" + goal_paused_line(s)
        )]
        lines.append("Handoff is off for this chat." + (
            f" Cancelled {len(cancelled)} armed or pending handoff(s)." if cancelled else ""
        ))
        lines.extend(filter(None, map(goal_paused_line, cancelled)))
    elif command == "on":
        flag.unlink(missing_ok=True)
    elif command == "goal-on" and not consent_file(root):
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        replace_private(root / CONSENT, json.dumps({
            "enabled": True, "since": utc_now(), "chat": session, "command": "handoff goal transfer on",
        }))
    elif command == "goal-off":
        (root / CONSENT).unlink(missing_ok=True)
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
    consent = consent_file(root)
    lines.append("Goal transfer: " + (f"on since {consent['since']}" if consent else "off") + (
        " (disabled by CODEX_CONTEXT_HANDOFF_GOAL)" if consent and goal_killed() else ""
    ) + ".")
    for state in pending(folder):
        stage = "switch pending" if state.with_suffix(".md").exists() else "armed, waiting for a note"
        lines.append(f"Pending handoff {state.name}: {stage}.")
    paused = latest_goal_transfer(folder)
    if paused:
        lines.append(paused)
    return {"decision": "block", "reason": "Codex Context Handoff: " + " ".join(lines)}


def latest_goal_transfer(folder):
    """A status line for this chat's latest Goal paused for a handoff that was not received."""
    found = []
    for path in folder.glob("*.goal.json") if folder.is_dir() else ():
        state = path.with_name(path.name[: -len(".goal.json")])
        if state.with_suffix(".received").exists():
            continue
        try:
            paused_at = json.loads(path.read_text(encoding="utf-8"))["paused_at_ms"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        stage = next((s[1:] for s in (".cancelled", ".closed") if state.with_suffix(s).exists()), "switch pending")
        found.append((paused_at, stage))
    if not found:
        return ""
    paused_at, stage = max(found)
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(paused_at // 1000)) if type(paused_at) is int else "?"
    return f"Goal paused for transfer at {when} ({stage}); resume it with /goal if the handoff did not continue."


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
        pid = int(evidence.read_text(encoding="utf-8"))
        if not in_foreground_tree(pid):
            raise ValueError("another process")
    except (OSError, ValueError):
        info = terminal_info(terminal, payload.get("cwd"))
        if not info or not in_foreground_tree(info["foreground"]["pid"]):
            return
        pid = info["foreground"]["pid"]
        evidence.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        replace_private(evidence, f"{pid}\n")
    note_hook_script(root / session, pid)


def hook_script_record(pid):
    return f"{Path(__file__).resolve()}\n{pid}\n"


def note_hook_script(folder, pid):
    """Record, for this chat only, that this hook script runs in its foreground Codex `pid`.

    `codex context-handoff request-transfer` runs exactly that script, and only from that process, so
    a chat whose process still runs an older hook version (which never writes this file) is refused
    before its Goal is touched.
    """
    path = folder / ".hook-script"
    try:
        if path.read_text(encoding="utf-8") == hook_script_record(pid):
            return
    except OSError:
        pass
    replace_private(path, hook_script_record(pid))


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
        + (" A Goal was transferred with this handoff: before anything else, call create_goal with exactly the "
           "objective and token_budget from the note's \"Goal transfer\" section and print its raw result."
           if state.with_suffix(".goal.json").is_file() else "")
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
    if consent_revoked(state):
        return consent_revoked(state)
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
        if consent_revoked(state):
            raise RuntimeError(f"{consent_revoked(state)} before /clear.")
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
            new_private_file(state.with_suffix(".closed"), f"{error}\n{goal_paused_line(state)}")
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
    goal = goal_paused_line(state)
    new_private_file(state.with_suffix(".cancelled"), (
        f"a prompt was submitted in chat {chat if ID.fullmatch(chat) else 'unknown'} before the continuation\n{goal}"
    ))
    return (
        "Context handoff stopped: a prompt was submitted before the continuation. "
        "The handoff note stays in the plugin data directory." + (f" {goal}" if goal else "")
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
        new_private_file(
            state.with_suffix(".cancelled"), "the continuation arrived mixed with other text\n" + goal_paused_line(state)
        )
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
    transfer = None
    if state.with_suffix(".goal.json").is_file():
        if consent_revoked(state):
            new_private_file(state.with_suffix(".closed"), "Goal transfer was turned off\n" + goal_paused_line(state))
            return {"decision": "block", "reason": (
                "This handoff carries a paused Goal, but Goal transfer was turned off before it arrived, so it "
                f"was not run. {goal_paused_line(state)}" + manual
            )}
        transfer = json.loads(state.with_suffix(".goal.json").read_text(encoding="utf-8"))
    if not new_private_file(state.with_suffix(".received"), destination + "\n"):
        return {"decision": "block", "reason": "This handoff has already been delivered."}
    # The receiving turn is checked like any other; its headroom is measured from this chat's first
    # request (baseline), so a note that starts past the threshold cannot hand off again at once.
    folder = root / destination
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    new_private_file(folder / ".received-from", f"{source} {turn}\n")
    if not transfer:
        return {}
    # This chat's hooks confirm once that the Goal was recreated exactly (restore_check, confirm_restore).
    new_private_file(folder / ".goal-restore", json.dumps({
        "state": str(state), "source_session": transfer["source_session"], "objective": transfer["objective"],
        "objective_sha256": transfer["objective_sha256"], "remaining": transfer["remaining"],
    }, ensure_ascii=False))
    replace_private(folder / ".goal-lineage.json", json.dumps(
        dict(transfer["lineage"], objective_sha256=transfer["objective_sha256"])
    ))
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": restore_instruction(
        transfer, "a Goal was transferred with this handoff. Before anything else:"
    )}}


def main():
    if sys.argv[1:2] == ["--switch"]:
        switch_chat(Path(sys.argv[2]))
        return
    if sys.argv[1:2] == ["--request-transfer"] and len(sys.argv) == 3:
        sys.exit(request_transfer(sys.argv[2]))
    payload = json.load(sys.stdin)
    terminal = os.environ.get("HC_TERMINAL_ID", "")
    root = os.environ.get("PLUGIN_DATA")
    if not root:
        return
    # Resolved, so a plugin data directory that is a symlink to another install's (same handoffs, other
    # marketplace key) yields the same note path in the continuation on both sides.
    root = Path(root).resolve()
    event = payload.get("hook_event_name")
    opted_in = os.environ.get("CODEX_CONTEXT_HANDOFF") == "1" and TERMINAL.fullmatch(terminal)
    if event == "UserPromptSubmit":
        notice = mark_takeover(payload, root, terminal) if opted_in else None
        # Runs before prompt_hook, so only a prompt after the continuation (or a second one) cancels.
        restore = cancel_restore(payload, root)
        if restore:
            notice = f"{notice} {restore}" if notice else restore
        # Controls work even without the opt-in so `handoff status` can explain why.
        result = control_hook(payload, root, terminal)
        if result is not None:
            if notice:
                result["reason"] += f" {notice}"
        elif opted_in:
            mark_closing(payload, root)
            result = manual_hook(payload, root, terminal) or prompt_hook(payload, root, terminal)
            if notice and "decision" not in result:
                result["systemMessage"] = notice
        elif notice:
            result = {"systemMessage": notice}
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
    elif event == "PreToolUse":
        print(json.dumps(gate_hook(payload, root, terminal)))
    elif event == "PostToolUse":
        print(json.dumps(tool_hook(payload, root, terminal)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Codex Context Handoff: {error}", file=sys.stderr)
        if sys.argv[1:2] == ["--switch"]:
            try:
                new_private_file(Path(sys.argv[2]).with_suffix(".closed"), f"{error}\n")
            except OSError:
                pass
            sys.exit(1)
