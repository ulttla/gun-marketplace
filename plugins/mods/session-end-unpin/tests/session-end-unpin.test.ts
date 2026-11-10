import { expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

const ACCEPT = 'mcp__session-end-unpin__accept_session_end'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

const START = { surface: 'desktop', isInteractive: true, cwd: '/work' } as const

// A finished turn of the main loop, as the engine reports it
const done = (turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  ({ turnId, reason, answer: 'ok', durationMs: 1, isAborted: reason === 'aborted' }) as const

// Wires the engine beneath the mod and records what reaches the model, the sidebar and the log
function wire(on: On, sidebar: { refuses?: string } = {}) {
  const received: { text: string; context: readonly string[] }[] = []
  const pins: unknown[] = []
  const logged: string[] = []
  const tools: unknown[] = []
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('tool.register', ($, e) => {
    tools.push(e)
    return { value: { tool: `mcp__session-end-unpin__${e.name}` } }
  })
  on('prompt.submit', ($, e) => {
    received.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, origin: e.origin }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('mcp.call', ($, e) => {
    pins.push(e)
    return sidebar.refuses
      ? { value: { content: [{ type: 'text', text: sidebar.refuses }], isError: true } }
      : { value: { content: [], isError: false } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  return { received, pins, logged, tools, store }
}

// The user sends a message, and its turn starts
async function say($: Engine, turnId: string, text: string) {
  await $.prompt.submit({ text, origin: { kind: 'sdk' }, wait: false })
  await $.turn.start({ text, turnId })
}

// The model finds the session can end
const accept = ($: Engine) => $.tool.call({ tool: ACCEPT, checked: 'PROGRESS.md updated, no wiki candidate' })

const UNPIN = { server: 'ccd_sidebar', tool: 'set_pinned', args: { session_id: 'self', pinned: false } }

test('the tool is in the model list from the start', async ($, on) => {
  const { tools } = wire(on)
  await $.session.start(START)
  expect(tools).toEqual([expect.objectContaining({ name: 'accept_session_end', isDeferred: false })])
})

test('an accepted end unpins the session when its turn ends', async ($, on) => {
  const { received, pins, logged, store } = wire(on)
  await $.session.start(START)

  await say($, 't1', '세션 종료')
  expect(received[0].context).toEqual([expect.stringContaining(`call ${ACCEPT}`)])

  const answer = await accept($)
  expect(answer).toEqual({ result: expect.stringMatching(/^Recorded/) })
  // Nothing happens before the turn ends
  expect(pins).toEqual([])

  await $.turn.complete(done('t1'))
  expect(pins).toEqual([UNPIN])
  expect(logged).toEqual(['session-end-unpin: the session ended: unpinned from the sidebar'])
  expect(store.log).toEqual([
    expect.objectContaining({ result: 'the session ended: unpinned from the sidebar', checked: 'PROGRESS.md updated, no wiki candidate' }),
  ])

  // The request is closed: the next message carries no note
  await say($, 't2', 'one more thing')
  expect(received[1].context).toEqual([])
})

test('the phrase matches in a longer message, ignoring case and spaces', async ($, on) => {
  const { received } = wire(on, {})
  await $.session.start(START)
  await say($, 't1', '정리 끝났으면 세션종료 해 줘')
  await $.turn.complete(done('t1'))
  await say($, 't2', 'OK, End  Session please')
  expect(received.map((r) => r.context.length)).toEqual([1, 1])
})

test('a session word and an end word ask to end, in any order and either language', async ($, on) => {
  const { received } = wire(on)
  await $.session.start(START)
  const asks = [
    '세션 종료',
    'Session 종료',
    'session 종료',
    '세션을 종료해 주세요',
    '세션 종료해줘',
    '종료해 세션',
    'end session',
    'End the session',
    'session end',
    'SESSION ENDED',
  ]
  for (const [i, text] of asks.entries()) await say($, `t${i}`, text)
  expect(received.map((r) => r.context.join(' ').includes('This message asks to end the session'))).toEqual(
    asks.map(() => true),
  )
})

test('one word alone, or end inside another word, does not ask to end', async ($, on) => {
  const { received } = wire(on)
  await $.session.start(START)
  for (const text of ['종료', '세션', 'send the session log', 'weekend session', 'the session endpoint']) {
    await $.prompt.submit({ text, origin: { kind: 'sdk' }, wait: false })
  }
  expect(received.map((r) => r.context.length)).toEqual([0, 0, 0, 0, 0])
})

test('the phrases come from the option', { options: { phrases: 'wrap it up, done for today' } }, async ($, on) => {
  const { received } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await say($, 't2', 'wrap it up')
  expect(received.map((r) => r.context.length)).toEqual([0, 1])
})

test('a command, or a message from anyone but the user, does not ask to end', async ($, on) => {
  const { received } = wire(on)
  await $.session.start(START)
  await $.prompt.submit({ text: '/compact 세션 종료', origin: { kind: 'sdk' }, wait: false })
  await $.prompt.submit({ text: '세션 종료', origin: { kind: 'peer' }, wait: false } as never)
  expect(received.map((r) => r.context.length)).toEqual([0, 0])
  expect(await accept($)).toEqual({ result: expect.stringMatching(/^Not recorded/) })
})

test('without a request to end, the tool records nothing', async ($, on) => {
  const { pins } = wire(on)
  await $.session.start(START)
  await say($, 't1', 'fix the build')
  expect(await accept($)).toEqual({ result: expect.stringMatching(/^Not recorded/) })
  await $.turn.complete(done('t1'))
  expect(pins).toEqual([])
})

test('a request the model does not accept leaves the session pinned', async ($, on) => {
  const { pins, logged } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await $.turn.complete(done('t1'))
  expect(pins).toEqual([])
  expect(logged).toEqual([])
})

test('a wrap-up that asks something keeps the session pinned', async ($, on) => {
  const { pins, logged } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await accept($)
  await $.tool.call({ tool: WRAP_UP, recap: 'done', ask: 'Push the branch?' })
  await $.turn.complete(done('t1'))
  expect(pins).toEqual([])
  expect(logged).toEqual(['session-end-unpin: kept pinned: the wrap-up asks the user something'])
})

test('a wrap-up with a recap alone does not hold the end', async ($, on) => {
  const { pins } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await $.tool.call({ tool: WRAP_UP, recap: 'done' })
  await accept($)
  await $.turn.complete(done('t1'))
  expect(pins).toEqual([UNPIN])
})

test('a question or a follow-up session keeps the session pinned', async ($, on) => {
  const { pins, logged } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await accept($)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Next' })
  await $.turn.complete(done('t1'))

  await say($, 't2', '세션 종료')
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await accept($)
  await $.turn.complete(done('t2'))

  expect(pins).toEqual([])
  expect(logged).toEqual([
    'session-end-unpin: kept pinned: a follow-up session was proposed or started',
    'session-end-unpin: kept pinned: a question was asked',
  ])
})

test('an interrupted turn keeps the session pinned', async ($, on) => {
  const { pins, logged } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await accept($)
  await $.turn.complete(done('t1', 'aborted'))
  expect(pins).toEqual([])
  expect(logged).toEqual(['session-end-unpin: kept pinned: the turn ended (aborted) before the session could end'])
})

test('an answer to what the model asked can still end the session', async ($, on) => {
  const { received, pins } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await $.turn.complete(done('t1'))

  await say($, 't2', '응, 위키 후보는 필요 없어')
  expect(received[1].context).toEqual([expect.stringContaining('asked to end this session one message ago')])
  await accept($)
  await $.turn.complete(done('t2'))
  expect(pins).toEqual([UNPIN])
})

test('the request closes after two more messages', async ($, on) => {
  const { received } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await $.turn.complete(done('t1'))
  await say($, 't2', 'first')
  await $.turn.complete(done('t2'))
  await say($, 't3', 'second')
  await $.turn.complete(done('t3'))
  await say($, 't4', 'third')
  expect(received.map((r) => r.context.length)).toEqual([1, 1, 1, 0])
  expect(received[2].context[0]).toContain('2 messages ago')
  expect(await accept($)).toEqual({ result: expect.stringMatching(/^Not recorded/) })
})

test("a subagent's call or turn does not end the session", async ($, on) => {
  const { pins } = wire(on)
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  expect(await $.tool.call({ tool: ACCEPT, checked: 'x', agentId: 'a1' })).toEqual({
    result: expect.stringMatching(/^Not recorded/),
  })
  await accept($)
  // A subagent's turn neither clears nor spends the acceptance
  await $.turn.start({ text: 'task', turnId: 'a-t', agentId: 'a1' })
  await $.tool.call({ tool: WRAP_UP, recap: 'x', ask: 'y', agentId: 'a1' })
  await $.turn.complete({ ...done('a-t'), agentId: 'a1' })
  expect(pins).toEqual([])
  await $.turn.complete(done('t1'))
  expect(pins).toEqual([UNPIN])
})

test('a refused unpin is reported', async ($, on) => {
  const { logged } = wire(on, { refuses: 'Routine runs show under their routine' })
  await $.session.start(START)
  await say($, 't1', '세션 종료')
  await accept($)
  await $.turn.complete(done('t1'))
  expect(logged).toEqual(['session-end-unpin: could not unpin this session: Routine runs show under their routine'])
})
