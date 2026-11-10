---
name: handoff-now
description: Record a hand-off now and continue the work from the notes in a new session (or after a reset, as configured)
disable-model-invocation: true
---

[context-handoff] A hand-off was asked for with /handoff-now. Do not start new work. Record a hand-off for a fresh start: if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. Cover what was done this session, the current state, measured facts worth not measuring again, open questions, and the exact next step. If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.

When the notes are written, open the session that continues the work: call mcp__ccd_session__start_session once (load it with ToolSearch first if it is deferred) with initiation "user_asked", context "fresh", use_worktree false, a title naming the work (under 60 characters), a background of at least 80 characters (the goal, the decisions so far, and which file holds the notes), and as prompt: "This session takes over work from another session whose context filled up. Read this project's hand-off notes: the progress file CLAUDE.md names, else PROGRESS.md, else HANDOFF.md at the project root. Say in one line what you are picking up, then continue from the recorded next step without redoing work the notes mark as done. If the notes hold a question for the user, ask it and wait." Then stop with one line telling the user the work continues in that session. If the call is refused, do not retry it; just stop.
