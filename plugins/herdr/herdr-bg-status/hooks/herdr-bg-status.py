#!/usr/bin/env python3
"""Keep herdr's agent status at `working` while a Claude Code session still
has background work after its turn ends.

Claude Code reports its status to herdr itself (OSC 7501), but only for the
main turn: when the turn ends it reports done/idle even if background Bash
commands or backgrounded MCP calls are still running. (Background agents it
sends as separate `id=` records, which the herdr app ignores.)

Stop hook: if the session still has background work, start a detached
watcher. Whenever Claude reports done/idle while that work remains, the
watcher replaces it with `working` ("background: ..."); it leaves Claude's
own working/blocked/error reports alone. When the work ends, Claude normally
starts a new turn (task notification) and reports for itself; if it does not
within a few seconds, the watcher reports `done` so the status is not stuck.

Background work counted:
  - shells: children of the claude process running a
    `.../shell-snapshots/snapshot-...` shell (run_in_background, ctrl+b,
    Monitor). The turn has ended, so no foreground Bash is running. A shell
    whose process tree listens on a TCP port (a dev server) is not counted.
  - agents: working/blocked `records` Claude reports to herdr-core.
  - MCP calls moved to the background ("MCP tool ... background as task k..."
    in the session transcript) until their <task-notification> arrives, a
    TaskStop names them, or MCP_MAX passes.

Outside a herdr terminal (no HC_TERMINAL_ID) it does nothing.
Turn it off for a session with HERDR_BG_STATUS=0.
Log: ~/.cache/claude-herdr-bg/watch.log
"""
import base64
import calendar
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

APP = "claude-code"
STATE_DIR = os.path.expanduser("~/.cache/claude-herdr-bg")
LOG = os.path.join(STATE_DIR, "watch.log")
LOG_MAX = 256 * 1024
SNAPSHOT_RE = re.compile(r"/shell-snapshots/snapshot-")
MCP_LAUNCH_RE = re.compile(r'^MCP tool "([^"]+)".*?background as task ([a-z0-9]{6,32})\b', re.S)
NOTIF_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
TASK_ID_RE = re.compile(r"<task-id>([^<]+)</task-id>")
STATUS_RE = re.compile(r"<status>([^<]+)</status>")
POLL = 2.0          # seconds between checks
GRACE = 6.0         # after the work ends, how long to let Claude take over
MCP_MAX = 30 * 60   # stop counting a backgrounded MCP call after this long
MAX_LIFE = 12 * 3600
SCRIPT = os.path.abspath(__file__)


def log(term, text):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a") as f:
            f.write("%s %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), term, text))
    except OSError:
        pass


def run(argv, timeout=5):
    try:
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return ""


def hc_path():
    p = os.path.expanduser("~/.local/bin/hc")
    return p if os.access(p, os.X_OK) else shutil.which("hc")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def find_claude_pid():
    pid = os.getppid()
    for _ in range(6):
        out = run(["ps", "-o", "ppid=,comm=", "-p", str(pid)]).strip()
        if not out:
            return None
        ppid, _, comm = out.partition(" ")
        if os.path.basename(comm.strip()) in ("claude", "claude.exe"):
            return pid
        try:
            pid = int(ppid)
        except ValueError:
            return None
        if pid <= 1:
            return None
    return None


def tty_of(pid):
    t = run(["ps", "-o", "tty=", "-p", str(pid)]).strip()
    if not t or t.startswith("?"):
        return None
    return t if t.startswith("/dev/") else "/dev/" + t


# --- background shells -----------------------------------------------------

def listening_pids(pids):
    if not pids:
        return set()
    out = run(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN",
               "-p", ",".join(str(p) for p in pids), "-Fp"])
    return {int(l[1:]) for l in out.splitlines() if l.startswith("p") and l[1:].isdigit()}


def count_shells(claude_pid):
    """Return (working shells, server shells)."""
    procs = {}
    for line in run(["ps", "-ax", "-o", "pid=,ppid=,args="]).splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        try:
            procs[int(parts[0])] = (int(parts[1]), parts[2])
        except ValueError:
            continue
    shells = [p for p, (pp, args) in procs.items()
              if pp == claude_pid and SNAPSHOT_RE.search(args)]
    if not shells:
        return 0, 0
    children = {}
    for p, (pp, _) in procs.items():
        children.setdefault(pp, []).append(p)
    trees = {}
    for s in shells:
        tree, todo = [], [s]
        while todo:
            p = todo.pop()
            tree.append(p)
            todo.extend(children.get(p, ()))
        trees[s] = tree
    listening = listening_pids(sorted({p for t in trees.values() for p in t}))
    servers = sum(1 for s in shells if listening.intersection(trees[s]))
    return len(shells) - servers, servers


# --- backgrounded MCP calls (from the session transcript) ------------------

def iso_to_epoch(ts):
    try:
        return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return time.time()


def tool_result_texts(d):
    msg = d.get("message") if isinstance(d, dict) else None
    content = msg.get("content") if isinstance(msg, dict) else None
    if not isinstance(content, list):
        return
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "tool_result":
            continue
        c = item.get("content")
        if isinstance(c, str):
            yield c
        elif isinstance(c, list):
            yield "".join(x.get("text", "") for x in c if isinstance(x, dict))


class Transcript:
    def __init__(self, path):
        self.path = path
        self.pos = 0
        self.started = {}  # task id -> (epoch, tool label)
        self.ended = set()

    def update(self):
        if not self.path:
            return
        try:
            with open(self.path, "rb") as f:
                f.seek(self.pos)
                data = f.read()
        except OSError:
            return
        end = data.rfind(b"\n")
        if end < 0:
            return
        self.pos += end + 1
        for line in data[:end + 1].splitlines():
            if b"background as task " in line and b"MCP tool" in line:
                self._launch(line)
            if b"<task-notification>" in line:
                text = line.decode("utf-8", "replace")
                for block in NOTIF_RE.findall(text):
                    tid, status = TASK_ID_RE.search(block), STATUS_RE.search(block)
                    if tid and (not status or status.group(1).strip() not in ("running", "in_progress")):
                        self.ended.add(tid.group(1).strip())
            if b'"TaskStop"' in line:
                self._stop(line)

    def _launch(self, line):
        try:
            d = json.loads(line)
        except ValueError:
            return
        if d.get("type") != "user":
            return
        for text in tool_result_texts(d):
            m = MCP_LAUNCH_RE.match(text)
            if m:
                self.started.setdefault(m.group(2), (iso_to_epoch(d.get("timestamp")), m.group(1)))

    def _stop(self, line):
        try:
            d = json.loads(line)
        except ValueError:
            return
        content = (d.get("message") or {}).get("content")
        for item in content if isinstance(content, list) else ():
            if isinstance(item, dict) and item.get("type") == "tool_use" and item.get("name") == "TaskStop":
                inp = item.get("input") or {}
                tid = inp.get("task_id") or inp.get("shell_id")
                if tid:
                    self.ended.add(tid)

    def running(self):
        now = time.time()
        return [label for tid, (ts, label) in sorted(self.started.items())
                if tid not in self.ended and now - ts < MCP_MAX]


# --- status ----------------------------------------------------------------

def hc_state(term):
    """Return (main status dict or None, number of working/blocked records)."""
    hc = hc_path()
    if not hc:
        return None, 0
    out = run([hc, "get", term, "--json"])
    try:
        d = json.loads(out)
    except ValueError:
        return None, 0
    records = d.get("records") or {}
    busy = sum(1 for r in records.values()
               if isinstance(r, dict) and r.get("state") in ("working", "blocked"))
    return d.get("status"), busy


def describe(shells, agents, mcp):
    parts = []
    if shells:
        parts.append("%d shell%s" % (shells, "" if shells == 1 else "s"))
    if agents:
        parts.append("%d agent%s" % (agents, "" if agents == 1 else "s"))
    if mcp:
        parts.append(", ".join(mcp[:2]) + (" +%d" % (len(mcp) - 2) if len(mcp) > 2 else ""))
    return "background: " + ", ".join(parts)


def emit(tty, state, msg=None):
    body = "state=%s:app=%s" % (state, APP)
    if msg:
        body += ":msg=" + base64.b64encode(msg.encode("utf-8")).decode("ascii")
    seq = ("\x1b]7501;%s\x07" % body).encode("ascii")
    fd = os.open(tty, os.O_WRONLY | os.O_NOCTTY)
    try:
        os.write(fd, seq)
    finally:
        os.close(fd)


def pidfile(term):
    return os.path.join(STATE_DIR, re.sub(r"[^A-Za-z0-9_.-]", "_", term) + ".pid")


def stop_previous(term):
    path = pidfile(term)
    try:
        old = int(open(path).read().strip())
    except (OSError, ValueError):
        return
    # Match the file name, not the full path: a plugin update moves the script.
    args = run(["ps", "-o", "args=", "-p", str(old)])
    if old != os.getpid() and alive(old) and os.path.basename(SCRIPT) + " watch " in args:
        try:
            os.kill(old, signal.SIGTERM)
        except OSError:
            pass


def is_ours(st, msg):
    return bool(st) and st.get("state") == "working" and st.get("msg") == msg


def work(claude_pid, term, transcript):
    """Return (shells, servers, agents, mcp labels)."""
    shells, servers = count_shells(claude_pid)
    _, agents = hc_state(term)
    transcript.update()
    return shells, servers, agents, transcript.running()


def watch(claude_pid, tty, term, transcript_path):
    os.makedirs(STATE_DIR, exist_ok=True)
    stop_previous(term)
    with open(pidfile(term), "w") as f:
        f.write(str(os.getpid()))
    transcript = Transcript(transcript_path)
    start = time.time()
    try:
        # Override Claude's done/idle with `working` while background work
        # remains. While Claude reports working/blocked/error itself (a new
        # turn, a permission prompt, or background agents it already counts),
        # leave its status alone and keep watching. A later Stop hook starts
        # a fresh watcher and stops this one.
        ours = None  # msg of the status we wrote, while it is shown
        while time.time() - start < MAX_LIFE:
            if not alive(claude_pid):
                return
            st, _ = hc_state(term)
            state = (st or {}).get("state")
            if ours and not is_ours(st, ours):
                log(term, "claude reported %s" % state)
                ours = None
            shells, _, agents, mcp = work(claude_pid, term, transcript)
            if shells + agents + len(mcp) == 0:
                if ours:
                    end = time.time() + GRACE
                    while time.time() < end:
                        time.sleep(0.5)
                        if not is_ours(hc_state(term)[0], ours):
                            log(term, "work ended; claude took over")
                            return
                    emit(tty, "done")
                    log(term, "work ended; reported done")
                else:
                    log(term, "work ended")
                return
            msg = describe(shells, agents, mcp)
            if (ours and msg != ours) or (not ours and state in ("done", "idle")):
                emit(tty, "working", msg)
                log(term, "working: " + msg)
                ours = msg
            # React fast right after the turn ends, then poll slowly.
            time.sleep(0.5 if time.time() - start < 10 else POLL)
    finally:
        try:
            if open(pidfile(term)).read().strip() == str(os.getpid()):
                os.remove(pidfile(term))
        except OSError:
            pass


def hook():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (OSError, ValueError):
        payload = {}
    term = os.environ.get("HC_TERMINAL_ID")
    if not term:
        log("-", "stop: not in a herdr terminal")
        return
    if os.environ.get("HERDR_BG_STATUS") == "0":
        return
    claude_pid = find_claude_pid()
    if not claude_pid:
        log(term, "stop: claude process not found (ppid %d)" % os.getppid())
        return
    tty = tty_of(claude_pid)
    if not tty:
        log(term, "stop: claude pid %d has no tty" % claude_pid)
        return
    transcript_path = payload.get("transcript_path") if isinstance(payload, dict) else None
    transcript_path = transcript_path if isinstance(transcript_path, str) else ""
    shells, servers, agents, mcp = work(claude_pid, term, Transcript(transcript_path))
    if shells + agents + len(mcp) == 0:
        log(term, "stop: no background work" + (" (%d server shell(s) ignored)" % servers if servers else ""))
        return
    log(term, "stop with %s; starting watcher" % describe(shells, agents, mcp))
    subprocess.Popen([sys.executable, SCRIPT, "watch", str(claude_pid), tty, term, transcript_path],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def main():
    if len(sys.argv) in (5, 6) and sys.argv[1] == "watch":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        watch(int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) == 6 else "")
    else:
        hook()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break the Stop hook
        log(os.environ.get("HC_TERMINAL_ID", "?"), "error: %r" % (e,))
