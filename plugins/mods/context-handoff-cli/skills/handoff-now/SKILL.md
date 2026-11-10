---
name: handoff-now
description: Record a hand-off now, then start a fresh session in this terminal (/clear) that continues the work from the notes
disable-model-invocation: true
---

[context-handoff-cli] A hand-off was asked for with /handoff-now. Do not start new work. Record a hand-off for a fresh start: if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. Cover what was done this session, the current state, measured facts worth not measuring again, open questions, and the exact next step. If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.

When the notes are written, stop with one line saying so: a fresh session then starts automatically in this terminal and continues from the notes. Do not run /clear yourself and do not open another session.
