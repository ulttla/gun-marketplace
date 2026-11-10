import { expect, test } from 'claude-code/testing'

// What Claude Code passes to a ui.render hook for the band, apart from the app
const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  viewport: { columns: 140, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

// What $.process.run resolves to for a git command that printed `stdout`
const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('the band draws before the first response, when the fill is absent', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] },
  }))
  on('process.run', () => ran(0, 'main\n'))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Ctx – (–/1M)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Last –' })).toBeDefined()
})

test('the band shows the branch, the context, what the last turn added, and a plan limit', async ($, on) => {
  // The figures $.session.usage resolves to, which the test changes mid-turn
  let tokens = 138000
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens, window: 1000000, percent: Math.round(tokens / 10000) },
      rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-10-06T19:30:00.000Z' }],
      cost: { usd: 1.239 },
    },
  }))
  on('process.run', () => ran(0, 'feature/meter\n'))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for what Claude Code would draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1' })
  tokens = 150236
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, usage: null })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'feature/meter' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ctx 15% (150k/1M)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last +12.2k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5H 4% ↻/ })).toBeDefined()
    // The model and the cost are off until their options turn them on
    expect(await ui.find({ type: 'Text', text: '$1.24' })).toBeUndefined()
    // The band keeps what the other mods drew
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a git repository the branch is left out', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 50000, window: 200000, percent: 25 }, rateLimits: [] },
  }))
  // What git answers outside a repository
  on('process.run', () => ran(128, ''))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const { text } = await $.command.run({ command: 'context-meter' })
  expect(text).toBe('Ctx 25% (50k/200k) · Last –')
})

test(
  'the options turn segments on and off',
  {
    options: {
      showDirty: true,
      showModel: true,
      showCost: true,
      showLastTurn: false,
      showWeekly: false,
      showResetTimes: false,
    },
  },
  async ($, on) => {
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { tokens: 50000, window: 200000, percent: 25 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-06T19:30:00.000Z' },
          { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-09T18:00:00.000Z' },
        ],
        cost: { usd: 1.239 },
      },
    }))
    on('session.model', () => ({ value: 'opus' }))
    // The branch, then a changed file from git status
    on('process.run', ($, e) => ran(0, e.argv.includes('status') ? ' M a.txt\n' : 'main\n'))
    on('command.register', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const { text } = await $.command.run({ command: 'context-meter' })
    expect(text).toBe('main* · opus · Ctx 25% (50k/200k) · 5H 12% · $1.24')
  },
)

test(
  'the effort shows once a model request of the session has carried one',
  { options: { showEffort: true, showBranch: false, showLastTurn: false } },
  async ($, on) => {
    on('session.usage', () => ({
      value: { startedAt: 0, context: { tokens: 50000, window: 200000, percent: 25 }, rateLimits: [] },
    }))
    on('command.register', () => ({ value: undefined }))
    on('session.start', () => ({ cwd: '/work' }))
    // Stands for the model's response to each request
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    const line = async () => (await $.command.run({ command: 'context-meter' })).text
    const step = { turnId: 't1', index: 0, model: 'opus', messageCount: 1 } as const

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    // No request has been made yet
    expect(await line()).toBe('Ctx 25% (50k/200k)')

    for await (const _ of $.turn.step({ ...step, effort: 'xhigh' }));
    expect(await line()).toBe('Effort xhigh · Ctx 25% (50k/200k)')

    // A subagent's request leaves the session's effort as it was
    for await (const _ of $.turn.step({ ...step, index: 1, effort: 'low', agentId: 'a1' }));
    expect(await line()).toBe('Effort xhigh · Ctx 25% (50k/200k)')

    // A model that takes no effort
    for await (const _ of $.turn.step({ ...step, index: 2, model: 'haiku' }));
    expect(await line()).toBe('Ctx 25% (50k/200k)')
  },
)
