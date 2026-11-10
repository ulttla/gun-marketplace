// Whether this new session still waits to be pinned. The host holds it, so a reload of this module keeps it
const PENDING = { plugin: 'auto-pin', key: 'isPending' }

// The sidebar may connect only after the session starts, so the pin is tried again through this many prompts
const RETRY_PROMPTS = 3

// Each try is kept in the store, newest last, so /auto-pin can say what happened
const LOG_KEY = 'log'
const LOG_SIZE = 50

// Pin this session in the desktop app's sidebar. Resolves to null once pinned, or to why it was not.
async function pin($) {
  try {
    const result = await $.mcp.call('ccd_sidebar', 'set_pinned', { session_id: 'self', pinned: true })
    if (!result.isError) return null
    const said = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .trim()
    return said || 'the sidebar refused the request'
  } catch (error) {
    // Outside the desktop app there is no sidebar to pin in
    return error instanceof Error ? error.message : String(error)
  }
}

// Keep what a try came to
async function record($, event, reason) {
  try {
    const log = (await $.store.get(LOG_KEY)) ?? []
    const entry = {
      at: new Date().toISOString(),
      session: await $.session.id(),
      event,
      prompts: await $.session.turns(),
      result: reason ?? 'pinned',
    }
    await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_SIZE))
  } catch {
    // The log only explains; it never stops a pin
  }
}

// Pin, and remember whether to try again
async function tryPin($, event) {
  const reason = await pin($)
  await $.state.set(PENDING, reason !== null)
  await record($, event, reason)
  return reason
}

// Try again while this session waits, on the main loop's turns alone
async function retry($, e, event) {
  if (e.agentId !== undefined) return
  const { value: isPending } = await $.state.get(PENDING)
  if (!isPending) return
  if ((await $.session.turns()) > RETRY_PROMPTS) {
    await $.state.set(PENDING, false)
    await record($, event, `gave up after ${RETRY_PROMPTS} prompts`)
    return
  }
  await tryPin($, event)
}

export function register(on) {
  // Runs before your first prompt, and again after a reload, which leaves the pending pin as it was
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-pin',
      description: 'Pin this session in the sidebar',
      immediate: true,
    })
    // A session that already has prompts was resumed: you may have unpinned it, so leave it
    if ((await $.session.turns()) === 0) await tryPin($, 'session.start')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await retry($, e, 'turn.start')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await retry($, e, 'turn.complete')
    return result
  })

  // Pins on request, and lists this session's tries
  on('command.run', { command: 'auto-pin' }, async ($) => {
    const reason = await tryPin($, 'command')
    const session = await $.session.id()
    const log = (await $.store.get(LOG_KEY)) ?? []
    const tries = log
      .filter((entry) => entry.session === session)
      .map((entry) => `${entry.at} ${entry.event} (prompt ${entry.prompts}): ${entry.result}`)
    const head = reason === null ? 'Pinned this session' : `Could not pin this session: ${reason}`
    return { text: [head, ...tries].join('\n') }
  })
}
