import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// What the sidebar answers when it pins
const PINNED = { value: { content: [], isError: false } }

const START = { surface: 'desktop', isInteractive: false, cwd: '/work' } as const

// A turn of the main loop that ended with an answer
const done = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }) as const

type Sidebar = { isConnected: boolean; calls: number; requests?: unknown[] }

// The engine beneath the plugin: a session that has sent `prompts.count` prompts, and a sidebar
// that pins once `sidebar.isConnected`. Each pin request is counted in `sidebar.calls`.
function engine(on: On, prompts: { count: number }, sidebar: Sidebar) {
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => ({ value: prompts.count }))
  on('mcp.call', ($, e) => {
    sidebar.calls++
    sidebar.requests?.push(e)
    if (!sidebar.isConnected) return { deny: 'no such server' }
    return PINNED
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('a new session is pinned as it starts', async ($, on) => {
  const prompts = { count: 0 }
  const sidebar = { isConnected: true, calls: 0, requests: [] }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  expect(sidebar.requests).toEqual([
    { server: 'ccd_sidebar', tool: 'set_pinned', args: { session_id: 'self', pinned: true } },
  ])

  // Once pinned it is left alone, so unpinning it later sticks
  prompts.count = 1
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done('t1'))
  expect(sidebar.calls).toBe(1)
})

test('a resumed session is left as it is', async ($, on) => {
  const prompts = { count: 3 }
  const sidebar = { isConnected: true, calls: 0 }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done('t1'))
  expect(sidebar.calls).toBe(0)
})

test('a pin that fails at the start is tried again until it holds', async ($, on) => {
  const prompts = { count: 0 }
  const sidebar = { isConnected: false, calls: 0 }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  expect(sidebar.calls).toBe(1)

  // The sidebar is still not there as the first prompt starts, and is by its end
  prompts.count = 1
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(sidebar.calls).toBe(2)
  sidebar.isConnected = true
  await $.turn.complete(done('t1'))
  expect(sidebar.calls).toBe(3)

  prompts.count = 2
  await $.turn.start({ text: 'more', turnId: 't2' })
  expect(sidebar.calls).toBe(3)
})

test("a subagent's turn does not try", async ($, on) => {
  const prompts = { count: 0 }
  const sidebar = { isConnected: false, calls: 0 }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  sidebar.isConnected = true
  await $.turn.start({ text: 'task', turnId: 'a1', agentId: 'agent-1' })
  await $.turn.complete({ ...done('a1'), agentId: 'agent-1' })
  expect(sidebar.calls).toBe(1)

  prompts.count = 1
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(sidebar.calls).toBe(2)
})

test('the pin is given up after three prompts', async ($, on) => {
  const prompts = { count: 0 }
  const sidebar = { isConnected: false, calls: 0 }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  for (const turn of [1, 2, 3, 4, 5]) {
    prompts.count = turn
    await $.turn.start({ text: 'hi', turnId: `t${turn}` })
    await $.turn.complete(done(`t${turn}`))
  }
  // One at the start and two in each of the first three prompts
  expect(sidebar.calls).toBe(7)
})

test("/auto-pin pins and lists the session's tries", async ($, on) => {
  const prompts = { count: 0 }
  const sidebar = { isConnected: false, calls: 0 }
  engine(on, prompts, sidebar)

  await $.session.start(START)
  sidebar.isConnected = true
  const { text } = await $.command.run({ command: 'auto-pin', args: '' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('Pinned this session')
  expect(lines[1]).toMatch(/ session\.start \(prompt 0\): .*no such server/)
  expect(lines[2]).toMatch(/ command \(prompt 0\): pinned$/)
})
