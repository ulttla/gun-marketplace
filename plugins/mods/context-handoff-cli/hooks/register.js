// context-handoff-cli: the terminal's hand-off. Past a context threshold, Claude records a
// hand-off in the project notes; then this mod runs /clear, which starts a fresh session (a new
// session id and transcript) in the same terminal, and submits the prompt that continues the
// work from the notes. The desktop app's counterpart is context-handoff.

// The mod's name, as toasts, log lines and the hand-off prompts carry it
const NAME = 'context-handoff-cli'
// A tag every prompt this mod submits carries, so its own turn can be told apart
const MARK = '[context-handoff-cli]'
// This plugin's /handoff-now skill, bare or under this plugin's name (not context-handoff's)
const HANDOFF_SKILL = /^(context-handoff-cli:)?handoff-now$/
// Where a prompt the user sent comes from: typed, over Remote Control, or an SDK host
const USER_ORIGINS = ['composer', 'bridge', 'sdk']
// When /clear is asked for after the hand-off turn ends; tried again if the call is refused
const CLEAR_TRIES_MS = [300, 1500, 4000]
// How long /clear gets, once it has run, to end the conversation
const CLEAR_WAIT_MS = 5000
// How long /clear may wait in the queue (behind a turn that slipped in) before it is given up
const CLEAR_QUEUE_MS = 10 * 60 * 1000
// How long after the clear the resume prompt is submitted when no SessionStart comes first
const RESUME_FALLBACK_MS = 3000
// When the fallback compaction is tried: it is refused while a turn still runs
const COMPACT_TRIES_MS = [300, 1000, 2000, 4000, 8000]
// What the summarizer is told when the fallback compacts the conversation
const COMPACT_INSTRUCTIONS =
  'A hand-off for a fresh start was just recorded in the project notes. Keep only: where the notes are (file and section), ' +
  'the exact next step, and any question still waiting for the user. Leave out everything else; it is in the notes.'
// The most of one late message the resume prompt quotes
const LATE_MAX_CHARS = 2000

// Where the hand-off stands:
//   idle        nothing in progress
//   closing     the hand-off is asked for; waiting for its turn to run and finish
//   clearing    the hand-off turn has ended; /clear is asked for, waiting for the conversation to end
//   compacting  (fallback) /clear did not start a fresh session; compacting here instead
//   resuming    the conversation was reset; waiting to submit the resume prompt
let phase = 'idle'
// Whether the mod works in this session: an interactive terminal session (not -p, not an SDK host)
let active = false
// The hand-off prompt as submitted, and the id of the turn running it
let closeText = null
let closeTurnId = null
// What asks for the hand-off turn: a prompt this mod submits (`prompt`), found by its tag, or
// the turn the user starts (`user`: /handoff-now), the next to start
let closeBy = null
// The main loop's turn running now, for /handoff-now expanded after its turn started
let currentTurnId = null
// The context percent at which the last hand-off began; the next waits for `step` more
let triggeredAt = null
// (clearing) Whether /clear has been asked of the engine; before that a turn that starts is
// waited for and the hand-off recorded again after it
let clearAsked = false
// (clearing) A turn that started before /clear was asked: the hand-off is recorded again after it
let slippedTurnId = null
// (clearing) What the user sent once /clear was queued: it runs in the old conversation, so the
// fresh one is told
let lateMessages = []
// Timers
let clearTimer = null
let clearWatchdog = null
let resumeTimer = null
let compactTimer = null
// Whether the user's message waiting for its turn asks to end the session, and the main loop's
// turn that runs such a message: it starts no hand-off
let endAsked = false
let endTurnId = null
// /handoff-now set the hand-off up as it was submitted; the skill's text, where this mod reads
// it, is still to come
let handoffNowAsked = false
// What /handoff-off (false) or /handoff-on (true) said for this conversation; null until one is typed
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
    fallback: options.fallback === 'none' ? 'none' : 'compact',
    closeCommand: String(options.closeCommand ?? 'session-close').trim().replace(/^\//, ''),
    closePrompt: String(options.closePrompt ?? '').trim(),
    resumePrompt: String(options.resumePrompt ?? '').trim(),
    endPhrases: String(options.endPhrases ?? '세션 종료, session 종료, 세션 end, end session')
      .split(/[,\n]/)
      .map((phrase) => wordsOf(phrase))
      .filter((words) => words.length > 0),
  }
}

// Whether the hand-off starts on its own in this conversation: as /handoff-off or /handoff-on
// said, else as the option has it
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
  return text.replaceAll('{percent}', String(Math.round(percent))).replaceAll('{threshold}', String(cfg.threshold))
}

// How the hand-off turn ends: the notes written, the turn stops, and the mod does the rest
const THEN =
  'When the notes are written, stop with one line saying so: a fresh session then starts automatically in this terminal ' +
  'and continues from the notes. Do not run /clear yourself and do not open another session.'

// The prompt that records the hand-off: the project's own close skill when it has one, a custom
// prompt when configured, or the built-in instructions. `why` is `threshold` (a prompt of its
// own) or `asked` (/handoff-now, whatever the context holds)
function closePromptFor(cfg, percent, hasClose, why = 'threshold') {
  const fill = `The context window is ${Math.round(percent)}% full`
  const level =
    why === 'asked'
      ? `${fill}; a hand-off was asked for with /handoff-now.`
      : `${fill}, past the ${cfg.threshold}% hand-off threshold.`
  const pending =
    'If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.'
  if (cfg.closePrompt) return `${MARK} ${fillIn(cfg.closePrompt, percent, cfg)} ${THEN}`
  // A prompt may not begin with a slash, so the skill is named for the model to invoke
  if (hasClose) {
    return (
      `${MARK} ${level} Run this project's /${cfg.closeCommand} skill now (invoke it with the Skill tool) to record the hand-off, ` +
      `and make the next starting point exact. ${pending} ${THEN}`
    )
  }
  return (
    `${MARK} ${level} Do not start new work. Record a hand-off for a fresh start: ` +
    "if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; " +
    'otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. ' +
    'Cover what was done this session, the current state, measured facts worth not measuring again, open questions, ' +
    `and the exact next step. ${pending} ${THEN}`
  )
}

// Where the notes are read from and how the work picks up from them
const READ_NOTES =
  "Read this project's hand-off notes: the progress file CLAUDE.md names, else PROGRESS.md, else HANDOFF.md at the project root. " +
  'Say in one line what you are picking up, then continue from the recorded next step without redoing work the notes mark as done. ' +
  'If the notes hold a question for the user, ask it and wait.'

// The prompt that continues the work in the fresh session (or, after the fallback, in this
// compacted one), with what the user sent after the notes were written
function resumePromptFor(cfg, how, late) {
  const opening =
    how === 'compacted'
      ? 'The context was compacted after a hand-off (a fresh session could not be started).'
      : 'This is a fresh session: the previous one in this terminal handed off when its context filled up.'
  const base = cfg.resumePrompt ? `${MARK} ${cfg.resumePrompt}` : `${MARK} ${opening} ${READ_NOTES}`
  if (late.length === 0) return base
  const quoted = late.map((text) => `"${text}"`).join(' ')
  return (
    `${base} After the notes were written, the user sent ${late.length === 1 ? 'this message' : 'these messages'}, ` +
    `which ran in the old session and may be missing from the notes; check what came of ${late.length === 1 ? 'it' : 'them'} ` +
    `before going on: ${quoted}`
  )
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
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

// Whether a turn's text is the /clear this mod asked for, should the engine run it as a turn
function isClear(text) {
  return typeof text === 'string' && /^\/clear\b/.test(text.trim())
}

function cancelTimers() {
  if (clearTimer) clearTimer.cancel()
  if (clearWatchdog) clearWatchdog.cancel()
  if (resumeTimer) resumeTimer.cancel()
  if (compactTimer) compactTimer.cancel()
  clearTimer = clearWatchdog = resumeTimer = compactTimer = null
}

// Back to idle, the hand-off's own state dropped; triggeredAt stays for the step
function settle() {
  phase = 'idle'
  closeText = null
  closeTurnId = null
  closeBy = null
  clearAsked = false
  slippedTurnId = null
  lateMessages = []
  cancelTimers()
}

// Give up the hand-off in progress and say why; the next tries once the context grew by the step
function abandon($, reason) {
  settle()
  note($, `gave up: ${reason}`)
  $.ui.toast(`${NAME}: ${reason}. /handoff-now retries.`, { timeoutMs: 8000 })
}

// The hand-off is asked for: its turn is awaited
function prepare(by, percent) {
  settle()
  phase = 'closing'
  closeBy = by
  triggeredAt = percent
}

function closeTurnStarted($, turnId) {
  closeTurnId = turnId
  note($, 'the hand-off turn is running')
}

// /handoff-now, as it is submitted: the hand-off is set up here rather than where the skill's
// text is read (skill.prompt), since an organization's security default keeps that event from
// the plugins a person installs. The instructions ride along as context; where they don't reach,
// the skill's own text holds the default ones. Its turn is the next to start
async function handOffNow($, cfg, e, next) {
  if (!active) {
    const why =
      `${MARK} ${NAME} works only in an interactive terminal session, and this is not one: record the notes as the skill says, ` +
      'then tell the user in one line that no fresh session starts on its own here.'
    return next({ ...e, context: [...(e.context ?? []), why] })
  }
  if (phase !== 'idle') return { drop: `${NAME}: a hand-off is already in progress (${phase})` }
  const was = triggeredAt
  const percent = (await readPercent($)) ?? 0
  prepare('user', percent)
  handoffNowAsked = true
  note($, 'hand-off started: asked by /handoff-now')
  $.ui.toast(`${NAME}: asked by /handoff-now, recording the hand-off`)
  const instructions =
    `${MARK} These are the /handoff-now instructions for this session's settings; where the skill's text differs, ` +
    `follow these. ${closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand), 'asked')}`
  const out = await next({ ...e, context: [...(e.context ?? []), instructions] })
  // The command did not enter: nothing is in progress
  if (out && out.drop !== undefined && phase === 'closing' && closeTurnId === null) {
    settle()
    triggeredAt = was
    handoffNowAsked = false
  }
  return out
}

// Submit the hand-off prompt; its turn is found by the tag at turn.start
async function begin($, cfg, percent, why) {
  prepare('prompt', percent)
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

// The hand-off turn has ended: run /clear a moment later, once the session is idle. A turn that
// starts before then (a message the user had waiting) is let run, and the notes are written again
// after it, so the fresh session misses nothing
function startClear($, cfg) {
  phase = 'clearing'
  clearAsked = false
  note($, 'hand-off recorded, starting a fresh session with /clear')
  $.ui.toast(`${NAME}: hand-off recorded, starting a fresh session`)
  askClear($, cfg, 0)
}

function askClear($, cfg, attempt) {
  clearTimer = $.clock.after(CLEAR_TRIES_MS[attempt], () => {
    clearTimer = null
    if (phase !== 'clearing' || clearAsked || slippedTurnId !== null) return
    clearAsked = true
    // /clear waits in the queue behind any turn that runs first; past this, it is given up
    clearWatchdog = $.clock.after(CLEAR_QUEUE_MS, () => {
      clearWatchdog = null
      if (phase === 'clearing') abandon($, `/clear did not run within ${CLEAR_QUEUE_MS / 60000} min`)
    })
    $.command
      .run({ command: 'clear' })
      .then(() => {
        if (phase !== 'clearing') return
        // It ran; the conversation's end (session.end) is due now
        if (clearWatchdog) clearWatchdog.cancel()
        clearWatchdog = $.clock.after(CLEAR_WAIT_MS, () => {
          clearWatchdog = null
          if (phase === 'clearing') fallBack($, cfg, '/clear ran, but no fresh session started')
        })
      })
      .catch((error) => {
        if (phase !== 'clearing') return
        clearAsked = false
        if (clearWatchdog) clearWatchdog.cancel()
        clearWatchdog = null
        if (attempt + 1 < CLEAR_TRIES_MS.length) return askClear($, cfg, attempt + 1)
        fallBack($, cfg, `/clear could not be run: ${messageOf(error)}`)
      })
  })
}

// /clear did not start a fresh session: compact the conversation here instead, as configured
function fallBack($, cfg, why) {
  if (cfg.fallback === 'none') return abandon($, why)
  cancelTimers()
  phase = 'compacting'
  note($, `${why}; compacting the conversation here instead`)
  $.ui.toast(`${NAME}: no fresh session, compacting the conversation instead`)
  const attempt = (i) => {
    compactTimer = $.clock.after(COMPACT_TRIES_MS[i], async () => {
      compactTimer = null
      if (phase !== 'compacting') return
      let result
      try {
        result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      } catch (error) {
        if (i + 1 < COMPACT_TRIES_MS.length) return attempt(i + 1)
        return abandon($, `${why}, and the conversation could not be compacted: ${messageOf(error)}`)
      }
      if (phase !== 'compacting') return
      if (result && result.skip) return abandon($, `${why}, and the compaction was skipped: ${result.skip}`)
      note($, `compacted the conversation${sizesOf(result)}`)
      phase = 'resuming'
      submitResume($, cfg, 'compacted')
    })
  }
  attempt(0)
}

// Submit the resume prompt into the fresh conversation, once
function submitResume($, cfg, how = 'fresh') {
  if (phase !== 'resuming') return
  const text = resumePromptFor(cfg, how, lateMessages)
  settle()
  triggeredAt = null
  note($, how === 'fresh' ? 'continuing from the notes in the fresh session' : 'continuing from the notes here')
  $.ui.toast(`${NAME}: continuing from the notes`)
  $.prompt.submit({ text, asUser: true }).catch(() => {})
}

/** @type {import('claude-code').Register} */
export function register(on, options) {
  const cfg = settingsOf(options)

  // Runs before the first prompt, and again after a reload (never after /clear)
  on('session.start', async ($, e, next) => {
    active = e.isInteractive === true && e.surface === 'terminal'
    await $.command.register({
      name: 'handoff-status',
      description: 'Show where the automatic hand-off stands and what it did last',
    })
    await $.command.register({
      name: 'handoff-off',
      description: 'Turn the automatic hand-off off for this conversation; /handoff-now still hands off',
    })
    await $.command.register({
      name: 'handoff-on',
      description: 'Turn the automatic hand-off on again for this conversation',
    })
    return next(e)
  })

  // /handoff-now sets the hand-off up as it is submitted. A message of the user's that asks to
  // end the session is noted, so its turn starts no hand-off
  on('prompt.submit', async ($, e, next) => {
    const text = typeof e.text === 'string' ? e.text : ''
    const fromUser = USER_ORIGINS.includes(e.origin?.kind)
    if (fromUser && e.command !== undefined && HANDOFF_SKILL.test(e.command.name)) return handOffNow($, cfg, e, next)
    if (fromUser && e.turnId === undefined && !text.trimStart().startsWith('/')) endAsked = asksToEnd(cfg, text)
    return next(e)
  }).catch(($, e, next) => next(e)) // A failure here never holds up the user's message

  // /handoff-now: the skill's own text stands in when this mod is not loaded, or where an
  // organization's security default keeps the prompt.submit hook from it
  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    if (!HANDOFF_SKILL.test(e.skill) || !active) return out
    if (handoffNowAsked) {
      // Already set up as it was submitted
      handoffNowAsked = false
      return { text: closePromptFor(cfg, triggeredAt ?? 0, await hasCommand($, cfg.closeCommand), 'asked') }
    }
    if (phase !== 'idle') {
      return { text: `${MARK} A hand-off is already in progress (${phase}). Say so in one line and stop.` }
    }
    const percent = (await readPercent($)) ?? 0
    prepare('user', percent)
    note($, 'hand-off started: asked by /handoff-now')
    $.ui.toast(`${NAME}: asked by /handoff-now, recording the hand-off`)
    if (currentTurnId !== null) closeTurnStarted($, currentTurnId)
    return { text: closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand), 'asked') }
  })

  // The turn that runs the hand-off: for a prompt of this mod's, the one whose text carries the
  // tag; for /handoff-now, the next to start. While /clear is pending, a turn that starts is
  // either waited for (not yet asked) or told to the fresh session (already queued)
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnId = e.turnId
      endTurnId = endAsked ? e.turnId : null
      endAsked = false
      if (phase === 'closing' && closeTurnId === null) {
        const tagged = typeof e.text === 'string' && e.text.includes(MARK)
        if (closeBy === 'user' || tagged) closeTurnStarted($, e.turnId)
      } else if (phase === 'clearing' && !isClear(e.text)) {
        if (!clearAsked) {
          if (clearTimer) clearTimer.cancel()
          clearTimer = null
          slippedTurnId = e.turnId
          note($, 'a turn started before /clear; the hand-off is recorded again after it')
        } else if (typeof e.text === 'string' && e.text.trim() && !e.text.includes(MARK)) {
          lateMessages.push(e.text.trim().slice(0, LATE_MAX_CHARS))
        }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // A subagent's turn is not the conversation's
    if (e.agentId !== undefined) return out
    if (e.turnId === currentTurnId) currentTurnId = null
    if (!active) return out
    const ended = e.reason ?? (e.isAborted ? 'aborted' : 'answer')

    if (phase === 'closing') {
      // The hand-off prompt is still queued, behind the turn that just ran
      if (e.turnId !== closeTurnId) return out
      if (ended === 'answer') startClear($, cfg)
      else abandon($, ended === 'aborted' ? 'the hand-off turn was interrupted' : `the hand-off turn ended with ${ended}`)
      return out
    }
    if (phase === 'clearing') {
      if (e.turnId !== slippedTurnId) return out
      slippedTurnId = null
      if (ended !== 'answer') {
        abandon($, 'a turn ran before /clear and did not finish')
        return out
      }
      const percent = (await readPercent($)) ?? triggeredAt ?? cfg.threshold
      await begin($, cfg, percent, 'a turn ran before /clear')
      return out
    }
    if (phase !== 'idle') return out
    if (!autoOn(cfg) || ended !== 'answer') return out

    const percent = await readPercent($)
    if (percent === null || percent < cfg.threshold) return out
    if (triggeredAt !== null && percent < triggeredAt + cfg.step) return out
    // The session is ending: nothing is left to carry on
    if (e.turnId === endTurnId) {
      note($, `context at ${Math.round(percent)}%, but this turn ends the session, so no hand-off starts`)
      return out
    }
    await begin($, cfg, percent, `context at ${Math.round(percent)}%, past ${cfg.threshold}%`)
    return out
  })

  // A /clear ends the conversation and the process goes on with a fresh one: the mod's own clear
  // leads to the resume; anyone else's resets the per-conversation switches
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && phase === 'clearing') {
      cancelTimers()
      phase = 'resuming'
      note($, 'the conversation was cleared; a fresh session starts')
      resumeTimer = $.clock.after(RESUME_FALLBACK_MS, () => submitResume($, cfg))
    } else {
      sessionAuto = null
      if (e.reason === 'clear') {
        triggeredAt = null
        if (phase !== 'idle') abandon($, 'the conversation was cleared before the hand-off finished')
      } else {
        settle()
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
    const where = active ? '' : ' Inactive: not an interactive terminal session.'
    return {
      text:
        `Phase: ${phase}. Context: ${fill} (threshold ${cfg.threshold}%). ` +
        `Automatic hand-off: ${autoOn(cfg) ? 'on' : 'off'}${sessionAuto === null ? '' : ' for this conversation'}. ` +
        `Fallback: ${cfg.fallback}.${where} Last: ${lastOutcome}.`,
    }
  })

  // /handoff-off: this conversation goes on, or ends, with no automatic hand-off. One whose turn
  // is already asked for goes on, and interrupting that turn gives it up
  on('command.run', { command: 'handoff-off' }, async ($) => {
    sessionAuto = false
    const after = '/handoff-on turns it on again, and /handoff-now still hands off.'
    if (phase !== 'idle') {
      note($, `automatic hand-off off for this conversation; the hand-off in progress (${phase}) goes on`)
      return {
        text:
          `Automatic hand-off is off for this conversation from now on, but a hand-off is already in progress (${phase}). ` +
          `Interrupt its turn (Esc) to stop it. ${after}`,
      }
    }
    note($, 'automatic hand-off off for this conversation')
    return { text: `Automatic hand-off is off for this conversation. ${after}` }
  })

  // /handoff-on: the hand-off starts on its own again, even where the option has it off. The next
  // turn to end past the threshold starts it, however far the last one had got
  on('command.run', { command: 'handoff-on' }, async ($) => {
    sessionAuto = true
    if (phase === 'idle') triggeredAt = null
    note($, 'automatic hand-off on for this conversation')
    return {
      text: `Automatic hand-off is on for this conversation: the next turn to end past ${cfg.threshold}% starts it.`,
    }
  })
}
