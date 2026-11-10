// The mod's name, as toasts, log lines and the hand-off prompts carry it
const NAME = 'context-handoff'
// A tag every prompt this mod submits carries, so its own turn can be told apart
const MARK = '[context-handoff]'
// The store key that survives the desktop app's clear, which ends the process
const RESUME_KEY = 'pendingResume'
// How long the app gets to clear the conversation once the hand-off turn has ended
const CLEAR_WAIT_MS = 8000
// The app's tool that opens the session the work continues in
const START_TOOL = 'mcp__ccd_session__start_session'
// This plugin's /handoff-now skill, by its name bare or under the plugin's
const HANDOFF_SKILL = /(^|:)handoff-now$/
// Where a prompt the user sent comes from: typed, over Remote Control, or the desktop app's own
// composer, which drives the engine as an SDK host. The app opens a session only on such a turn
const USER_ORIGINS = ['composer', 'bridge', 'sdk']
// When the compaction is tried after the hand-off turn: it is refused while a turn still runs
const COMPACT_TRIES_MS = [300, 1000, 2000, 4000, 8000]
// How long the /compact command gets to compact the conversation where it stands in for the call
const COMPACT_COMMAND_WAIT_MS = 5 * 60 * 1000
// How long after the compaction the resume prompt is submitted
const RESUME_AFTER_COMPACT_MS = 1000
// What the summarizer is told when the conversation is compacted after a hand-off
const COMPACT_INSTRUCTIONS =
  'A hand-off for a fresh start was just recorded in the project notes. Keep only: where the notes are (file and section), ' +
  'the exact next step, and any question still waiting for the user. Leave out everything else; it is in the notes.'

// Where the hand-off stands:
//   idle        nothing in progress
//   armed       (session) past the threshold; the user's next message runs the hand-off
//   closing     the hand-off is asked for; waiting for its turn to run and finish
//   handing     (session) the hand-off turn has ended; finding the session it opened
//   clearing    (clear) the app was asked to clear; waiting for the conversation to end with it
//   compacting  (compact) the hand-off turn has ended; compacting the conversation
//   resuming    the conversation was reset; waiting to submit the resume prompt
let phase = 'idle'
// The hand-off prompt as submitted, and the id of the turn running it
let closeText = null
let closeTurnId = null
// What asks for the hand-off turn: a prompt this mod submits (`prompt`), found by its tag, or
// the turn the user starts (`user`: their next message, or /handoff-now), the next to start
let closeBy = null
// The main loop's turn running now, for /handoff-now expanded after its turn started
let currentTurnId = null
// (session) The sessions this one had started before the hand-off, to tell the new one apart
let linkedBefore = null
// The context percent at which the last hand-off began; the next waits for `step` more
let triggeredAt = null
// The fallback that submits the resume prompt when no SessionStart follows the clear
let resumeTimer = null
// Gives up when the app has not cleared the conversation soon after the hand-off turn ended
let clearWatchdog = null
// The compaction attempt waiting to run
let compactTimer = null
// How the conversation is being compacted: the engine's call, or the /compact command where
// the session has no such call (a headless one, as the desktop app runs)
let compactVia = null
// Gives up when the /compact command has not compacted the conversation in time
let compactWatchdog = null
// True while Remote Control is turned off for the clear, to be turned on again after the resume
let remoteControlPaused = false
// Whether the user's message waiting for its turn asks to end the session, and the main loop's
// turn that runs such a message: it carries no hand-off and starts none
let endAsked = false
let endTurnId = null
// /handoff-now set the hand-off up as it was submitted; the skill's text, where this mod reads
// it, is still to come
let handoffNowAsked = false
// What /handoff-off (false) or /handoff-on (true) said about the automatic hand-off for this
// session, over the `enabled` option; null until one is typed
let sessionAuto = null
// The last thing that happened, for /handoff-status
let lastOutcome = 'nothing yet'

// A number option, or its default when unset or out of range
function numberOf(value, fallback, min, max) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

// The settings, from the options plugin.json declares
function settingsOf(options) {
  return {
    enabled: options.enabled !== false,
    threshold: numberOf(options.threshold, 40, 1, 100),
    step: numberOf(options.retriggerStep, 5, 1, 100),
    reset: options.reset === 'clear' || options.reset === 'compact' ? options.reset : 'session',
    unpinOld: options.oldSession !== 'keep',
    compaction: options.compaction === 'call' || options.compaction === 'command' ? options.compaction : 'auto',
    closeCommand: String(options.closeCommand ?? 'session-close').trim().replace(/^\//, ''),
    closePrompt: String(options.closePrompt ?? '').trim(),
    resumePrompt: String(options.resumePrompt ?? '').trim(),
    pauseRemoteControl: options.pauseRemoteControl !== false,
    endPhrases: String(options.endPhrases ?? '세션 종료, session 종료, 세션 end, end session')
      .split(/[,\n]/)
      .map((phrase) => wordsOf(phrase))
      .filter((words) => words.length > 0),
  }
}

// Whether the hand-off starts on its own in this session: as /handoff-off or /handoff-on said,
// else as the option has it
function autoOn(cfg) {
  return sessionAuto ?? cfg.enabled
}

// A phrase's words, each looked for in the text on its own
function wordsOf(phrase) {
  return phrase.toLowerCase().split(/\s+/).filter(Boolean)
}

// Whether the lower-cased text holds the word. One in Latin letters stands on its own, an English
// ending allowed (end and ended, not send, weekend or endpoint); any other may sit inside a longer
// word, so 세션을 and 종료해 hold 세션 and 종료
function holds(text, word) {
  if (!/^[a-z0-9]+$/.test(word)) return text.includes(word)
  return new RegExp(`(?<![a-z0-9])${word}(?:s|ed|ing)?(?![a-z0-9])`).test(text)
}

// Whether the text asks to end the session: it holds all the words of one of the phrases, in any
// order and with anything between
function asksToEnd(cfg, text) {
  const plain = text.toLowerCase()
  return cfg.endPhrases.some((words) => words.every((word) => holds(plain, word)))
}

function fillIn(text, percent, cfg) {
  return text
    .replaceAll('{percent}', String(Math.round(percent)))
    .replaceAll('{threshold}', String(cfg.threshold))
}

// The prompt that records the hand-off: the project's own close skill when it has one,
// a custom prompt when configured, or the built-in instructions. It opens with why the
// hand-off is made, `why` being:
//   threshold  the threshold passed (a prompt of its own)
//   asked      /handoff-now asked for it, whatever the context holds
//   carry      the threshold passed, and the user's message it rides on goes to the new session
function closePromptFor(cfg, percent, hasClose, why = 'threshold') {
  const fill = `The context window is ${Math.round(percent)}% full`
  const carry = why === 'carry'
  const level =
    why === 'asked'
      ? `${fill}; a hand-off was asked for with /handoff-now.`
      : carry
        ? `${fill}, past the ${cfg.threshold}% hand-off threshold, so the user's message above is handed to a fresh session ` +
          'instead of being worked on here. Do not act on it.'
        : `${fill}, past the ${cfg.threshold}% hand-off threshold.`
  const pending = carry
    ? "In the notes, make the user's message above, quoted in full, the first item of the exact next step. " +
      'If the turn before it stopped to ask the user something, put that question in the notes too.'
    : 'If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.'
  // With a new session the turn ends by opening it; otherwise by stopping for the reset
  const then =
    cfg.reset === 'session'
      ? openSessionStep(cfg, carry)
      : 'When the notes are written, stop: the context is then reset automatically and the work continues from the notes.'
  if (cfg.closePrompt) {
    const custom = `${MARK} ${fillIn(cfg.closePrompt, percent, cfg)}`
    if (carry) return `${custom} ${level} ${pending} ${then}`
    return cfg.reset === 'session' ? `${custom} ${then}` : custom
  }
  // A prompt may not begin with a slash, so the skill is named for the model to invoke
  if (hasClose) {
    return (
      `${MARK} ${level} Run this project's /${cfg.closeCommand} skill now (invoke it with the Skill tool) to record the hand-off, ` +
      `and make the next starting point exact. ${pending} ${then}`
    )
  }
  return (
    `${MARK} ${level} Do not start new work. Record a hand-off for a fresh start: ` +
    "if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; " +
    'otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. ' +
    'Cover what was done this session, the current state, measured facts worth not measuring again, open questions, ' +
    `and the exact next step. ${pending} ${then}`
  )
}

// (session) The last step of the hand-off turn: open the session that continues the work, with
// the resume as its brief, and the user's message after it when the hand-off carries one. The app
// opens one only on a turn the user started (their message, or /handoff-now they typed); when it
// refuses, the turn just stops and the mod compacts this conversation instead.
function openSessionStep(cfg, carry = false) {
  const message = carry
    ? ", then a blank line, the line \"The user's latest message, sent to the old session and not answered there:\", " +
      "and the user's message above, word for word"
    : ''
  return (
    `When the notes are written, open the session that continues the work: call ${START_TOOL} once ` +
    '(load it with ToolSearch first if it is deferred) with initiation "user_asked", context "fresh", use_worktree false, ' +
    'a title naming the work (under 60 characters), a background of at least 80 characters ' +
    '(the goal, the decisions so far, and which file holds the notes), ' +
    `and as prompt the text inside <brief>, word for word${message}: <brief>${resumePromptFor(cfg, true)}</brief> ` +
    'Then stop with one line telling the user the work continues in that session. ' +
    'If the call is refused, do not retry it or propose a session instead; just stop, and the context is compacted here.'
  )
}

// Where the notes are read from and how the work picks up from them
const READ_NOTES =
  "Read this project's hand-off notes: the progress file CLAUDE.md names, else PROGRESS.md, else HANDOFF.md at the project root. " +
  'Say in one line what you are picking up, then continue from the recorded next step without redoing work the notes mark as done. ' +
  'If the notes hold a question for the user, ask it and wait.'

// The prompt that continues the work: as the brief of the session that takes it over, or after
// the reset in this conversation (a fallback of the new session included)
function resumePromptFor(cfg, brief = false) {
  if (brief) {
    return cfg.resumePrompt || `This session takes over work from another session whose context filled up. ${READ_NOTES}`
  }
  if (cfg.resumePrompt) return `${MARK} ${cfg.resumePrompt}`
  return `${MARK} The context was reset after a hand-off. ${READ_NOTES}`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// The text blocks of an MCP result, joined
function textOf(result) {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim()
}

// Whether the engine answered that this session has no compaction call: a headless (SDK)
// session, as the desktop app runs, where a compaction runs as a /compact prompt
function hasNoCompactCall(message) {
  return /headless|SDK|\/compact prompt/i.test(message)
}

// The sizes a compaction reports, for the transcript line
function sizesOf(result) {
  return typeof result?.tokensBefore === 'number' && typeof result?.tokensAfter === 'number'
    ? ` (${result.tokensBefore} to ${result.tokensAfter} tokens)`
    : ''
}

// Keep what happened: a dim line in the transcript, and the answer of /handoff-status
function note($, text) {
  lastOutcome = text
  $.ui.log(`${NAME}: ${text}`)
}

// How full the context window is, in percent; null before the first reading
async function readPercent($) {
  try {
    const { context } = await $.session.usage()
    if (typeof context.percent === 'number') return context.percent
    if (typeof context.tokens === 'number' && context.window > 0) return (context.tokens / context.window) * 100
  } catch {
    // Keep going without a reading
  }
  return null
}

// Whether the project offers the close command: listed as a command, or a skill folder of the project
async function hasCommand($, name) {
  if (!name) return false
  try {
    if ((await $.command.list()).some((command) => command.name === name)) return true
  } catch {
    // Not listable here; look at the folder
  }
  try {
    const root = await $.session.root()
    return await $.fs.exists(`${root}/.claude/skills/${name}/SKILL.md`)
  } catch {
    return false
  }
}

// One call on a desktop app server, by default the session one. Resolves to null when it
// succeeded, else to why not.
async function callApp($, tool, args, server = 'ccd_session_mgmt') {
  try {
    const result = await $.mcp.call(server, tool, args)
    return result.isError ? textOf(result) || 'no reason given' : null
  } catch (error) {
    return messageOf(error)
  }
}

// The desktop app's id of this session, which outlives the process; null outside the app
async function appSessionId($) {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (result.isError) return null
    const id = JSON.parse(textOf(result)).sessionId
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

// The ids of the sessions this session started, as the app lists them; [] when it cannot say
async function linkedSessions($) {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { linked: true, limit: 50 })
    if (result.isError) return []
    const rows = JSON.parse(textOf(result))
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.sessionId === 'string') : []
  } catch {
    return []
  }
}

// The session the hand-off turn opened: one this session started that was not there before.
// The list puts the most recent first.
async function sessionOpened($) {
  const self = await appSessionId($)
  const rows = await linkedSessions($)
  return (
    rows.find(
      (row) => !(linkedBefore ?? []).includes(row.sessionId) && (!self || !row.startedBy || row.startedBy === self),
    ) ?? null
  )
}

// Turn Remote Control on again after it was turned off for the clear
async function restoreRemoteControl($) {
  if (!remoteControlPaused) return
  remoteControlPaused = false
  const failed = await callApp($, 'set_remote_control', { session_id: 'self', enabled: true })
  note($, failed ? `Remote Control could not be turned on again: ${failed}` : 'Remote Control turned on again')
}

function cancelTimers() {
  if (resumeTimer) resumeTimer.cancel()
  if (clearWatchdog) clearWatchdog.cancel()
  if (compactTimer) compactTimer.cancel()
  if (compactWatchdog) compactWatchdog.cancel()
  resumeTimer = clearWatchdog = compactTimer = compactWatchdog = null
}

function forgetPendingResume($) {
  $.store.delete(RESUME_KEY).catch(() => {})
}

// Give up the hand-off in progress and say why; the next tries once the context grew by the step
function abandon($, reason) {
  phase = 'idle'
  closeText = null
  closeTurnId = null
  closeBy = null
  compactVia = null
  linkedBefore = null
  cancelTimers()
  forgetPendingResume($)
  note($, `gave up: ${reason}`)
  $.ui.toast(`${NAME}: ${reason}. /handoff-now retries.`, { timeoutMs: 8000 })
  void restoreRemoteControl($)
}

// The hand-off is asked for: its turn is awaited. With a new session, the sessions this one
// started so far are noted, to tell the one the hand-off turn opens apart
async function prepare($, cfg, by, percent) {
  phase = 'closing'
  closeTurnId = null
  closeText = null
  closeBy = by
  triggeredAt = percent
  cancelTimers()
  if (cfg.reset === 'session') linkedBefore = (await linkedSessions($)).map((row) => row.sessionId)
}

// The turn that runs the hand-off has started. With the clear, the app is asked now, so the
// conversation is cleared as this turn ends.
async function closeTurnStarted($, cfg, turnId) {
  closeTurnId = turnId
  note($, 'the hand-off turn is running')
  if (cfg.reset === 'clear') await requestClear($, cfg)
}

// (session) Past the threshold: the hand-off waits for the user's next message. The app opens
// a session only on a turn the user started, which a prompt of this mod's is not; so the
// instructions ride on that message, which the new session takes over unanswered
function arm($, percent) {
  phase = 'armed'
  triggeredAt = percent
  note($, `context at ${Math.round(percent)}%: your next message goes to a new session, after the hand-off`)
  $.ui.toast(
    `${NAME}: context at ${Math.round(percent)}%, your next message hands off to a new session (/handoff-off to stay here)`,
    { timeoutMs: 8000 },
  )
}

// /handoff-now, as it is submitted: the hand-off is set up here rather than where the skill's
// text is read (skill.prompt), since an organization's security default keeps that event from
// the plugins a person installs. The instructions as configured ride along as context; where
// they don't reach, the skill's own text holds the default ones. Its turn is the next to start
async function handOffNow($, cfg, e, next) {
  if (phase !== 'idle' && phase !== 'armed') {
    return { drop: `${NAME}: a hand-off is already in progress (${phase})` }
  }
  const was = { phase, triggeredAt }
  const percent = (await readPercent($)) ?? 0
  await prepare($, cfg, 'user', percent)
  handoffNowAsked = true
  note($, 'hand-off started: asked by /handoff-now')
  $.ui.toast(`${NAME}: asked by /handoff-now, recording the hand-off`)
  const instructions =
    `${MARK} These are the /handoff-now instructions for this session's settings; where the skill's text differs, ` +
    `follow these. ${closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand), 'asked')}`
  const out = await next({ ...e, context: [...(e.context ?? []), instructions] })
  // The command did not enter: the hand-off stands as it was
  if (out && out.drop !== undefined && phase === 'closing' && closeTurnId === null) {
    phase = was.phase
    triggeredAt = was.triggeredAt
    closeBy = null
    linkedBefore = null
    handoffNowAsked = false
  }
  return out
}

// Submit the hand-off prompt; its turn is found by the tag at turn.start
async function begin($, cfg, percent, why) {
  await prepare($, cfg, 'prompt', percent)
  const text = closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand))
  closeText = text
  note($, `hand-off started: ${why}`)
  $.ui.toast(`${NAME}: ${why}, recording the hand-off`)
  $.prompt
    .submit({ text, asUser: true })
    .then((result) => {
      if (result && result.drop && phase === 'closing' && closeText === text) {
        abandon($, `the hand-off prompt was refused: ${result.drop}`)
      }
    })
    .catch((error) => {
      if (phase === 'closing' && closeText === text) abandon($, `the hand-off prompt failed: ${messageOf(error)}`)
    })
}

// Ask the desktop app to clear this conversation once the running turn ends. The app keeps
// the request only while the turn runs and acts on it as the turn's result arrives, so it is
// made as the hand-off turn starts. A session started from another device (Remote Control)
// cannot be cleared, so Remote Control is turned off for it when allowed.
async function requestClear($, cfg) {
  phase = 'clearing'
  let refused = await callApp($, 'clear_session', { session_id: 'self' })
  if (refused && cfg.pauseRemoteControl && /remote control/i.test(refused)) {
    const failed = await callApp($, 'set_remote_control', { session_id: 'self', enabled: false })
    if (failed) {
      return abandon($, `the app refused to clear the context: ${refused}; Remote Control could not be turned off: ${failed}`)
    }
    remoteControlPaused = true
    note($, 'Remote Control turned off for the clear; it is turned on again after the resume')
    refused = await callApp($, 'clear_session', { session_id: 'self' })
  }
  if (refused) return abandon($, `the app refused to clear the context: ${refused}`)
  // The clear ends this process; the next one finds the resume to make in the store
  try {
    await $.store.set(RESUME_KEY, {
      appSessionId: await appSessionId($),
      cwd: await $.session.cwd(),
      askedAt: await $.clock.now(),
    })
  } catch (error) {
    note($, `the resume could not be stored for the next process: ${messageOf(error)}`)
  }
  note($, 'the app will clear the conversation when the hand-off turn ends')
}

// The hand-off turn has ended: the app clears the conversation now, or the hand-off is given up
function awaitClear($) {
  note($, 'hand-off recorded, waiting for the app to clear the conversation')
  $.ui.toast(`${NAME}: hand-off recorded, clearing the context`)
  if (clearWatchdog) clearWatchdog.cancel()
  clearWatchdog = $.clock.after(CLEAR_WAIT_MS, () => {
    clearWatchdog = null
    if (phase === 'clearing') {
      abandon($, `the app did not clear the conversation within ${CLEAR_WAIT_MS / 1000} s of the hand-off turn ending`)
    }
  })
}

// (session) The hand-off turn has ended: the session it opened carries the work on. That one is
// moved to top level, so it lives on by itself and this one is not woken each time its turns
// end, and this one is unpinned unless kept. With no session opened, this one is compacted.
async function handOver($, cfg) {
  phase = 'handing'
  const opened = await sessionOpened($)
  if (phase !== 'handing') return
  if (!opened) {
    note($, 'no session was opened to continue the work; compacting here instead')
    return startCompaction($, cfg)
  }
  const name = typeof opened.title === 'string' && opened.title ? opened.title : opened.sessionId
  const detachFailed = await callApp($, 'detach_session', { session_id: opened.sessionId })
  if (detachFailed) note($, `the new session stays under this one: ${detachFailed}`)
  if (cfg.unpinOld) {
    const unpinFailed = await callApp($, 'set_pinned', { session_id: 'self', pinned: false }, 'ccd_sidebar')
    if (unpinFailed) note($, `this session could not be unpinned: ${unpinFailed}`)
  }
  phase = 'idle'
  closeText = null
  closeTurnId = null
  closeBy = null
  linkedBefore = null
  note($, `the work continues in the session "${name}" (${opened.sessionId})`)
  $.ui.toast(`${NAME}: the work continues in "${name}"`, { timeoutMs: 8000 })
}

// The hand-off turn has ended: compact the conversation down to the notes, then resume.
// A compaction is refused while a turn still runs, so it is tried a few times. A session
// with no compaction call of its own (the desktop app's) compacts through /compact instead,
// as does one configured to.
function startCompaction($, cfg) {
  phase = 'compacting'
  compactVia = 'call'
  note($, 'hand-off recorded, compacting the conversation')
  $.ui.toast(`${NAME}: hand-off recorded, compacting the conversation`)
  const attempt = (i) => {
    compactTimer = $.clock.after(COMPACT_TRIES_MS[i], async () => {
      compactTimer = null
      if (phase !== 'compacting') return
      if (cfg.compaction === 'command') return compactByCommand($, cfg, 'compacting through /compact, as configured')
      let result
      try {
        result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      } catch (error) {
        const message = messageOf(error)
        if (cfg.compaction === 'auto' && hasNoCompactCall(message)) {
          return compactByCommand($, cfg, 'this session has no compaction call; compacting through /compact')
        }
        if (i + 1 < COMPACT_TRIES_MS.length) return attempt(i + 1)
        return abandon($, `the conversation could not be compacted: ${message}`)
      }
      if (result && result.skip) return abandon($, `the compaction was skipped: ${result.skip}`)
      compacted($, cfg, `compacted the conversation${sizesOf(result)}`, 0)
    })
  }
  attempt(0)
}

// Compact through the /compact command, queued as if typed, with the same instructions.
// The compaction is seen as it runs, by the session.compact hook; the command's own answer,
// which may come later or never, stands in when the hook saw nothing.
function compactByCommand($, cfg, why) {
  compactVia = 'command'
  note($, why)
  if (compactWatchdog) compactWatchdog.cancel()
  compactWatchdog = $.clock.after(COMPACT_COMMAND_WAIT_MS, () => {
    compactWatchdog = null
    if (phase === 'compacting') {
      abandon($, `the /compact command did not compact the conversation within ${COMPACT_COMMAND_WAIT_MS / 60000} min`)
    }
  })
  $.command
    .run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    .then(async (result) => {
      if (phase !== 'compacting') return
      // The hook saw no compaction: the context says whether the command made one
      const percent = await readPercent($)
      const answer = typeof result?.text === 'string' && result.text.trim() ? `: ${result.text.trim().slice(0, 160)}` : ''
      if (percent !== null && triggeredAt && percent >= triggeredAt) {
        return abandon($, `the /compact command ran, but the context is still at ${Math.round(percent)}%${answer}`)
      }
      compacted($, cfg, `the /compact command finished${percent === null ? '' : `, the context at ${Math.round(percent)}%`}`)
    })
    .catch((error) => {
      if (phase === 'compacting') abandon($, `the /compact command failed: ${messageOf(error)}`)
    })
}

// The conversation is compacted: the resume prompt follows, once. From the engine's call it
// follows at once (the call resolves between turns, the compaction installed); from /compact
// a moment later, as the hook sees the compaction while the command's turn still runs.
function compacted($, cfg, what, afterMs = RESUME_AFTER_COMPACT_MS) {
  if (phase !== 'compacting') return
  phase = 'resuming'
  cancelTimers()
  note($, what)
  if (afterMs === 0) submitResume($, cfg)
  else resumeTimer = $.clock.after(afterMs, () => submitResume($, cfg))
}

// Submit the resume prompt into the fresh conversation, once
function submitResume($, cfg) {
  if (phase !== 'resuming') return
  phase = 'idle'
  closeText = null
  closeTurnId = null
  closeBy = null
  triggeredAt = null
  compactVia = null
  cancelTimers()
  forgetPendingResume($)
  note($, 'continuing in a fresh context')
  $.ui.toast(`${NAME}: continuing in a fresh context`)
  $.prompt.submit({ text: resumePromptFor(cfg), asUser: true }).catch(() => {})
}

// A fresh process after the app's clear: when the store says this session's hand-off asked
// for a resume, and no prompt has run yet, continue from the notes. The app starts that process
// at the user's next message, however long after the clear, so the resume keeps until then
async function resumeIfPending($, cfg) {
  let pending
  try {
    pending = await $.store.get(RESUME_KEY)
  } catch {
    return
  }
  if (!pending || typeof pending !== 'object') return
  const forget = () => forgetPendingResume($)
  if ((await $.session.turns()) !== 0) return forget()
  const id = await appSessionId($)
  const isThisSession =
    id && pending.appSessionId ? id === pending.appSessionId : (await $.session.cwd()) === pending.cwd
  // Another session's hand-off: leave its resume to it
  if (!isThisSession) return
  forget()
  phase = 'resuming'
  note($, 'a fresh process after the clear; continuing from the notes')
  resumeTimer = $.clock.after(1000, () => submitResume($, cfg))
}

export function register(on, options) {
  const cfg = settingsOf(options)

  // Runs before your first prompt, and again after a reload. /handoff-now is this plugin's
  // skill (skills/handoff-now), so it runs in the turn the user typed it in
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff-status',
      description: 'Show where the automatic hand-off stands and what it did last',
    })
    await $.command.register({
      name: 'handoff-off',
      description: 'Turn the automatic hand-off off for this session; /handoff-now still hands off',
    })
    await $.command.register({
      name: 'handoff-on',
      description: 'Turn the automatic hand-off on again for this session',
    })
    await resumeIfPending($, cfg)
    return next(e)
  })

  // /handoff-now sets the hand-off up as it is submitted. (session) The user's next message after
  // the threshold carries the hand-off instructions, read by the model beside it. Not a command,
  // nor one typed over a running turn, nor one that asks to end the session, which leaves the
  // hand-off armed for the message after it
  on('prompt.submit', async ($, e, next) => {
    const text = typeof e.text === 'string' ? e.text : ''
    const fromUser = USER_ORIGINS.includes(e.origin?.kind)
    if (fromUser && e.command !== undefined && HANDOFF_SKILL.test(e.command.name)) return handOffNow($, cfg, e, next)
    if (!fromUser || e.turnId !== undefined || text.trimStart().startsWith('/')) return next(e)
    endAsked = asksToEnd(cfg, text)
    if (phase !== 'armed') return next(e)
    if (endAsked) {
      note($, 'your message asks to end the session, so it carries no hand-off')
      return next(e)
    }
    const percent = (await readPercent($)) ?? triggeredAt ?? cfg.threshold
    const instructions = closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand), 'carry')
    await prepare($, cfg, 'user', percent)
    note($, `hand-off started: context at ${Math.round(percent)}%, past ${cfg.threshold}%; your message goes to a new session`)
    const out = await next({ ...e, context: [...(e.context ?? []), instructions] })
    if (out && out.drop !== undefined && phase === 'closing' && closeTurnId === null) arm($, percent)
    return out
  }).catch(($, e, next) => next(e)) // A failure here never holds up the user's message

  // /handoff-now: the skill's own text stands in when this mod is not loaded, or where an
  // organization's security default keeps this hook from it; here it reads the hand-off as
  // configured. It runs in the turn the user typed it in, which may have started
  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    if (!HANDOFF_SKILL.test(e.skill)) return out
    if (handoffNowAsked) {
      // Already set up as it was submitted
      handoffNowAsked = false
      return { text: closePromptFor(cfg, triggeredAt ?? 0, await hasCommand($, cfg.closeCommand), 'asked') }
    }
    if (phase !== 'idle' && phase !== 'armed') {
      return { text: `${MARK} A hand-off is already in progress (${phase}). Say so in one line and stop.` }
    }
    const percent = (await readPercent($)) ?? 0
    await prepare($, cfg, 'user', percent)
    note($, 'hand-off started: asked by /handoff-now')
    $.ui.toast(`${NAME}: asked by /handoff-now, recording the hand-off`)
    if (currentTurnId !== null) await closeTurnStarted($, cfg, currentTurnId)
    return { text: closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand), 'asked') }
  })

  // The turn that runs the hand-off: for a prompt of this mod's, the one whose text carries the
  // tag; for one the user started, the next to start
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnId = e.turnId
      endTurnId = endAsked ? e.turnId : null
      endAsked = false
    }
    if (phase === 'closing' && closeTurnId === null && e.agentId === undefined) {
      const tagged = typeof e.text === 'string' && e.text.includes(MARK)
      if (closeBy === 'user' || tagged) await closeTurnStarted($, cfg, e.turnId)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // A subagent's turn is not the conversation's
    if (e.agentId !== undefined) return out
    if (e.turnId === currentTurnId) currentTurnId = null
    const ended = e.reason ?? (e.isAborted ? 'aborted' : 'answer')

    if (phase === 'closing') {
      // The hand-off prompt is still queued, behind the turn that just ran
      if (e.turnId !== closeTurnId) return out
      if (ended === 'aborted') abandon($, 'the hand-off turn was interrupted')
      else if (cfg.reset === 'session') await handOver($, cfg)
      else startCompaction($, cfg)
      return out
    }
    if (phase === 'clearing') {
      if (e.turnId === closeTurnId) {
        // An interrupted hand-off turn takes the app's queued clear with it
        if (ended === 'aborted') abandon($, 'the hand-off turn was interrupted')
        else awaitClear($)
      } else if (ended === 'answer') {
        // A turn ran after the hand-off, so the app dropped the clear: record again
        const percent = (await readPercent($)) ?? triggeredAt ?? cfg.threshold
        await begin($, cfg, percent, 'a turn ran before the clear')
      }
      return out
    }
    if (phase !== 'idle') return out
    // The resume turn has run: the session may serve Remote Control again
    await restoreRemoteControl($)
    if (!autoOn(cfg) || ended !== 'answer') return out

    const percent = await readPercent($)
    if (percent === null || percent < cfg.threshold) return out
    if (triggeredAt !== null && percent < triggeredAt + cfg.step) return out
    // The session is ending: nothing is left to carry on
    if (e.turnId === endTurnId) {
      note($, `context at ${Math.round(percent)}%, but this turn ends the session, so no hand-off starts`)
      return out
    }
    if (cfg.reset === 'session') arm($, percent)
    else await begin($, cfg, percent, `context at ${Math.round(percent)}%, past ${cfg.threshold}%`)
    return out
  })

  // A compaction run through /compact passes here as it runs: once it stands, the resume
  // follows; a compaction the engine makes on its own meanwhile serves as well
  on('session.compact', async ($, e, next) => {
    const watching = phase === 'compacting' && compactVia === 'command' && e.agentId === undefined
    let out
    try {
      out = await next(e)
    } catch (error) {
      if (watching && phase === 'compacting') abandon($, `the compaction failed: ${messageOf(error)}`)
      throw error
    }
    if (watching && phase === 'compacting') {
      if (out && out.skip !== undefined) abandon($, `the compaction was skipped: ${out.skip}`)
      else compacted($, cfg, `compacted the conversation${sizesOf(out)}`)
    }
    return out
  })

  // A /clear ends the conversation; where the process goes on, it continues with a fresh one
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && phase === 'clearing') {
      phase = 'resuming'
      cancelTimers()
      resumeTimer = $.clock.after(3000, () => submitResume($, cfg))
    } else {
      // A conversation the mod did not reset for its hand-off: /handoff-off or /handoff-on spoke for the last one
      sessionAuto = null
      if (e.reason !== 'clear') {
        phase = 'idle'
        cancelTimers()
      }
    }
    return next(e)
  })

  // The fresh conversation's SessionStart is the moment to continue
  on('classic.SessionStart', async ($, e, next) => {
    const out = await next(e)
    if (e.source === 'clear' && phase === 'resuming') submitResume($, cfg)
    return out
  }).catch(($, e, next) => next(e)) // A failure here never holds up the session

  on('command.run', { command: 'handoff-status' }, async ($) => {
    const percent = await readPercent($)
    const fill = percent === null ? 'no reading yet' : `${Math.round(percent)}%`
    return {
      text:
        `Phase: ${phase}. Context: ${fill} (threshold ${cfg.threshold}%). ` +
        `Automatic hand-off: ${autoOn(cfg) ? 'on' : 'off'}${sessionAuto === null ? '' : ' for this session'}. ` +
        `Reset: ${cfg.reset}. Last: ${lastOutcome}.`,
    }
  })

  // /handoff-off: this session goes on, or ends, with no hand-off of its own, as when it is about
  // to close just past the threshold. One armed for your next message is called off; one whose
  // turn is already asked for goes on, and interrupting that turn gives it up
  on('command.run', { command: 'handoff-off' }, async ($) => {
    sessionAuto = false
    const after = '/handoff-on turns it on again, and /handoff-now still hands off.'
    if (phase === 'armed') {
      phase = 'idle'
      note($, 'automatic hand-off off for this session; the armed hand-off is called off')
      return {
        text: `Automatic hand-off is off for this session, and your next message is not handed off. ${after}`,
      }
    }
    if (phase !== 'idle') {
      note($, `automatic hand-off off for this session; the hand-off in progress (${phase}) goes on`)
      return {
        text:
          `Automatic hand-off is off for this session from now on, but a hand-off is already in progress (${phase}). ` +
          `Interrupt its turn (Esc) to stop it. ${after}`,
      }
    }
    note($, 'automatic hand-off off for this session')
    return { text: `Automatic hand-off is off for this session. ${after}` }
  })

  // /handoff-on: the hand-off starts on its own again, even where the option has it off. The next
  // turn to end past the threshold starts it, however far the last one had got
  on('command.run', { command: 'handoff-on' }, async ($) => {
    sessionAuto = true
    if (phase === 'idle') triggeredAt = null
    note($, 'automatic hand-off on for this session')
    return {
      text: `Automatic hand-off is on for this session: the next turn to end past ${cfg.threshold}% starts it.`,
    }
  })
}
