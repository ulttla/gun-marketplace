import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[1]
SCRIPT = PLUGIN / "hooks" / "context_handoff.py"
SHIM = PLUGIN / "bin" / "codex"
SPEC = importlib.util.spec_from_file_location("context_handoff", SCRIPT)
handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handoff)


def usage(tokens):
    return {
        "last_token_usage": {"total_tokens": tokens},
        "total_token_usage": {"total_tokens": 1000},
        "model_context_window": 100,
    }


def event(kind, **fields):
    return {"type": "event_msg", "payload": {"type": kind, **fields}}


OLD = "› fix the bug\n• Fixed most of it.\n\n› Ask Codex to do anything\n\n  gpt · ~/work\n  ? for shortcuts"
FRESH = "  >_ OpenAI Codex (v0.167.2)\n\n› Ask Codex to do anything\n\n  gpt · ~/work\n  ? for shortcuts"
REPLIED = "› hello\n• Hi.\n\n› Ask Codex to do anything\n\n  gpt · ~/work\n  ? for shortcuts"


def draft(screen, text):
    return screen.replace("› Ask Codex to do anything", f"› {text}")


class FakeClock:
    def __init__(self):
        self.now, self.actions = 1000.0, []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        for action in [a for a in self.actions if a[0] <= self.now]:
            self.actions.remove(action)
            action[1]()

    def at(self, seconds, action):
        self.actions.append((self.now + seconds, action))


class FakeTerminal:
    """Herdr's view of one Codex: `before` until /clear, then (seconds after /clear, status, turn, screen)."""

    def __init__(self, clock, before, after=()):
        self.clock, self.before, self.after = clock, before, list(after)
        self.cleared = None

    def clear(self):
        self.cleared = self.clock.now

    def phase(self):
        if self.cleared is None:
            return self.before
        elapsed = self.clock.now - self.cleared
        return [p[1:] for p in self.after if p[0] <= elapsed][-1]

    def since(self):
        status, since = self.before[0], 0
        if self.cleared is not None:
            for start, phase_status, *_ in self.after:
                if start > self.clock.now - self.cleared:
                    break
                if phase_status != status:
                    status, since = phase_status, int((self.cleared + start) * 1000)
        return since

    def info(self, *_):
        status, turn, _ = self.phase()
        if status == "gone":
            return None
        return {"status": {"app": "codex", "state": status}, "turn": turn, "status_ms": self.since(),
                "foreground": {"pid": 123}}

    def screen(self, _):
        return self.phase()[2]


class ContextHandoffTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.transcript = self.root / "transcript.jsonl"
        self.db = self.root / "goals_1.sqlite"  # absent unless a test creates it: no Goal
        environment = patch.dict(os.environ, {"CODEX_HANDOFF_GOALS_DB": str(self.db)})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("CODEX_CONTEXT_HANDOFF_GOAL", None)
        self.logs = []
        logger = patch.object(handoff, "log", side_effect=self.logs.append)
        logger.start()
        self.addCleanup(logger.stop)

    def write_events(self, *events):
        self.transcript.write_text("".join(json.dumps(row) + "\n" for row in events))

    @property
    def meta(self):
        if not hasattr(self, "_meta"):
            self._meta = {"type": "session_meta", "payload": {
                "source": "cli", "thread_source": "user", "id": "session", "session_id": "session",
            }}
        return self._meta

    def payload(self, **fields):
        return {"session_id": "session", "turn_id": "turn", "cwd": str(self.root),
                "transcript_path": str(self.transcript), **fields}

    def eligible(self, foreground=True):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(handoff, "terminal_info", return_value={"foreground": {"pid": 123}}))
        stack.enter_context(patch.object(handoff, "in_foreground_tree", return_value=foreground))
        stack.enter_context(patch.dict(os.environ, {
            "CODEX_CONTEXT_HANDOFF": "1", "CODEX_CONTEXT_HANDOFF_THRESHOLD": "40",
        }))
        return stack

    def control(self, prompt, terminal="t1"):
        return handoff.control_hook(dict(self.payload(), prompt=prompt), self.root, terminal)

    def test_threshold_is_strict_and_uses_last_request(self):
        self.assertFalse(handoff.exceeds_threshold(usage(40), 40))
        self.assertTrue(handoff.exceeds_threshold(usage(41), 40))
        self.assertFalse(handoff.exceeds_threshold({"total_token_usage": {"total_tokens": 1000}}, 40))

    def test_compaction_discards_stale_usage(self):
        self.write_events(
            event("task_started", turn_id="first"),
            event("token_count", info=usage(80)),
            {"type": "compacted", "payload": {}},
            event("task_complete", turn_id="first"),
        )
        self.assertEqual(handoff.recent_turn(self.transcript), {
            "id": "first", "usage": None, "complete": True, "trigger": None,
        })

    def test_prior_turn_is_not_a_source_of_current_usage(self):
        self.write_events(
            event("task_started", turn_id="first"),
            event("token_count", info=usage(80)),
            event("task_complete", turn_id="first"),
            event("task_started", turn_id="second"),
        )
        self.assertEqual(handoff.recent_turn(self.transcript), {
            "id": "second", "usage": None, "complete": False, "trigger": None,
        })

    def test_long_turn_starting_before_the_tail_window_is_still_found(self):
        # Parent session 01a1ce32: a 1-hour turn grew past the 4 MB tail, so Stop saw no turn and never armed.
        filler = event("item_completed", item={"text": "x" * 1000})
        self.write_events(self.meta, event("task_started", turn_id="long"), *([filler] * 60),
                          event("token_count", info=usage(41)))
        with patch.object(handoff, "TRANSCRIPT_TAIL", 10_000):
            latest = handoff.recent_turn(self.transcript)
            self.assertEqual((latest["id"], latest["usage"]["last_token_usage"]["total_tokens"]), ("long", 41))
            with self.eligible():
                self.assertEqual(handoff.stop_hook(self.payload(turn_id="long"), self.root, "t1")["decision"], "block")
        self.write_events(self.meta, *([filler] * 60))
        with patch.object(handoff, "TRANSCRIPT_TAIL", 10_000):
            self.assertIsNone(handoff.recent_turn(self.transcript))  # whole file read, no turn

    def test_stop_requests_one_continuation_per_turn(self):
        self.write_events(
            {"type": "session_meta", "payload": {
                "source": "cli", "thread_source": "user", "id": "session", "session_id": "session",
            }},
            event("task_started", turn_id="turn"), event("token_count", info=usage(41)),
        )
        payload = {
            "session_id": "session", "turn_id": "turn", "cwd": str(self.root),
            "transcript_path": str(self.transcript),
        }
        with patch.object(handoff, "terminal_info", return_value={"foreground": {"pid": 123}}), (
            patch.object(handoff, "in_foreground_tree", return_value=True)
        ), patch.dict(handoff.os.environ, {
            "CODEX_CONTEXT_HANDOFF_THRESHOLD": "40", "CODEX_CONTEXT_HANDOFF": "1",
        }):
            first = handoff.stop_hook(payload, self.root, "t1")
            second = handoff.stop_hook(payload, self.root, "t1")
        self.assertEqual(first["decision"], "block")
        self.assertEqual(second, {})

    def test_stop_coexists_with_another_stop_hook(self):
        # Another plugin's Stop hook already continued this turn; ours still checks once.
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)))
        payload = self.payload(stop_hook_active=True)
        with self.eligible():
            first = handoff.stop_hook(payload, self.root, "t1")
        self.assertEqual(first["decision"], "block")
        nonce = json.loads(handoff.store_for(self.root, "session", "turn").read_text())["nonce"]
        payload["last_assistant_message"] = f"HANDOFF READY {nonce}\n# Note\nNext: tests."
        with patch.object(handoff.subprocess, "Popen") as launch, self.eligible():
            second = handoff.stop_hook(payload, self.root, "t1")
            third = handoff.stop_hook(payload, self.root, "t1")
        self.assertIn("handoff off", second["systemMessage"])
        self.assertEqual(third, {})
        launch.assert_called_once()
        self.assertEqual((self.root / "session" / "turn.md").read_text(), "# Note\nNext: tests.\n")

    def test_off_before_threshold_blocks_request_and_nudge(self):
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)))
        self.assertEqual(self.control("handoff off")["decision"], "block")
        with self.eligible():
            self.assertEqual(handoff.stop_hook(self.payload(), self.root, "t1"), {})
            self.assertEqual(handoff.tool_hook(self.payload(), self.root, "t1"), {})
        self.assertFalse((self.root / "session" / "turn").exists())

    def test_off_after_armed_cancels_capture(self):
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)))
        with self.eligible():
            handoff.stop_hook(self.payload(), self.root, "t1")
        reply = self.control("handoff cancel")["reason"]
        self.assertIn("Cancelled 1", reply)
        state = handoff.store_for(self.root, "session", "turn")
        self.assertTrue(state.with_suffix(".cancelled").is_file())
        self.control("handoff on")  # re-enabling does not revive the cancelled handoff
        nonce = json.loads(state.read_text())["nonce"]
        with patch.object(handoff.subprocess, "Popen") as launch:
            result = handoff.capture({"last_assistant_message": f"HANDOFF READY {nonce}\nNote"}, state)
        self.assertEqual(result, {})
        launch.assert_not_called()

    def test_off_during_grace_stops_before_clear(self):
        state = handoff.store_for(self.root, "session", "turn")
        state.parent.mkdir()
        record = {"session": "session", "turn": "turn", "terminal": "t1", "cwd": str(self.root),
                  "pid": 1, "transcript": str(self.transcript), "nonce": "a" * 24}
        state.write_text(json.dumps(record))
        state.with_suffix(".md").write_text("note\n")
        calls = []
        info = {"status": {"app": "codex", "state": "idle"}, "turn": 3, "foreground": {"pid": 1}}

        def sleep(_):
            self.control("handoff off")

        with patch.object(handoff, "hc", side_effect=lambda *a: calls.append(a) or {}), (
            patch.object(handoff, "await_old_chat", return_value=("› ", 3))
        ), patch.object(handoff, "terminal_info", return_value=info), (
            patch.object(handoff, "read_composer", return_value="› ")
        ), patch.object(handoff.time, "sleep", side_effect=sleep), (
            patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GRACE": "30"})
        ):
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                handoff.switch_chat(state)
        self.assertFalse(any(call[0] == "keys" for call in calls))
        self.assertIn("cancelled", state.with_suffix(".closed").read_text())
        self.assertFalse((self.root / "t1.switch").exists())

    def test_user_input_during_grace_fails_closed(self):
        state = handoff.store_for(self.root, "session", "turn")
        state.parent.mkdir()
        record = {"terminal": "t1", "cwd": str(self.root), "pid": 1}
        info = {"status": {"app": "codex", "state": "idle"}, "turn": 3}
        with patch.object(handoff, "terminal_info", return_value=info), (
            patch.object(handoff, "read_composer", side_effect=["› ", None])
        ), patch.object(handoff.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                handoff.hold_for_cancel(record, state, "› ", 30, 3)

    def test_herdr_turn_moving_during_grace_fails_closed(self):
        # A busy period that began and ended between two polls still moves Herdr's turn.
        state = handoff.store_for(self.root, "session", "turn")
        state.parent.mkdir()
        record = {"terminal": "t1", "cwd": str(self.root), "pid": 1}
        infos = [{"status": {"app": "codex", "state": "idle"}, "turn": t} for t in (3, 3, 4)]
        with patch.object(handoff, "terminal_info", side_effect=infos), (
            patch.object(handoff, "read_composer", return_value="› ")
        ), patch.object(handoff.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                handoff.hold_for_cancel(record, state, "› ", 30, 3)

    def test_grace_is_bounded(self):
        for value, expected in (("2.5", 2.5), ("0", 0.0), ("61", 10.0), ("nan", 10.0), ("x", 10.0)):
            with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GRACE": value}):
                self.assertEqual(handoff.grace(), expected)

    def test_status_and_on_report_requested_and_operational_state(self):
        self.write_events(self.meta, event("token_count", info=usage(23)))
        with self.eligible():
            status = self.control("handoff status")
        self.assertEqual(status["decision"], "block")
        self.assertIn("Requested for this chat: on.", status["reason"])
        self.assertIn("Operational: yes (threshold 40%, last request used 23.0%).", status["reason"])
        self.control("handoff off")
        with self.eligible():
            on = self.control("handoff on")["reason"]
        self.assertIn("Requested for this chat: on.", on)
        self.assertFalse((self.root / "session" / ".off").exists())
        self.assertEqual(sorted(p.name for p in (self.root / "session").iterdir()), [])

    def test_status_without_opt_in_says_restart_is_needed(self):
        with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF": ""}), patch.object(handoff, "hc") as hc:
            reason = self.control("핸드오프 상태", terminal="t2w")["reason"]
        self.assertIn("Operational: no;", reason)
        self.assertIn("codex resume session", reason)
        hc.assert_not_called()

    def test_control_matching_is_exact(self):
        for prompt in ('"handoff off"', "please handoff off", "handoff off now", "`handoff status`", "handoff"):
            self.assertIsNone(self.control(prompt), prompt)
        self.assertIsNotNone(self.control("  Handoff   STATUS \n"))

    def test_nudge_adds_context_once_per_turn(self):
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)))
        with self.eligible():
            first = handoff.tool_hook(self.payload(), self.root, "t1")
            second = handoff.tool_hook(self.payload(), self.root, "t1")
        self.assertEqual(set(first), {"hookSpecificOutput"})
        self.assertEqual(first["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertIn("safe", first["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(second, {})

    def test_nudge_waits_for_threshold(self):
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(40)))
        with self.eligible():
            self.assertEqual(handoff.tool_hook(self.payload(), self.root, "t1"), {})

    def test_closing_prompt_skips_only_its_turn(self):
        handoff.mark_closing({"session_id": "session", "turn_id": "turn", "prompt": "Wrap up."}, self.root)
        self.assertTrue(handoff.disabled(self.root, "session", "turn"))
        self.assertFalse(handoff.disabled(self.root, "session", "next"))

    def test_vscode_source_needs_the_foreground_process_guard(self):
        self.meta["payload"]["source"] = "vscode"
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)))
        self.assertTrue(handoff.is_interactive_root(self.transcript, "session"))
        with self.eligible(foreground=False):
            self.assertEqual(handoff.stop_hook(self.payload(), self.root, "t1"), {})
        with self.eligible():
            self.assertEqual(handoff.stop_hook(self.payload(), self.root, "t1")["decision"], "block")

    def test_interactive_root_refuses_non_cli_and_subagent_threads(self):
        meta = {"source": "exec", "thread_source": "user", "id": "session", "session_id": "session"}
        self.write_events({"type": "session_meta", "payload": meta})
        self.assertFalse(handoff.is_interactive_root(self.transcript, "session"))
        meta.update(source="cli", id="subagent")
        self.write_events({"type": "session_meta", "payload": meta})
        self.assertFalse(handoff.is_interactive_root(self.transcript, "session"))

    def test_worker_status_accepts_herdr_list_shapes(self):
        workers = [
            {"address": "t2", "parent": "t1", "state": "live", "status": "working"},
            {"address": "t3", "parent": "t1", "state": "live", "status": {"state": "done"}},
            {"address": "t4", "parent": "t9", "state": "live", "status": "working"},
        ]
        with patch.object(handoff, "hc", return_value={"terminals": workers}):
            self.assertEqual(handoff.worker_status("t1"), "- t2 (working)\n- t3 (done)")

    def test_composer_refuses_a_draft(self):
        screen = "› Ask Codex to do anything\n\n› My unsent draft\n  model"
        with patch.object(handoff, "hc", return_value={"complete": True, "text": screen}):
            self.assertIsNone(handoff.read_composer("t1"))

    def test_completed_work_does_not_create_a_note(self):
        state = handoff.store_for(self.root, "old", "turn")
        state.parent.mkdir()
        state.write_text(json.dumps({"nonce": "a" * 24}))
        with patch.object(handoff.subprocess, "Popen") as launch:
            handoff.capture({"last_assistant_message": "The work is complete."}, state)
        self.assertFalse(state.with_suffix(".md").exists())
        launch.assert_not_called()

    # --- /clear startup: the fresh chat may report working while MCP servers start ---

    def armed(self, session="session", evidence=True):
        """A captured handoff with its note, its takeover guard and the source transcript."""
        self.write_events(self.meta, event("task_started", turn_id="turn"), event("token_count", info=usage(41)),
                          event("task_complete", turn_id="turn"))
        state = handoff.store_for(self.root, session, "turn")
        state.parent.mkdir(exist_ok=True)
        record = {"session": session, "turn": "turn", "cwd": str(self.root), "terminal": "t1", "pid": 123,
                  "transcript": str(self.transcript), "nonce": "a" * 24}
        state.write_text(json.dumps(record))
        state.with_suffix(".md").write_text("note\n")
        handoff.arm_guard(state, record)
        if evidence:
            (state.parent / ".prompt-hook").write_text("123\n")
        return state, record

    def faked(self, clock, terminal):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(handoff.time, "monotonic", clock.monotonic))
        stack.enter_context(patch.object(handoff.time, "sleep", clock.sleep))
        stack.enter_context(patch.object(handoff, "terminal_info", terminal.info))
        stack.enter_context(patch.object(handoff, "read_screen", terminal.screen))
        return stack

    def fresh_wait(self, *after, evidence=True, setup=None):
        """Run the post-/clear wait against phases (seconds after /clear, status, turn, screen)."""
        state, record = self.armed(evidence=evidence)
        self.clock = FakeClock()
        terminal = FakeTerminal(self.clock, ("done", 5, OLD), after)
        terminal.clear()
        if setup:
            setup(state, record)
        with self.faked(self.clock, terminal):
            return handoff.await_fresh_chat(record, state, OLD, 5, {})

    @property
    def waited(self):
        return self.clock.now - 1000.0

    def test_slow_startup_after_clear_is_waited_out(self):
        # Codex 0.167.2 reports working with only the fresh, empty prompt on screen while MCP starts.
        settled = self.fresh_wait((0, "working", 5, FRESH), (20, "idle", 6, FRESH))
        self.assertEqual(settled[0], 6)
        self.assertEqual(settled[2], FRESH)
        self.assertGreaterEqual(self.waited, 20 + handoff.SETTLE)
        self.assertLess(self.waited, 21 + handoff.SETTLE)
        self.assertIn("+0.0s after /clear: status working, Herdr turn 5, prompt fresh", self.logs)

    def test_startup_wait_is_bounded(self):
        with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_STARTUP_WAIT": "30"}):
            with self.assertRaisesRegex(RuntimeError, "within 30s"):
                self.fresh_wait((0, "working", 5, FRESH))
        self.assertAlmostEqual(self.waited, 30, delta=0.5)
        for value, expected in (("12", 12.0), ("600", 600.0), ("11", 150.0), ("601", 150.0), ("x", 150.0)):
            with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_STARTUP_WAIT": value}):
                self.assertEqual(handoff.startup_wait(), expected)

    def test_long_startup_needs_prompt_hook_evidence(self):
        # Without proof that the takeover hook runs in this Codex, keep the old 12 s bound.
        with self.assertRaisesRegex(RuntimeError, "within 12s"):
            self.fresh_wait((0, "working", 5, FRESH), (20, "idle", 6, FRESH), evidence=False)
        self.assertAlmostEqual(self.waited, 12, delta=0.5)
        self.assertEqual(self.fresh_wait((0, "working", 5, FRESH), (5, "idle", 6, FRESH), evidence=False)[0], 6)
        # Evidence from an earlier Codex process (before a resume) does not count.
        stale = lambda state, record: (state.parent / ".prompt-hook").write_text("999\n")
        with self.assertRaisesRegex(RuntimeError, "within 12s"):
            self.fresh_wait((0, "working", 5, FRESH), (20, "idle", 6, FRESH), setup=stale)

    def test_draft_typed_and_cleared_during_startup_aborts(self):
        with self.assertRaisesRegex(RuntimeError, "Text appeared in the composer"):
            self.fresh_wait((0, "working", 5, FRESH), (5, "working", 5, draft(FRESH, "hel")),
                            (6, "working", 5, FRESH), (20, "idle", 6, FRESH))
        self.assertAlmostEqual(self.waited, 5, delta=0.3)

    def test_multiline_and_newline_drafts_are_not_an_empty_prompt(self):
        newline = "  >_ OpenAI Codex\n\n›\n  hello\n  ? for shortcuts"
        multiline = "  >_ OpenAI Codex\n\n› first\n  second\n  ? for shortcuts"
        bare = "  >_ OpenAI Codex\n\n›\n\n  gpt · ~/work\n  ? for shortcuts"
        self.assertEqual(handoff.composer_text(newline), "hello")
        self.assertEqual(handoff.composer_text(multiline), "first\nsecond")
        self.assertEqual(handoff.prompt_state(bare, OLD), "no placeholder")
        self.assertEqual(handoff.prompt_state(draft(FRESH, "a\n  b\n  c"), OLD), "no prompt in the footer")
        with patch.object(handoff, "hc", return_value={"complete": True, "text": newline}):
            self.assertIsNone(handoff.read_composer("t1"))
        for screen in (newline, bare):
            with self.assertRaises(RuntimeError):
                self.fresh_wait((0, "working", 5, FRESH), (4, "working", 5, screen), (20, "idle", 6, FRESH))

    def test_prompt_submitted_during_startup_stops_the_switch(self):
        # Codex queues it until startup ends; the UserPromptSubmit hook marks the takeover.
        def submit(state, record):
            self.clock.at(8, lambda: handoff.mark_takeover(
                {"session_id": "fresh", "prompt": "hello"}, self.root, "t1"))
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.fresh_wait((0, "working", 5, FRESH), setup=submit)
        self.assertAlmostEqual(self.waited, 8, delta=0.3)

    def test_turn_finished_before_idle_is_rejected_even_without_the_hook(self):
        with self.assertRaisesRegex(RuntimeError, "ran something besides its startup"):
            self.fresh_wait((0, "working", 5, FRESH), (10, "done", 6, REPLIED), (11, "idle", 6, REPLIED))
        with self.assertRaisesRegex(RuntimeError, "No fresh, empty prompt"):
            self.fresh_wait((0, "working", 5, FRESH), (10, "idle", 6, REPLIED))

    def test_second_busy_period_after_startup_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "ran something besides its startup"):
            self.fresh_wait((0, "working", 5, FRESH), (15, "idle", 6, FRESH), (16, "working", 6, FRESH))
        self.assertAlmostEqual(self.waited, 16, delta=0.3)

    def test_dialog_or_error_during_startup_aborts(self):
        for status in ("blocked", "error"):
            with self.assertRaisesRegex(RuntimeError, f"reported {status}"):
                self.fresh_wait((0, "working", 5, FRESH), (4, status, 5, FRESH))

    def test_clear_echo_is_tolerated_only_until_codex_redraws(self):
        settled = self.fresh_wait((0, "done", 5, OLD), (0.4, "done", 5, draft(OLD, "/clear")),
                                  (0.8, "working", 5, FRESH), (6, "idle", 6, FRESH))
        self.assertEqual(settled[0], 6)
        # Once the fresh prompt was seen, the old chat's status or screen may not come back.
        with self.assertRaisesRegex(RuntimeError, "reported done"):
            self.fresh_wait((0, "working", 5, FRESH), (1, "done", 5, OLD))
        self.assertAlmostEqual(self.waited, 1, delta=0.3)
        with self.assertRaisesRegex(RuntimeError, "Text appeared in the composer"):
            self.fresh_wait((0, "idle", 5, draft(OLD, "/clear")))
        self.assertAlmostEqual(self.waited, handoff.CLEAR_ECHO, delta=0.3)

    def test_first_fresh_poll_is_checked_strictly(self):
        # The echo window closes as soon as the fresh prompt shows, on that very poll.
        for status in ("done", None):
            with self.assertRaisesRegex(RuntimeError, f"reported {status}"):
                self.fresh_wait((0, status, 5, FRESH))
            self.assertLess(self.waited, 0.1)
        # During the echo window only the old screen or the typed /clear may show.
        for screen in (draft(OLD, "a\n  b\n  c"), None):
            with self.assertRaisesRegex(RuntimeError, "No fresh, empty prompt"):
                self.fresh_wait((0, "done", 5, screen))
            self.assertLess(self.waited, 0.1)

    def test_blank_frame_right_after_clear_is_tolerated_briefly(self):
        # Codex 0.167.2 can render a blank frame between the old chat and the fresh welcome (live QA).
        blank = "\n\n   \n"
        settled = self.fresh_wait((0, "idle", 5, blank), (0.4, "working", 5, FRESH), (20.4, "idle", 6, FRESH))
        self.assertEqual(settled[0], 6)
        self.assertIn("+0.0s after /clear: status idle, Herdr turn 5, prompt blank", self.logs)
        # A blank screen that persists, or comes back after the fresh prompt, is not tolerated.
        with self.assertRaisesRegex(RuntimeError, r"No fresh, empty prompt after /clear \(blank\)"):
            self.fresh_wait((0, "idle", 5, blank))
        self.assertAlmostEqual(self.waited, handoff.CLEAR_ECHO, delta=0.3)
        with self.assertRaisesRegex(RuntimeError, r"\(blank\)"):
            self.fresh_wait((0, "working", 5, FRESH), (1, "working", 5, blank))
        self.assertAlmostEqual(self.waited, 1, delta=0.3)
        # A footer-less screen with content is still rejected at once.
        with self.assertRaisesRegex(RuntimeError, "no prompt in the footer"):
            self.fresh_wait((0, "idle", 5, "  >_ OpenAI Codex\n\n  loading"))
        self.assertLess(self.waited, 0.1)

    def test_switch_survives_a_blank_frame_and_a_slow_startup(self):
        state = self.run_switch([(0, "idle", 5, "\n"), (0.4, "working", 5, FRESH), (20, "idle", 6, FRESH)])
        self.assertEqual(len(self.sent), 1)
        self.assertGreaterEqual(self.sent[0][0] - self.cleared_at, 20 + handoff.SETTLE)
        self.assertEqual(state.with_suffix(".received").read_text(), "fresh\n")

    def test_turn_counter_may_not_go_backwards(self):
        with self.assertRaisesRegex(RuntimeError, "ran something besides its startup"):
            self.fresh_wait((0, "idle", 4, FRESH))

    def test_control_prompt_also_records_prompt_hook_evidence(self):
        # A resumed chat whose first prompt is `handoff status` primes the guard for its new process.
        import io
        self.write_events(self.meta, event("token_count", info=usage(23)))
        payload = {"hook_event_name": "UserPromptSubmit", "prompt": "handoff status", **self.payload()}
        env = {"PLUGIN_DATA": str(self.root), "HC_TERMINAL_ID": "t1"}
        with self.eligible(), patch.dict(os.environ, env), patch.object(handoff, "note_prompt_hook") as note, (
            patch.object(handoff.sys, "stdin", io.StringIO(json.dumps(payload)))
        ), patch.object(handoff.sys, "argv", ["hook"]), patch("builtins.print") as output:
            handoff.main()
        note.assert_called_once()
        self.assertEqual(json.loads(output.call_args[0][0])["decision"], "block")

    def test_old_chat_starting_another_turn_aborts(self):
        def append():
            with self.transcript.open("a") as stream:
                stream.write(json.dumps(event("task_started", turn_id="x")) + "\n")

        def later(state, record):
            self.clock.at(5, append)
        with self.assertRaisesRegex(RuntimeError, "old chat started another turn"):
            self.fresh_wait((0, "working", 5, FRESH), setup=later)

    def test_missing_or_foreign_guard_fails_closed(self):
        drop = lambda state, record: handoff.guard_path(state, record).unlink()
        with self.assertRaisesRegex(RuntimeError, "takeover guard"):
            self.fresh_wait((0, "idle", 5, FRESH), setup=drop)
        other = lambda state, record: handoff.guard_path(state, record).write_text("other turn " + "b" * 24)
        with self.assertRaisesRegex(RuntimeError, "takeover guard"):
            self.fresh_wait((0, "idle", 5, FRESH), setup=other)

    def test_settling_needs_an_unchanged_screen_and_status_time(self):
        moved = FRESH.replace("~/work", "~/other")
        phases = [(t, "idle", 5, FRESH if t % 3 == 0 else moved) for t in range(0, 40, 1)]
        with self.assertRaisesRegex(RuntimeError, "within 12s"):
            self.fresh_wait(*phases, evidence=False)
        with patch.object(FakeTerminal, "since", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "status time"):
                self.fresh_wait((0, "idle", 5, FRESH))

    # --- the whole switch, with a scripted terminal ---

    def run_switch(self, after, keys=None, around=None):
        state, record = self.armed()
        self.clock = FakeClock()
        terminal = FakeTerminal(self.clock, ("done", 5, OLD), after)
        self.sent, self.cleared_at = [], None

        def fake_hc(*args):
            if args[0] == "ls":
                return {"terminals": [{"address": "t2", "parent": "t1", "state": "live", "status": "working"}]}
            if args[0] == "keys":
                terminal.clear()
                self.cleared_at = self.clock.now
                return keys or {"turn": 5, "status": "done"}
            if args[0] == "send":
                self.assertEqual(terminal.phase()[0], "idle")
                self.sent.append((self.clock.now, args[-1]))
                payload = {"session_id": "fresh", "turn_id": "first", "cwd": str(self.root), "prompt": args[-1]}
                self.assertIsNone(handoff.mark_takeover(payload, self.root, "t1"))
                self.assertEqual(handoff.prompt_hook(payload, self.root, "t1"), {})
                return {"started": True, "status": "idle", "turn": 6}
            raise AssertionError(args)

        with self.faked(self.clock, terminal), patch.object(handoff, "hc", side_effect=fake_hc):
            if around:
                original = handoff.await_fresh_chat
                with patch.object(handoff, "await_fresh_chat", side_effect=lambda *a: around(original(*a), state)):
                    handoff.switch_chat(state)
            else:
                handoff.switch_chat(state)
        return state

    def test_switch_waits_out_a_slow_startup_and_sends_once(self):
        state = self.run_switch([(0, "working", 5, FRESH), (20, "idle", 6, FRESH)])
        self.assertEqual(len(self.sent), 1)
        self.assertGreaterEqual(self.sent[0][0] - self.cleared_at, 20 + handoff.SETTLE)
        self.assertEqual(self.sent[0][1], handoff.continuation(json.loads(state.read_text()), state))
        self.assertEqual(state.with_suffix(".received").read_text(), "fresh\n")
        self.assertFalse(state.with_suffix(".closed").exists())
        self.assertFalse((self.root / "t1.switch").exists())
        self.assertIn("- t2 (working)", state.with_suffix(".md").read_text())
        self.assertTrue(any("settled" in line for line in self.logs))

    def test_takeover_just_before_the_send_stops_it(self):
        def submit(settled, state):
            handoff.mark_takeover({"session_id": "fresh", "prompt": "hello"}, self.root, "t1")
            return settled
        with self.assertRaisesRegex(RuntimeError, "just before the continuation"):
            self.run_switch([(0, "idle", 5, FRESH)], around=submit)
        self.assertEqual(self.sent, [])
        state = handoff.store_for(self.root, "session", "turn")
        self.assertIn("just before the continuation", state.with_suffix(".closed").read_text())
        self.assertFalse((self.root / "t1.switch").exists())

    def test_terminal_change_while_clear_is_typed_aborts(self):
        for keys in ({"turn": 6, "status": "done"}, {"turn": 5, "status": "working"}):
            with self.assertRaisesRegex(RuntimeError, "while /clear was typed"):
                self.run_switch([(0, "idle", 5, FRESH)], keys=keys)
            self.assertEqual(self.sent, [])
            handoff.store_for(self.root, "session", "turn").with_suffix(".closed").unlink()

    def test_lost_lock_race_leaves_the_active_switch_guard(self):
        import fcntl
        active, active_record = self.armed(session="active")
        later = handoff.store_for(self.root, "later", "turn")
        later.parent.mkdir()
        later_record = dict(active_record, session="later", nonce="b" * 24)
        later.write_text(json.dumps(later_record))
        with patch.object(handoff.subprocess, "Popen"):
            handoff.capture({"last_assistant_message": f"HANDOFF READY {'b' * 24}\nNote"}, later)
        self.assertTrue(handoff.guard_armed(active, active_record))  # capture did not take it over
        with open(self.root / "t1.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaisesRegex(RuntimeError, "Another handoff"):
                handoff.switch_chat(later)
        self.assertTrue(handoff.guard_armed(active, active_record))
        self.assertTrue(later.with_suffix(".closed").is_file())

    # --- the destination's UserPromptSubmit hook decides at acceptance time ---

    def test_destination_blocks_a_continuation_after_takeover_or_close(self):
        state, record = self.armed()
        payload = {"session_id": "fresh", "turn_id": "first", "cwd": str(self.root),
                   "prompt": handoff.continuation(record, state)}
        for marker, words in ((".cancelled", "cancelled"), (".closed", "stopped")):
            state.with_suffix(marker).write_text("x\n")
            result = handoff.prompt_hook(payload, self.root, "t1")
            self.assertEqual(result["decision"], "block")
            self.assertIn(words, result["reason"])
            self.assertFalse(state.with_suffix(".received").exists())
            state.with_suffix(marker).unlink()
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1"), {})

    def test_continuation_mixed_with_other_text_is_never_run(self):
        for mixed in ("hello{}", "{} and also delete the branch", "draft\n{}"):
            state, record = self.armed()
            for suffix in (".cancelled", ".received"):
                state.with_suffix(suffix).unlink(missing_ok=True)
            payload = {"session_id": "fresh", "turn_id": "first", "cwd": str(self.root),
                       "prompt": mixed.format(handoff.continuation(record, state))}
            self.assertIsNotNone(handoff.mark_takeover(payload, self.root, "t1"))
            result = handoff.prompt_hook(payload, self.root, "t1")
            self.assertEqual(result["decision"], "block")
            self.assertIn("mixed with other text", result["reason"])
            self.assertTrue(state.with_suffix(".cancelled").is_file())
            self.assertFalse(state.with_suffix(".received").exists())

    def test_takeover_spares_only_the_exact_continuation(self):
        state, record = self.armed()
        exact = {"session_id": "fresh", "prompt": handoff.continuation(record, state) + "\n"}
        self.assertIsNone(handoff.mark_takeover(exact, self.root, "t1"))
        self.assertIsNone(handoff.mark_takeover({"prompt": "hello"}, self.root, "t2"))  # another terminal
        self.assertFalse(state.with_suffix(".cancelled").exists())
        notice = handoff.mark_takeover({"session_id": "fresh", "prompt": "handoff status"}, self.root, "t1")
        self.assertIn("stopped", notice)
        self.assertIn("fresh", state.with_suffix(".cancelled").read_text())
        state.with_suffix(".cancelled").unlink()
        state.with_suffix(".received").write_text("fresh\n")  # already delivered: nothing to stop
        self.assertIsNone(handoff.mark_takeover({"prompt": "hello"}, self.root, "t1"))

    def test_user_prompt_then_queued_continuation_through_the_hook_entry_point(self):
        state, record = self.armed()
        env = dict(os.environ, PLUGIN_DATA=str(self.root), HC_TERMINAL_ID="t1", CODEX_CONTEXT_HANDOFF="1")

        def submit(prompt):
            payload = {"hook_event_name": "UserPromptSubmit", "session_id": "fresh", "turn_id": "first",
                       "cwd": str(self.root), "transcript_path": str(self.transcript), "prompt": prompt}
            done = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(payload), env=env,
                                  capture_output=True, text=True, timeout=20, check=True)
            return json.loads(done.stdout.splitlines()[0])

        self.assertIn("stopped", submit("hello")["systemMessage"])
        self.assertEqual(submit(handoff.continuation(record, state))["decision"], "block")
        self.assertFalse(state.with_suffix(".received").exists())

    def test_prompt_hook_evidence_names_the_verified_foreground_codex(self):
        state, record = self.armed(evidence=False)
        payload = {"session_id": "session", "cwd": str(self.root)}
        evidence = state.parent / ".prompt-hook"
        # (hook's own Codex, terminal's foreground Codex, recorded evidence)
        for own, foreground, expected in ((123, 123, "123"), (456, 456, "456"), (789, 456, "456")):
            with patch.object(handoff, "in_foreground_tree", side_effect=lambda pid: pid == own), (
                patch.object(handoff, "terminal_info", return_value={"foreground": {"pid": foreground}})
            ):
                handoff.note_prompt_hook(payload, self.root, "t1")
            self.assertEqual(evidence.read_text(), expected + "\n")
        self.assertFalse(handoff.prompt_hook_evidence(state, record))  # resumed in pid 456
        self.assertTrue(handoff.prompt_hook_evidence(state, dict(record, pid=456)))
        with patch.object(handoff, "in_foreground_tree", return_value=True), (
            patch.object(handoff, "terminal_info")
        ) as info:
            handoff.note_prompt_hook(payload, self.root, "t1")  # still valid: no Herdr call
        info.assert_not_called()

    def test_resume_requires_new_chat_and_is_acknowledged_once(self):
        state, record = self.armed(session="old")
        payload = {
            "session_id": "old", "turn_id": "other", "cwd": str(self.root),
            "prompt": handoff.continuation(record, state) + "\n",
        }
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1")["decision"], "block")
        payload["session_id"] = "fresh"
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1"), {})
        self.assertEqual(state.with_suffix(".received").read_text(), "fresh\n")
        self.assertTrue((self.root / "fresh" / "other.skip").is_file())
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1")["decision"], "block")


OBJECTIVE = 'Complete CloudSight W0–W4; keep "Build" data'
CREATED_MS = 1794458641123
PAUSED_MS = 1794463238456


def goal_line(status, used, updated, thread="session", objective=OBJECTIVE, created=CREATED_MS // 1000,
              budget=None, seconds=4597):
    # The exact shape Codex 0.167.2 prints for get_goal/update_goal in code mode (CloudSight rollout);
    # tokenBudget is left out when the Goal has none.
    goal = {"threadId": thread, "objective": objective, "status": status}
    if budget is not None:
        goal["tokenBudget"] = budget
    goal.update(tokensUsed=used, timeUsedSeconds=seconds, createdAt=created, updatedAt=updated)
    return json.dumps({"goal": goal, "remainingTokens": None, "completionBudgetReport": None},
                      ensure_ascii=False, separators=(",", ":"))


def response(**payload):
    return {"type": "response_item", "payload": payload}


def exec_call(call, code):
    return response(type="custom_tool_call", status="completed", call_id=call, name="exec", input=code)


def exec_output(call, *texts):
    return response(type="custom_tool_call_output", call_id=call, output=[
        {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
        *({"type": "input_text", "text": text} for text in texts),
    ])


def hook_prompt(*texts, ident="msg"):
    """Our Stop request as Codex records it, possibly combined with another plugin's."""
    return [
        response(type="message", id=ident, role="user", content=[{"type": "input_text", "text": "".join(
            f'<hook_prompt hook_run_id="stop:{n}:/x/hooks.json">{text}</hook_prompt>' for n, text in enumerate(texts)
        )}]),
        event("item_completed", item={"type": "HookPrompt", "id": ident, "fragments": [
            {"text": text, "hookRunId": f"stop:{n}:/x/hooks.json"} for n, text in enumerate(texts)
        ]}),
    ]


def steer(text="<hc>worker done</hc>"):
    return event("item_completed", item={"type": "UserMessage", "id": "u", "content": [{"type": "text", "text": text}]})


class GoalTransferTests(unittest.TestCase):
    setUp = ContextHandoffTests.setUp
    eligible = ContextHandoffTests.eligible
    payload = ContextHandoffTests.payload
    control = ContextHandoffTests.control
    meta = ContextHandoffTests.meta
    write_events = ContextHandoffTests.write_events

    def set_goal(self, thread="session", **fields):
        import sqlite3
        row = {"goal_id": "g", "objective": OBJECTIVE, "status": "active", "token_budget": None,
               "tokens_used": 175150, "time_used_seconds": 1037, "created_at_ms": CREATED_MS,
               "updated_at_ms": CREATED_MS + 1000, **fields}
        with sqlite3.connect(self.db) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS thread_goals (thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, "
                "objective TEXT NOT NULL, status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL, "
                "time_used_seconds INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)"
            )
            db.execute("INSERT OR REPLACE INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)", (thread, *row.values()))
        db.close()

    def append(self, *rows):
        with self.transcript.open("a") as stream:
            stream.writelines(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)

    def consent(self):
        with patch.object(handoff, "check_chat", return_value=(None, "test")):
            self.control("handoff goal transfer on")

    def goal_turn(self, session="session", turn="turn", trigger="goal"):
        self.write_events(self.meta, {"type": "event_msg", "payload": {
            "type": "task_started", "turn_id": turn,
            "turn_attribution": {"turn_id": turn, "turn_trigger": trigger},
        }}, event("token_count", info=usage(41)))

    def arm(self, **goal):
        """An active Goal turn past the threshold whose Stop hook asked for the transfer."""
        self.set_goal(**goal)
        self.consent()
        self.goal_turn()
        with self.eligible():
            result = handoff.stop_hook(self.payload(), self.root, "t1")
        self.assertEqual(result["decision"], "block")
        self.state = handoff.store_for(self.root, "session", "turn")
        self.nonce = json.loads(self.state.read_text())["nonce"]
        return result["reason"]

    def pause(self, used=858236, budget=None, rows=None, **db):
        """The model's answer to the request: get_goal, update_goal paused, and the DB after it."""
        request = handoff.handoff_request(self.nonce)
        rows = rows if rows is not None else [
            exec_call("c1", 'text(await tools.get_goal({}));\ntext(await tools.update_goal({status:"paused"}));\n'),
            exec_output("c1", "Warning: truncated output (2 lines)\n" + goal_line(
                "active", used - 10, PAUSED_MS // 1000 - 5, budget=budget), goal_line("paused", used, PAUSED_MS // 1000, budget=budget)),
        ]
        self.append(*hook_prompt("[Gun Wiki closeout] Check this work.", request), *rows)
        self.set_goal(**{"status": "paused", "tokens_used": used, "updated_at_ms": PAUSED_MS,
                         "time_used_seconds": 4597, "token_budget": budget, **db})

    def capture(self, marker="GOAL transferred"):
        answer = {"last_assistant_message": f"HANDOFF READY {self.nonce} {marker}\n# Note\nNext: W2."}
        with patch.object(handoff.subprocess, "Popen") as launch, self.eligible():
            result = handoff.stop_hook(self.payload(**answer), self.root, "t1")
        return result, launch

    # --- consent and state ---

    def test_consent_controls_and_kill_switch(self):
        self.assertIsNone(handoff.goal_consent(self.root))
        with patch.object(handoff, "check_chat", return_value=(None, "test")):
            self.control("handoff on")
            self.assertIsNone(handoff.goal_consent(self.root))  # handoff on alone is not consent
            reply = self.control("handoff goal transfer on")["reason"]
            consent = json.loads((self.root / "goal-transfer.json").read_text())
            self.assertEqual((consent["enabled"], consent["chat"]), (True, "session"))
            self.assertEqual((self.root / "goal-transfer.json").stat().st_mode & 0o777, 0o600)
            self.assertIn(f"Goal transfer: on since {consent['since']}.", reply)
            self.control("핸드오프 목표 이전 켜기")  # already on: since is kept
            self.assertEqual(json.loads((self.root / "goal-transfer.json").read_text()), consent)
            with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GOAL": "off"}):
                self.assertIsNone(handoff.goal_consent(self.root))
                self.assertIn("(disabled by CODEX_CONTEXT_HANDOFF_GOAL)", self.control("handoff status")["reason"])
            with patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GOAL": "on"}):
                self.assertEqual(handoff.goal_consent(self.root), consent)
            self.assertIn("Goal transfer: off.", self.control("핸드오프 목표 이전 끄기")["reason"])
        self.assertFalse((self.root / "goal-transfer.json").exists())

    def test_goal_state_is_read_only_and_never_guesses(self):
        self.assertEqual(handoff.goal_state(self.transcript, "session"), ("none", None))
        status, why = handoff.goal_state(self.transcript, "session", "goal")
        self.assertEqual(status, "unknown")  # a Goal turn with no Goal row
        for goal_status in sorted(handoff.GOAL_STATUSES):
            self.set_goal(status=goal_status, token_budget=5)
            status, row = handoff.goal_state(self.transcript, "session")
            self.assertEqual((status, row["status"], row["token_budget"]), ("row", goal_status, 5))
        self.assertEqual(handoff.goal_state(self.transcript, "other"), ("none", None))
        before = self.db.stat().st_mtime_ns, sorted(p.name for p in self.root.iterdir())
        handoff.goal_state(self.transcript, "session")
        self.assertEqual((self.db.stat().st_mtime_ns, sorted(p.name for p in self.root.iterdir())), before)
        import sqlite3
        with sqlite3.connect(self.db) as db:
            db.execute("DROP TABLE thread_goals")
        db.close()
        self.assertEqual(handoff.goal_state(self.transcript, "session")[0], "unknown")
        self.db.write_bytes(b"not a database" * 100)
        self.assertEqual(handoff.goal_state(self.transcript, "session")[0], "unknown")
        # Without the test override the DB is found only from a Codex sessions path.
        with patch.dict(os.environ, {"CODEX_HANDOFF_GOALS_DB": ""}):
            rollout = Path("/h/.codex/sessions/2026/11/11/rollout-x.jsonl")
            self.assertEqual(handoff.goals_db(rollout), Path("/h/.codex/goals_1.sqlite"))
            self.assertIsNone(handoff.goals_db(self.transcript))
            self.assertEqual(handoff.goal_state(self.transcript, "session")[0], "unknown")

    # --- the source chat's Stop hook ---

    def test_active_goal_without_consent_waits_once(self):
        self.set_goal()
        self.goal_turn()
        with self.eligible():
            first = handoff.stop_hook(self.payload(), self.root, "t1")
            second = handoff.stop_hook(self.payload(turn_id="next"), self.root, "t1")
        self.assertIn("Goal transfer is not enabled", first["systemMessage"])
        self.assertEqual(second, {})
        self.assertFalse(handoff.store_for(self.root, "session", "turn").exists())
        # Turning transfer on afterwards lets this waiting chat try once.
        self.consent()
        self.goal_turn(turn="later")
        with self.eligible():
            reason = handoff.stop_hook(self.payload(turn_id="later"), self.root, "t1")["reason"]
            self.assertIn("GOAL TRANSFER", reason)
            self.goal_turn(turn="again")
            self.assertEqual(handoff.stop_hook(self.payload(turn_id="again"), self.root, "t1"), {})
        self.assertFalse(handoff.store_for(self.root, "session", "next").exists())  # nothing old resurrected

    def test_exhausted_budget_or_unknown_state_never_requests(self):
        self.consent()
        self.goal_turn()
        self.set_goal(token_budget=1000, tokens_used=1000)
        with self.eligible():
            self.assertIn("budget is exhausted", handoff.stop_hook(self.payload(), self.root, "t1")["systemMessage"])
        (self.root / "session" / ".goal-wait").unlink()
        self.db.write_bytes(b"garbage" * 100)
        with self.eligible():
            self.assertIn("could not read Goal state", handoff.stop_hook(self.payload(), self.root, "t1")["systemMessage"])
            self.assertEqual(handoff.stop_hook(self.payload(), self.root, "t1"), {})
        self.assertFalse(handoff.store_for(self.root, "session", "turn").exists())

    def test_active_goal_with_consent_gets_one_transfer_request_per_chat(self):
        reason = self.arm(token_budget=900000)
        self.assertIn("GOAL TRANSFER (authorized by the user's standing Goal transfer instruction", reason)
        self.assertIn(f"HANDOFF READY {self.nonce} GOAL transferred", reason)
        self.assertTrue(reason.startswith(handoff.handoff_request(self.nonce)))
        record = json.loads(self.state.read_text())
        self.assertEqual(record["goal"]["mode"], "transfer")
        self.assertEqual(record["goal"]["arm"]["objective_sha256"], handoff.digest(OBJECTIVE))
        self.goal_turn(turn="next")
        with self.eligible():
            self.assertEqual(handoff.stop_hook(self.payload(turn_id="next"), self.root, "t1"), {})

    def test_non_active_goal_is_left_alone(self):
        self.set_goal(status="paused")
        self.goal_turn(trigger="user")
        with self.eligible():
            reason = handoff.stop_hook(self.payload(), self.root, "t1")["reason"]
        self.assertIn("There is a Goal in this chat with status paused. Do not change it", reason)
        self.assertNotIn("GOAL TRANSFER", reason)
        self.state = handoff.store_for(self.root, "session", "turn")
        self.nonce = json.loads(self.state.read_text())["nonce"]
        self.append(*hook_prompt(handoff.handoff_request(self.nonce)))
        result, launch = self.capture(marker="GOAL left")
        launch.assert_called_once()
        self.assertFalse(self.state.with_suffix(".goal.json").exists())
        self.assertNotIn("Goal transfer", handoff.continuation(json.loads(self.state.read_text()), self.state))
        # A Goal that changed during the handoff turn stops it.
        for change in ({"status": "active"}, {"updated_at_ms": CREATED_MS + 5}, {"goal_id": "new"}, "create"):
            for path in self.root.joinpath("session").iterdir():
                path.unlink()
            self.set_goal(status="paused")
            self.goal_turn(trigger="user")
            with self.eligible():
                handoff.stop_hook(self.payload(), self.root, "t1")
            self.nonce = json.loads(self.state.read_text())["nonce"]
            self.append(*hook_prompt(handoff.handoff_request(self.nonce)))
            if change == "create":
                self.append(exec_call("c", "text(await tools.create_goal({objective:'x'}));"))
                change = {}
            self.set_goal(**{"status": "paused", **change})
            result, launch = self.capture(marker="GOAL left")
            launch.assert_not_called()
            self.assertIn("changed during the handoff", result["systemMessage"])
            self.assertIn("goal changed", self.state.with_suffix(".closed").read_text())

    def test_goal_turn_nudge_once_per_chat_and_only_with_consent(self):
        self.goal_turn()
        with self.eligible():
            self.assertEqual(handoff.tool_hook(self.payload(), self.root, "t1"), {})  # no consent
            self.consent()
            first = handoff.tool_hook(self.payload(), self.root, "t1")
            self.goal_turn(turn="next")
            second = handoff.tool_hook(self.payload(turn_id="next"), self.root, "t1")
        self.assertIn("the Stop hook will handle the Goal transfer", first["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(second, {})
        self.goal_turn(turn="typed", trigger="user")  # a turn the user started keeps the per-turn nudge
        with self.eligible():
            self.assertIn("safe", handoff.tool_hook(self.payload(turn_id="typed"), self.root, "t1")
                          ["hookSpecificOutput"]["additionalContext"])

    # --- capture: rollout evidence and the DB, never the narrative ---

    def test_verified_transfer_writes_the_record_and_note_then_switches(self):
        self.arm(token_budget=1_000_000)
        self.pause(budget=1_000_000)
        result, launch = self.capture()
        launch.assert_called_once()
        self.assertIn("Goal is paused here and will be recreated", result["systemMessage"])
        moved = json.loads(self.state.with_suffix(".goal.json").read_text())
        self.assertEqual(moved, {
            "source_session": "session", "source_turn": "turn", "goal_id": "g", "objective": OBJECTIVE,
            "objective_sha256": handoff.digest(OBJECTIVE), "created_at_ms": CREATED_MS, "paused_at_ms": PAUSED_MS,
            "token_budget": 1_000_000, "tokens_used": 858236, "time_used_seconds": 4597, "remaining": 141764,
            "lineage": {"root_session": "session", "hops": 1, "total_tokens_used": 858236,
                        "total_time_used_seconds": 4597},
        })
        note = self.state.with_suffix(".md").read_text()
        self.assertTrue(note.startswith("# Note\nNext: W2.\n\n## Goal transfer"))
        self.assertIn(f"Objective (JSON string): {json.dumps(OBJECTIVE, ensure_ascii=False)}", note)
        self.assertIn('"token_budget": 141764', note)
        self.assertNotIn(".goal-wait", [p.name for p in (self.root / "session").iterdir()])

    def test_user_input_before_the_request_or_a_concurrent_hook_prompt_does_not_block(self):
        # Only what follows our request counts: a steer earlier in the turn was handled before the Goal was
        # armed, and another plugin's Stop request (a genuine HookPrompt) is not user input.
        self.arm()
        self.append(steer("keep going"))
        both = 'text(await tools.get_goal({}));text(await tools.update_goal({status:"paused"}));'
        self.pause(rows=[*hook_prompt("[Gun Wiki closeout] again", ident="gw"), exec_call("c", both), exec_output(
            "c", goal_line("active", 858000, 1), goal_line("paused", 858236, PAUSED_MS // 1000))])
        result, launch = self.capture()
        launch.assert_called_once()

    def test_direct_mode_tool_calls_are_evidence_too(self):
        self.arm()
        self.pause(rows=[
            response(type="function_call", name="get_goal", arguments="{}", call_id="a"),
            response(type="function_call_output", call_id="a", output=goal_line("active", 858000, PAUSED_MS // 1000 - 9)),
            response(type="function_call", name="update_goal", arguments='{"status":"paused"}', call_id="b"),
            response(type="function_call_output", call_id="b", output=goal_line("paused", 858236, PAUSED_MS // 1000)),
        ])
        result, launch = self.capture()
        launch.assert_called_once()
        self.assertIsNone(json.loads(self.state.with_suffix(".goal.json").read_text())["remaining"])
        self.assertIn("unbounded; omit it", self.state.with_suffix(".md").read_text())

    def test_unverified_transfers_fail_closed(self):
        get = 'text(await tools.get_goal({}));'
        both = get + 'text(await tools.update_goal({status:"paused"}));'
        line = lambda status, used, at, **f: goal_line(status, used, at, budget=2_000_000, **f)
        active, paused = line("active", 858000, 1), line("paused", 858236, PAUSED_MS // 1000)
        cases = {
            "model refused (DB still active)": (dict(status="active"), None, "active goal was not paused", "Work continues here"),
            "no active before paused": ({}, [exec_call("c", both), exec_output("c", paused)], "no active Goal", "paused but"),
            "other createdAt": ({}, [exec_call("c", both), exec_output("c", active, line(
                "paused", 858236, PAUSED_MS // 1000, created=1))], "not the Goal armed", "paused but"),
            "other objective": ({}, [exec_call("c", both), exec_output("c", active, line(
                "paused", 858236, PAUSED_MS // 1000, objective="x"))], "not the Goal armed", "paused but"),
            "DB tokens differ": (dict(tokens_used=858237), None, "does not match", "paused but"),
            "user steer": ({}, [steer(), exec_call("c", both), exec_output("c", active, paused)], "user input", "paused but"),
            "pause not from update_goal": ({}, [exec_call("c", get), exec_output("c", active, paused),
                                                exec_call("d", both), exec_output("d", paused)],
                                           "not printed by update_goal", "paused but"),
            "budget used up": (dict(token_budget=858236), None, "budget is exhausted", "paused but"),
            "/goal change by the user": ({}, [exec_call("c", both), exec_output("c", active, paused), response(
                type="message", role="user", content=[{"type": "input_text", "text":
                '<codex_internal_context source="user_goal">User set goal status: paused</codex_internal_context>'}])],
                "user input", "paused but"),
            "unpaired hook prompt text": ({}, [response(type="message", id="x", role="user", content=[
                {"type": "input_text", "text": "<hook_prompt>typed by a user</hook_prompt>"}]),
                exec_call("c", both), exec_output("c", active, paused)], "user input", "paused but"),
            "second update after the pause": ({}, [exec_call("c", both), exec_output("c", active, paused),
                exec_call("d", 'text(await tools.update_goal({status:"complete"}));'),
                exec_output("d", line("complete", 858236, PAUSED_MS // 1000))], "exactly as requested", "paused but"),
            "create_goal after the pause": ({}, [exec_call("c", both + "text(await tools.create_goal({objective:'x'}));"),
                exec_output("c", active, paused)], "exactly as requested", "paused but"),
            "printed budget differs": ({}, [exec_call("c", both), exec_output("c", active, goal_line(
                "paused", 858236, PAUSED_MS // 1000, budget=1))], "does not match", "paused but"),
            "printed time differs": ({}, [exec_call("c", both), exec_output("c", active, line(
                "paused", 858236, PAUSED_MS // 1000, seconds=1))], "does not match", "paused but"),
            "another Goal row (goal_id)": (dict(goal_id="other"), None, "does not match", "paused but"),
        }
        for name, (db, rows, closed, message) in cases.items():
            with self.subTest(name):
                for path in (self.root / "session").iterdir() if (self.root / "session").exists() else ():
                    path.unlink()
                db = dict(db)
                budget = db.pop("token_budget", 2_000_000)
                self.arm(token_budget=budget)
                self.pause(rows=rows, budget=budget, **db)
                result, launch = self.capture()
                launch.assert_not_called()
                self.assertIn(message, result["systemMessage"])
                self.assertIn(closed, self.state.with_suffix(".closed").read_text())
                self.assertTrue((self.root / "session" / ".goal-wait").is_file())
                self.assertFalse(self.state.with_suffix(".goal.json").exists())
                self.assertFalse(self.state.with_suffix(".md").exists())
        # DB unreadable at capture: still fails closed.
        for path in (self.root / "session").iterdir():
            path.unlink()
        self.arm()
        self.pause()
        self.db.write_bytes(b"garbage" * 100)
        result, launch = self.capture()
        launch.assert_not_called()
        self.assertIn("could not be read", result["systemMessage"])
        self.assertIn("goal state unknown", self.state.with_suffix(".closed").read_text())

    def test_a_failed_transfer_is_not_retried_in_the_same_chat(self):
        self.arm()
        self.pause(rows=[])  # the model did not pause
        self.set_goal(status="active")
        self.capture()
        self.consent()
        self.goal_turn(turn="next")
        with self.eligible():
            self.assertEqual(handoff.stop_hook(self.payload(turn_id="next"), self.root, "t1"), {})

    def test_missing_marker_after_a_transfer_request_fails_closed(self):
        self.arm()
        self.pause()
        with patch.object(handoff.subprocess, "Popen") as launch, self.eligible():
            result = handoff.stop_hook(self.payload(last_assistant_message="All done."), self.root, "t1")
        launch.assert_not_called()
        self.assertIn("Goal is paused but its transfer could not be verified", result["systemMessage"])
        self.assertTrue((self.root / "session" / ".goal-wait").is_file())

    # --- the fresh chat ---

    def deliver(self, destination="fresh", turn="first"):
        record = json.loads(self.state.read_text())
        payload = {"session_id": destination, "turn_id": turn, "cwd": str(self.root),
                   "transcript_path": str(self.transcript), "prompt": handoff.continuation(record, self.state)}
        self.assertIsNone(handoff.mark_takeover(payload, self.root, "t1"))
        return handoff.prompt_hook(payload, self.root, "t1"), payload

    def transferred(self, budget=1_000_000):
        self.arm(token_budget=budget)
        self.pause(budget=budget)
        self.capture()
        handoff.arm_guard(self.state, json.loads(self.state.read_text()))

    def test_continuation_carries_the_goal_and_the_fresh_chat_gets_exact_arguments(self):
        self.transferred()
        record = json.loads(self.state.read_text())
        text = handoff.continuation(record, self.state)
        self.assertTrue(text.endswith('call create_goal with exactly the objective and token_budget from the '
                                      'note\'s "Goal transfer" section and print its raw result.'))
        result, _ = self.deliver()
        context = result["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn(json.dumps({"objective": OBJECTIVE, "token_budget": 141764}, ensure_ascii=False), context)
        restore = json.loads((self.root / "fresh" / ".goal-restore").read_text())
        self.assertEqual((restore["objective"], restore["remaining"]), (OBJECTIVE, 141764))
        lineage = json.loads((self.root / "fresh" / ".goal-lineage.json").read_text())
        self.assertEqual((lineage["hops"], lineage["total_tokens_used"]), (1, 858236))
        self.assertTrue((self.root / "fresh" / "first.skip").is_file())

    def test_mixed_goal_continuation_is_still_refused(self):
        self.transferred()
        record = json.loads(self.state.read_text())
        payload = {"session_id": "fresh", "turn_id": "first", "cwd": str(self.root),
                   "prompt": "hi " + handoff.continuation(record, self.state)}
        self.assertIn("paused for this handoff", handoff.mark_takeover(payload, self.root, "t1"))
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1")["decision"], "block")
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())

    def fresh_stop(self, turn="first"):
        self.write_events(dict(self.meta, payload=dict(self.meta["payload"], id="fresh", session_id="fresh")),
                          event("task_started", turn_id=turn), event("token_count", info=usage(5)))
        with self.eligible():
            return handoff.stop_hook(self.payload(session_id="fresh", turn_id=turn), self.root, "t1")

    def test_destination_confirms_the_restore_even_in_its_skipped_turn(self):
        self.transferred()
        self.deliver()
        self.set_goal(thread="fresh", tokens_used=900, token_budget=141764, created_at_ms=PAUSED_MS + 9000)
        self.assertEqual(self.fresh_stop(), {})
        restored = json.loads((self.root / "fresh" / ".goal-restored").read_text())
        self.assertEqual(restored["created_at_ms"], PAUSED_MS + 9000)
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())

    def test_destination_reminds_once_then_reports(self):
        self.transferred()
        self.deliver()
        first = self.fresh_stop()
        self.assertEqual(first["decision"], "block")
        self.assertIn(json.dumps({"objective": OBJECTIVE, "token_budget": 141764}, ensure_ascii=False), first["reason"])
        self.assertIn("Goal not recreated", self.fresh_stop()["systemMessage"])
        self.assertTrue((self.root / "fresh" / ".goal-mismatch").is_file())
        self.assertEqual(self.fresh_stop(), {})  # no more automation
        shutil.rmtree(self.root / "fresh")
        (self.root / "fresh").mkdir()
        (self.root / "fresh" / ".goal-restore").write_text("{")
        self.assertIn("could not be read", self.fresh_stop()["systemMessage"])
        self.assertEqual(self.fresh_stop(), {})

    def test_destination_mismatch_is_reported_without_a_block(self):
        for fields, words in (({"token_budget": 141765}, "token_budget 141765"),
                              ({"token_budget": None}, "token_budget None"),
                              ({"objective": "other"}, "different objective")):
            for folder in ("session", "fresh"):
                shutil.rmtree(self.root / folder, ignore_errors=True)
            self.db.unlink(missing_ok=True)
            self.transferred()
            self.deliver()
            self.set_goal(thread="fresh", **{"token_budget": 141764, **fields})
            result = self.fresh_stop()
            self.assertNotIn("decision", result)
            self.assertIn(words, result["systemMessage"])

    def test_two_hops_chain_the_budget_and_sum_the_lineage(self):
        self.transferred(budget=1_000_000)
        self.deliver()
        self.set_goal(thread="fresh", tokens_used=0, token_budget=141764, created_at_ms=PAUSED_MS + 9000)
        self.fresh_stop()
        # The fresh chat's own Goal turn crosses the threshold and transfers again.
        hop = handoff.store_for(self.root, "fresh", "goal2")
        self.write_events(dict(self.meta, payload=dict(self.meta["payload"], id="fresh", session_id="fresh")),
                          {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "goal2",
                           "turn_attribution": {"turn_trigger": "goal"}}}, event("token_count", info=usage(41)))
        self.set_goal(thread="fresh", tokens_used=40000, token_budget=141764, created_at_ms=PAUSED_MS + 9000,
                      time_used_seconds=60)
        with self.eligible():
            handoff.stop_hook(self.payload(session_id="fresh", turn_id="goal2"), self.root, "t1")
        nonce = json.loads(hop.read_text())["nonce"]
        line = lambda status, used, at: goal_line(status, used, at, thread="fresh", created=(PAUSED_MS + 9000) // 1000,
                                                  budget=141764, seconds=70)
        self.append(*hook_prompt(handoff.handoff_request(nonce)), exec_call("c", 'text(await tools.get_goal({}));'
                    'text(await tools.update_goal({status:"paused"}));'),
                    exec_output("c", line("active", 41000, 5), line("paused", 41500, PAUSED_MS // 1000 + 50)))
        self.set_goal(thread="fresh", status="paused", tokens_used=41500, token_budget=141764,
                      created_at_ms=PAUSED_MS + 9000, updated_at_ms=PAUSED_MS + 50000, time_used_seconds=70)
        with patch.object(handoff.subprocess, "Popen") as launch, self.eligible():
            handoff.stop_hook(self.payload(session_id="fresh", turn_id="goal2",
                              last_assistant_message=f"HANDOFF READY {nonce}\nnote"), self.root, "t1")
        launch.assert_called_once()
        moved = json.loads(hop.with_suffix(".goal.json").read_text())
        self.assertEqual(moved["remaining"], 141764 - 41500)
        self.assertEqual(moved["lineage"], {"root_session": "session", "hops": 2, "total_tokens_used": 858236 + 41500,
                                            "total_time_used_seconds": 4597 + 70})

    def test_cancel_after_the_pause_leaves_the_goal_paused_and_says_so(self):
        self.transferred()
        notice = handoff.mark_takeover({"session_id": "session", "prompt": "wait"}, self.root, "t1")
        self.assertIn("The Goal of chat session was paused for this handoff and stays paused", notice)
        self.assertIn("stays paused", self.state.with_suffix(".cancelled").read_text())
        with patch.object(handoff, "check_chat", return_value=(None, "test")):
            status = self.control("handoff status")["reason"]
        self.assertIn("Goal paused for transfer at 2026-11-12T06:00:38Z (cancelled)", status)
        self.assertEqual(handoff.goal_state(self.transcript, "session")[1]["status"], "paused")  # never resumed
        result, _ = self.deliver()
        self.assertEqual(result["decision"], "block")
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())

    # --- consent withdrawn after the request, and the destination's priorities ---

    def revoke(self):
        with patch.object(handoff, "check_chat", return_value=(None, "test")):
            self.control("handoff goal transfer off")

    def test_consent_revoked_during_the_handoff_turn_fails_closed(self):
        for revoke in (self.revoke, lambda: os.environ.__setitem__("CODEX_CONTEXT_HANDOFF_GOAL", "off")):
            shutil.rmtree(self.root / "session", ignore_errors=True)
            os.environ.pop("CODEX_CONTEXT_HANDOFF_GOAL", None)
            self.arm()
            self.pause()
            revoke()
            result, launch = self.capture()
            os.environ.pop("CODEX_CONTEXT_HANDOFF_GOAL", None)
            launch.assert_not_called()
            self.assertIn("Goal is paused but its transfer could not be verified", result["systemMessage"])
            self.assertIn("Goal transfer was turned off", self.state.with_suffix(".closed").read_text())
            self.assertFalse(self.state.with_suffix(".goal.json").exists())

    def test_consent_revoked_during_grace_stops_before_clear(self):
        self.transferred()
        record = json.loads(self.state.read_text())
        calls = []
        info = {"status": {"app": "codex", "state": "idle"}, "turn": 3, "foreground": {"pid": 123}}
        with patch.object(handoff, "hc", side_effect=lambda *a: calls.append(a) or {}), (
            patch.object(handoff, "await_old_chat", return_value=("› ", 3))
        ), patch.object(handoff, "terminal_info", return_value=info), (
            patch.object(handoff, "read_composer", return_value="› ")
        ), patch.object(handoff.time, "sleep", side_effect=lambda _: self.revoke()), (
            patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GRACE": "30"})
        ):
            with self.assertRaisesRegex(RuntimeError, "Goal transfer was turned off before /clear"):
                handoff.switch_chat(self.state)
        self.assertFalse(any(call[0] == "keys" for call in calls))
        self.assertIn("stays paused", self.state.with_suffix(".closed").read_text())
        # The same check guards the wait after /clear and the final recheck before the continuation.
        handoff.arm_guard(self.state, record)
        self.assertEqual(handoff.fresh_chat_problem(None, self.state, record, OLD, 5, False, {}),
                         "Goal transfer was turned off")

    def test_fresh_chat_does_not_recreate_after_consent_is_revoked(self):
        self.transferred()
        self.revoke()
        result, _ = self.deliver()
        self.assertEqual(result["decision"], "block")
        self.assertIn("Goal transfer was turned off", result["reason"])
        self.assertIn("stays paused", result["reason"])
        self.assertFalse(self.state.with_suffix(".received").exists())
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())
        # Revoked after delivery: the restore check ends without a reminder.
        shutil.rmtree(self.root / "session")
        self.transferred()
        self.deliver()
        self.revoke()
        result = self.fresh_stop()
        self.assertNotIn("decision", result)
        self.assertIn("no longer checked", result["systemMessage"])
        self.assertEqual(self.fresh_stop(), {})

    def test_goal_finished_in_its_first_turn_counts_as_restored(self):
        for status, message in (("complete", None), ("budget_limited", None), ("blocked", "is now blocked"),
                                ("paused", "status paused")):
            for folder in ("session", "fresh"):
                shutil.rmtree(self.root / folder, ignore_errors=True)
            self.db.unlink(missing_ok=True)
            self.transferred()
            self.deliver()
            self.set_goal(thread="fresh", status=status, token_budget=141764)
            result = self.fresh_stop()
            self.assertNotIn("decision", result)
            if message:
                self.assertIn(message, result["systemMessage"])
            else:
                self.assertEqual(result, {})
            restored = (self.root / "fresh" / ".goal-restored")
            self.assertEqual(restored.is_file(), status != "paused", status)
            self.assertEqual(handoff.goal_state(self.transcript, "fresh")[1]["status"], status)  # untouched

    def prompt_in_fresh(self, prompt="new task please"):
        import io
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "fresh", "turn_id": "second",
                   "cwd": str(self.root), "transcript_path": str(self.transcript), "prompt": prompt}
        env = {"PLUGIN_DATA": str(self.root), "HC_TERMINAL_ID": "t1", "CODEX_CONTEXT_HANDOFF": "1"}
        with patch.dict(os.environ, env), patch.object(handoff, "note_prompt_hook"), (
            patch.object(handoff.sys, "stdin", io.StringIO(json.dumps(payload)))
        ), patch.object(handoff.sys, "argv", ["hook"]), patch("builtins.print") as output:
            handoff.main()
        return json.loads(output.call_args[0][0]) if output.called else None

    def test_a_prompt_before_the_goal_is_recreated_cancels_the_restore(self):
        self.transferred()
        self.deliver()
        result = self.prompt_in_fresh()
        self.assertIn("a prompt arrived before the transferred Goal was recreated", result["systemMessage"])
        self.assertIn("The Goal of chat session stays paused", result["systemMessage"])
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())
        self.assertEqual(self.fresh_stop(turn="second"), {})  # no reminder inside the new task
        self.assertEqual(self.prompt_in_fresh("another"), {})  # told once
        # A control prompt is a real prompt too, and its reply carries the notice.
        for folder in ("session", "fresh"):
            shutil.rmtree(self.root / folder)
        self.transferred()
        self.deliver()
        with patch.object(handoff, "check_chat", return_value=(None, "test")):
            self.assertIn("stays paused", self.prompt_in_fresh("handoff status")["reason"])

    def test_a_prompt_after_the_goal_was_recreated_keeps_it(self):
        self.transferred()
        self.deliver()
        self.set_goal(thread="fresh", token_budget=141764)
        self.assertEqual(self.prompt_in_fresh(), {})
        self.assertTrue((self.root / "fresh" / ".goal-restored").is_file())
        self.assertFalse((self.root / "fresh" / ".goal-restore").exists())

    def test_symlinked_data_directory_keeps_the_canonical_note_path(self):
        # An install under another marketplace key gets its own PLUGIN_DATA; the parent links it to the
        # existing one so a handoff armed by the old install is received by the new one.
        state, record = ContextHandoffTests.armed(self)
        alias = self.root.parent / (self.root.name + "-alias")
        alias.symlink_to(self.root)
        self.addCleanup(alias.unlink)
        canonical = self.root.resolve()
        state = handoff.store_for(canonical, "session", "turn")
        sent = handoff.continuation(record, state)  # what the old install's switch sends
        env = dict(os.environ, PLUGIN_DATA=str(alias), HC_TERMINAL_ID="t1", CODEX_CONTEXT_HANDOFF="1")
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "fresh", "turn_id": "first",
                   "cwd": str(self.root), "transcript_path": str(self.transcript), "prompt": sent}
        done = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(payload), env=env,
                              capture_output=True, text=True, timeout=20, check=True)
        self.assertEqual(json.loads(done.stdout.splitlines()[0]), {})
        self.assertEqual(state.with_suffix(".received").read_text(), "fresh\n")
        self.assertTrue((canonical / "fresh" / "first.skip").is_file())


FAKE_CODEX = """import json, os, sys
with open(os.environ["RECORD"], "w") as out:
    json.dump({"argv": sys.argv[1:], "optin": os.environ.get("CODEX_CONTEXT_HANDOFF")}, out)
"""


class LauncherTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        self.shim_dir, self.copy_dir, self.real_dir = base / "shim", base / "copy", base / "real"
        for path in (self.shim_dir, self.copy_dir, self.real_dir):
            path.mkdir()
        (self.shim_dir / "codex").symlink_to(SHIM)
        shutil.copy(SHIM, self.copy_dir / "codex")  # a copied shim must be skipped too
        real = self.real_dir / "codex"
        real.write_text(f"#!{sys.executable}\n{FAKE_CODEX}")
        real.chmod(0o755)
        self.record = base / "record.json"

    def launch(self, *args, **env):
        environment = {
            "PATH": os.pathsep.join(map(str, (self.shim_dir, self.copy_dir, self.real_dir))),
            "RECORD": str(self.record), "HC_TERMINAL_ID": "t1", **env,
        }
        subprocess.run([sys.executable, str(self.shim_dir / "codex"), *args], env=environment, check=True, timeout=20)
        return json.loads(self.record.read_text())

    def test_interactive_launches_get_no_daemon_and_opt_in(self):
        cases = [
            ((), ["--no-daemon"]),
            (("-m", "gpt-x", "-p", "work", "-s", "workspace-write", "fix it"),
             ["--no-daemon", "-m", "gpt-x", "-p", "work", "-s", "workspace-write", "fix it"]),
            (("-c", "model=\"o3\"", "resume", "--last"), ["-c", "model=\"o3\"", "resume", "--no-daemon", "--last"]),
            (("fork", "abc"), ["fork", "--no-daemon", "abc"]),
            (("-i", "a.png", "b.png", "describe"), ["--no-daemon", "-i", "a.png", "b.png", "describe"]),
            (("--", "exec"), ["--no-daemon", "--", "exec"]),
            (("--", "--help"), ["--no-daemon", "--", "--help"]),
            (("fix", "--no-daemon"), ["fix", "--no-daemon"]),
        ]
        for args, expected in cases:
            self.assertEqual(self.launch(*args), {"argv": expected, "optin": "1"}, args)

    def test_explicit_no_daemon_is_not_duplicated(self):
        self.assertEqual(self.launch("--no-daemon"), {"argv": ["--no-daemon"], "optin": "1"})
        self.assertEqual(self.launch("resume", "--no-daemon", "x"), {"argv": ["resume", "--no-daemon", "x"], "optin": "1"})
        # A top-level flag is kept and resume/fork still gets its own (clap accepts one per scope).
        self.assertEqual(
            self.launch("--no-daemon", "resume", "x"),
            {"argv": ["--no-daemon", "resume", "--no-daemon", "x"], "optin": "1"},
        )

    def test_other_modes_pass_through(self):
        for args in (
            ("exec", "hi"), ("review",), ("app-server",), ("plugin", "list"), ("agents",), ("--help",),
            ("--version",), ("resume", "--help"), ("--remote", "ws://h:1"), ("-m", "x", "e", "hi"),
            ("-i", "a.png", "exec"), ("fix it", "--remote", "unix://"), ("fix", "--version"),
            ("fork", "x", "--remote=ws://h:1"),
        ):
            self.assertEqual(self.launch(*args), {"argv": list(args), "optin": None}, args)

    def test_opt_out_and_outside_herdr_pass_through(self):
        self.assertEqual(self.launch("resume", CODEX_CONTEXT_HANDOFF="0"), {"argv": ["resume"], "optin": "0"})
        self.assertEqual(self.launch("fix", HC_TERMINAL_ID=""), {"argv": ["fix"], "optin": None})


if __name__ == "__main__":
    unittest.main()
