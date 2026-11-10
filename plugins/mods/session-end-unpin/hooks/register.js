// The mod's name, as log lines, toasts and the notes to the model carry it
const NAME = 'session-end-unpin'
// The tool the model calls once it finds the session can end, and its full name
const ACCEPT_NAME = 'accept_session_end'
const ACCEPT_TOOL = `mcp__${NAME}__${ACCEPT_NAME}`
// Where a prompt the user sent comes from: typed, over Remote Control, or the desktop app's own
// composer, which drives the engine as an SDK host
const USER_ORIGINS = ['composer', 'bridge', 'sdk']
// How many more of the user's messages after the one that asked still belong to the ending: an
// answer to what the model asked before it could end
const FOLLOW_UPS = 2
// Each outcome is kept in the store, newest last, for a look afterwards
const LOG_KEY = 'log'
const LOG_SIZE = 30

// The user's messages left in which the request to end still counts; 0 when none is open
let openFor = 0
// How many of the user's messages ago the request was made
let askedAgo = 0
// In the main loop's turn running now: whether the model found the session can end, what it
// said it checked, and what in the turn still waits on the user
let accepted = false
let checked = ''
let heldBy = null

// The phrases, as the option lists them
function phrasesOf(options) {
  const phrases = String(options.phrases ?? '')
    .split(/[,\n]/)
    .map((phrase) => phrase.trim())
    .filter(Boolean)
  return phrases.length > 0 ? phrases : ['세션 종료', 'session 종료', '세션 end', 'end session']
}

// A phrase's words, each looked for in the text on its own
const wordsOf = (phrase) => phrase.toLowerCase().split(/\s+/).filter(Boolean)

// Whether the lower-cased text holds the word. One in Latin letters stands on its own, an English
// ending allowed (end and ended, not send, weekend or endpoint); any other may sit inside a longer
// word, so 세션을 and 종료해 hold 세션 and 종료
function holds(text, word) {
  if (!/^[a-z0-9]+$/.test(word)) return text.includes(word)
  return new RegExp(`(?<![a-z0-9])${word}(?:s|ed|ing)?(?![a-z0-9])`).test(text)
}

// The phrase whose words the text all holds, in any order and with anything between, or null
function phraseIn(text, phrases) {
  const plain = text.toLowerCase()
  return phrases.find((phrase) => wordsOf(phrase).every((word) => holds(plain, word))) ?? null
}

// What the model reads beside the message that asks to end
function askNote(phrase) {
  return (
    `[${NAME}] This message asks to end the session ("${phrase}"). First do the end-of-session steps ` +
    "this project's instructions give (progress notes, knowledge-base or wiki candidates, a close skill " +
    'where the project has one). Then judge whether the session can really end: nothing waits on the user ' +
    '(no question, decision or approval), no task is unfinished, and no follow-up is worth proposing. Only if ' +
    `all of that holds, call ${ACCEPT_TOOL} once those steps are done, and ask or propose nothing after it: ` +
    'the session is then unpinned from the sidebar when this turn ends. If anything remains, do not call it; ' +
    'say what remains. If the message only mentions ending a session rather than asking to end this one now, ' +
    'ignore this note.'
  )
}

// What the model reads beside a later message while the request is still open
function followUpNote(ago) {
  const when = ago === 1 ? 'one message ago' : `${ago} messages ago`
  return (
    `[${NAME}] The user asked to end this session ${when}, and it has not ended yet. If this message settles ` +
    'what was left and the session can now end (nothing waits on the user, nothing is unfinished, no ' +
    `follow-up to propose), call ${ACCEPT_TOOL} once the end-of-session steps are done. If the user moved on ` +
    'to new work, do not call it.'
  )
}

// The text of an MCP result
function textOf(result) {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim()
}

// Unpin this session in the desktop app's sidebar. Resolves to null once unpinned, or to why not.
async function unpin($) {
  try {
    const result = await $.mcp.call('ccd_sidebar', 'set_pinned', { session_id: 'self', pinned: false })
    return result.isError ? textOf(result) || 'the sidebar refused the request' : null
  } catch (error) {
    // Outside the desktop app there is no sidebar
    return error instanceof Error ? error.message : String(error)
  }
}

// Say what happened, and keep it
async function report($, text) {
  $.ui.log(`${NAME}: ${text}`)
  try {
    const log = (await $.store.get(LOG_KEY)) ?? []
    const entry = { at: new Date().toISOString(), session: await $.session.id(), result: text, checked }
    await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_SIZE))
  } catch {
    // The log only explains; it never stops the unpin
  }
}

// Something in this turn waits on the user, so the session stays pinned
function hold(e, reason) {
  if (e.agentId === undefined && openFor > 0) heldBy ??= reason
}

export function register(on, options) {
  const phrases = phrasesOf(options)

  // The tool is in the model's list from the start, so a request to end finds it at once
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: ACCEPT_NAME,
      description:
        "Records that this session can end, so it is unpinned from the desktop app's sidebar when this turn " +
        `ends. Call it only after the user asked to end the session (they said "${phrases[0]}" or the like), ` +
        "this project's end-of-session steps are done, and nothing remains: no question, decision or approval " +
        'waiting on the user, no unfinished task, no follow-up to propose. Never call it otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          checked: {
            type: 'string',
            description: 'One line: what the end-of-session steps came to and why nothing is left.',
          },
        },
        required: ['checked'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  // A message of the user's that asks to end opens the request, and every message while it is
  // open carries a note for the model. Not a command, nor a message from anyone else
  on('prompt.submit', async ($, e, next) => {
    const text = typeof e.text === 'string' ? e.text : ''
    if (!USER_ORIGINS.includes(e.origin?.kind) || text.trimStart().startsWith('/')) return next(e)
    const phrase = phraseIn(text, phrases)
    let note = null
    if (phrase !== null) {
      openFor = 1 + FOLLOW_UPS
      askedAgo = 0
      note = askNote(phrase)
    } else if (openFor > 0) {
      openFor -= 1
      askedAgo += 1
      if (openFor > 0) note = followUpNote(askedAgo)
    }
    return next(note === null ? e : { ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // A failure here never holds up the user's message

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      accepted = false
      checked = ''
      heldBy = null
    }
    return next(e)
  })

  on('tool.call', { tool: ACCEPT_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Not recorded: only the main conversation can end the session.' }
    if (openFor === 0) {
      return {
        result: 'Not recorded: the user has not asked to end this session. Call this only after they ask.',
      }
    }
    accepted = true
    checked = typeof e.checked === 'string' ? e.checked.trim() : ''
    return {
      result:
        'Recorded: the session is unpinned from the sidebar when this turn ends, unless something in the turn ' +
        'still waits on the user (an ask in the wrap-up, a question, a session started or proposed). Finish ' +
        'the reply without asking or proposing anything.',
    }
  })

  // What leaves something waiting on the user keeps the session pinned. A failure here never holds
  // up the call
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    if (typeof e.ask === 'string' && e.ask.trim() !== '') hold(e, 'the wrap-up asks the user something')
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    hold(e, 'a question was asked')
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, async ($, e, next) => {
    hold(e, 'a follow-up session was proposed or started')
    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn the model accepted in ends: unpin, unless it was cut short or left something waiting
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || !accepted) return out
    accepted = false
    const ended = e.reason ?? (e.isAborted ? 'aborted' : 'answer')
    if (ended !== 'answer') {
      await report($, `kept pinned: the turn ended (${ended}) before the session could end`)
      return out
    }
    if (heldBy !== null) {
      await report($, `kept pinned: ${heldBy}`)
      return out
    }
    const failed = await unpin($)
    if (failed !== null) {
      await report($, `could not unpin this session: ${failed}`)
      return out
    }
    openFor = 0
    await report($, 'the session ended: unpinned from the sidebar')
    $.ui.toast(`${NAME}: unpinned this session`)
    return out
  })
}
