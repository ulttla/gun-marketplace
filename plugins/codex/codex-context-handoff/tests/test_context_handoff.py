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


class ContextHandoffTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.transcript = self.root / "transcript.jsonl"

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
            "id": "first", "usage": None, "complete": True,
        })

    def test_prior_turn_is_not_a_source_of_current_usage(self):
        self.write_events(
            event("task_started", turn_id="first"),
            event("token_count", info=usage(80)),
            event("task_complete", turn_id="first"),
            event("task_started", turn_id="second"),
        )
        self.assertEqual(handoff.recent_turn(self.transcript), {
            "id": "second", "usage": None, "complete": False,
        })

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
        info = {"status": {"app": "codex", "state": "idle"}, "foreground": {"pid": 1}}

        def sleep(_):
            self.control("handoff off")

        with patch.object(handoff, "hc", side_effect=lambda *a: calls.append(a) or {}), (
            patch.object(handoff, "await_old_chat", return_value="› ")
        ), patch.object(handoff, "terminal_info", return_value=info), (
            patch.object(handoff, "read_composer", return_value="› ")
        ), patch.object(handoff.time, "sleep", side_effect=sleep), (
            patch.dict(os.environ, {"CODEX_CONTEXT_HANDOFF_GRACE": "30"})
        ):
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                handoff.switch_chat(state)
        self.assertFalse(any(call[0] == "keys" for call in calls))

    def test_user_input_during_grace_fails_closed(self):
        state = handoff.store_for(self.root, "session", "turn")
        state.parent.mkdir()
        record = {"terminal": "t1", "cwd": str(self.root), "pid": 1}
        info = {"status": {"app": "codex", "state": "idle"}}
        with patch.object(handoff, "terminal_info", return_value=info), (
            patch.object(handoff, "read_composer", side_effect=["› ", None])
        ), patch.object(handoff.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                handoff.hold_for_cancel(record, state, "› ", 30)

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

    def test_fresh_chat_can_finish_startup_before_receiving_prompt(self):
        record = {"terminal": "t1", "cwd": str(self.root), "pid": 123}
        statuses = [
            {"status": {"app": "codex", "state": "working"}},
            {"status": {"app": "codex", "state": "idle"}},
        ]
        with patch.object(handoff, "terminal_info", side_effect=statuses), (
            patch.object(handoff, "read_composer", return_value="› Ask Codex to do anything")
        ), patch.object(handoff.time, "sleep"):
            handoff.await_fresh_chat(record, "old screen")

    def test_resume_requires_new_chat_and_is_acknowledged_once(self):
        state = handoff.store_for(self.root, "old", "turn")
        state.parent.mkdir()
        nonce = "a" * 24
        state.write_text(json.dumps({"nonce": nonce, "terminal": "t1", "cwd": str(self.root)}))
        state.with_suffix(".md").write_text("Work remains.\n")
        payload = {
            "session_id": "old", "turn_id": "other", "cwd": str(self.root),
            "prompt": f"Codex Context Handoff: old turn {nonce} Read the handoff.",
        }
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1")["decision"], "block")
        payload["session_id"] = "fresh"
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1"), {})
        self.assertEqual(state.with_suffix(".received").read_text(), "fresh\n")
        self.assertTrue((self.root / "fresh" / "other.skip").is_file())
        self.assertEqual(handoff.prompt_hook(payload, self.root, "t1")["decision"], "block")


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
