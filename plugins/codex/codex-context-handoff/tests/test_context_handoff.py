import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "hooks" / "context_handoff.py"
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
        ), patch.dict(handoff.os.environ, {"CODEX_CONTEXT_HANDOFF_THRESHOLD": "40"}):
            first = handoff.stop_hook(payload, self.root, "t1")
            second = handoff.stop_hook(payload, self.root, "t1")
        self.assertEqual(first["decision"], "block")
        self.assertEqual(second, {})

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


if __name__ == "__main__":
    unittest.main()
