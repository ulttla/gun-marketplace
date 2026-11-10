import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

// A finished turn of the main loop, as the engine reports it
const turn = (turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  ({ turnId, reason, answer: 'ok', durationMs: 1, isAborted: reason === 'aborted' }) as const

// What the session's context looks like at `percent` full
type Context = { percent: number }

// What the engine does with the /clear the mod runs: runs it, or refuses it
type ClearAnswer = 'ran' | 'refused'

type WireOptions = {
  commands?: string[]
  clear?: ClearAnswer
  compact?: () => unknown
}

const SUMMARY = { role: 'assistant' as const, text: 'The notes are in HANDOFF.md; next: Phase C', toolUses: [] }

// Wires the engine beneath the mod and records what the mod submits, runs, compacts and logs
function wire($: Engine, on: On, context: Context, options: WireOptions = {}) {
  const { commands = [], clear = 'ran' } = options
  const compact = options.compact ?? (() => ({ messages: [SUMMARY], tokensBefore: 450000, tokensAfter: 2100 }))
  const submitted: string[] = []
  const received: { text: string; context: readonly string[] }[] = []
  const clears: string[] = []
  const logged: string[] = []
  const compactions: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: context.percent * 10000, window: 1000000, percent: context.percent },
      rateLimits: [],
    },
  }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({
    value: commands.map((name) => ({ name, description: '', source: 'user' as const })),
  }))
  on('command.run', ($, e) => {
    if (e.command !== 'clear') return { text: '' }
    clears.push(e.command)
    if (clear === 'refused') throw new Error('clear is not available here')
    return { text: '' }
  })
  on('fs.exists', () => ({ value: false }))
  // The mod's own prompts are submitted; the user's are received, with what rode on them
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin' || e.origin === undefined) submitted.push(e.text)
    else received.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, origin: e.origin }
  })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('session.compact', ($, e) => {
    compactions.push(e.instructions)
    return compact()
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  return { submitted, received, clears, logged, compactions, clock }
}

const TERMINAL = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

// The engine's /clear: the conversation ends, and the fresh one's SessionStart follows
async function cleared($: Engine) {
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
}

// Runs the session up to the end of the hand-off turn: the hand-off prompt is submitted[0]
async function handOff($: Engine, submitted: string[], reason: 'answer' | 'aborted' = 'answer') {
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2', reason))
}

const HANDOFF_NOW = {
  text: '/context-handoff-cli:handoff-now',
  origin: { kind: 'composer' },
  wait: false,
  command: { name: 'context-handoff-cli:handoff-now', args: '' },
} as const

const status = async ($: Engine) => (await $.command.run({ command: 'handoff-status' })).text ?? ''

test('past the threshold the mod records a hand-off, runs /clear, and resumes in the fresh session', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, clears, logged, compactions, clock } = wire($, on, context)

  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))

  // The hand-off prompt is submitted; nothing is cleared yet
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[context-handoff-cli]')
  expect(submitted[0]).toContain('45% full, past the 40%')
  expect(submitted[0]).toContain('HANDOFF.md')
  expect(submitted[0]).toContain('Do not run /clear yourself')
  expect(clears.length).toBe(0)

  // The hand-off turn runs and ends: a moment later /clear runs
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(clears.length).toBe(0)
  await clock.advance(300)
  expect(clears.length).toBe(1)

  // The conversation ends with the clear; the fresh one's SessionStart brings the resume
  await cleared($)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('This is a fresh session')
  expect(submitted[1]).toContain('HANDOFF.md')

  // The fresh session runs at a low context: nothing more happens
  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  await clock.advance(10000)
  expect(submitted.length).toBe(2)
  expect(clears.length).toBe(1)
  expect(compactions.length).toBe(0)

  expect(logged).toEqual([
    'context-handoff-cli: hand-off started: context at 45%, past 40%',
    'context-handoff-cli: the hand-off turn is running',
    'context-handoff-cli: hand-off recorded, starting a fresh session with /clear',
    'context-handoff-cli: the conversation was cleared; a fresh session starts',
    'context-handoff-cli: continuing from the notes in the fresh session',
  ])
})

test('in the fresh session the threshold counts again from scratch', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, clock } = wire($, on, context)
  await handOff($, submitted)
  await clock.advance(300)
  await cleared($)
  expect(submitted.length).toBe(2)

  // 41% is past the threshold; the step from the last hand-off (45 + 5) does not hold here
  context.percent = 41
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(3)
  expect(submitted[2]).toContain('41% full, past the 40%')
})

test('below the threshold nothing happens', async ($, on) => {
  const { submitted, clears, clock } = wire($, on, { percent: 39 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await clock.advance(10000)
  expect(submitted.length).toBe(0)
  expect(clears.length).toBe(0)
})

test('outside an interactive terminal session (-p, an SDK host, the desktop app) the mod does nothing', async ($, on) => {
  const { submitted, received, clears, clock } = wire($, on, { percent: 90 })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await clock.advance(10000)
  expect(submitted.length).toBe(0)
  expect(clears.length).toBe(0)
  expect(await status($)).toContain('Inactive: not an interactive terminal session.')

  // /handoff-now there records the notes and says no fresh session starts on its own
  await $.prompt.submit(HANDOFF_NOW)
  expect(received[0].context.at(-1)).toContain('works only in an interactive terminal session')
  await $.turn.start({ turnId: 't2', text: '/context-handoff-cli:handoff-now' })
  await $.turn.complete(turn('t2'))
  await clock.advance(10000)
  expect(clears.length).toBe(0)
})

test('a turn the user ran before the hand-off turn is left alone', async ($, on) => {
  const { submitted, clears, clock } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)

  // A message the user had queued runs first: it is not the hand-off turn
  await $.turn.start({ turnId: 't2', text: 'and the tests' })
  await $.turn.complete(turn('t2'))
  await clock.advance(1000)
  expect(clears.length).toBe(0)

  await $.turn.start({ turnId: 't3', text: submitted[0] })
  await $.turn.complete(turn('t3'))
  await clock.advance(300)
  expect(clears.length).toBe(1)
})

test('an interrupted hand-off is given up, and tried again once the context grew by the step', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, clears, logged, clock } = wire($, on, context)
  await handOff($, submitted, 'aborted')
  await clock.advance(10000)
  expect(clears.length).toBe(0)
  expect(logged.at(-1)).toBe('context-handoff-cli: gave up: the hand-off turn was interrupted')

  context.percent = 47
  await $.turn.start({ turnId: 't3', text: 'go on' })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(1)

  context.percent = 50
  await $.turn.start({ turnId: 't4', text: 'go on' })
  await $.turn.complete(turn('t4'))
  expect(submitted.length).toBe(2)
})

test('a hand-off turn that ends in an error is given up rather than cleared', async ($, on) => {
  const { submitted, clears, logged, clock } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2', 'error'))
  await clock.advance(10000)
  expect(clears.length).toBe(0)
  expect(logged.at(-1)).toBe('context-handoff-cli: gave up: the hand-off turn ended with error')
})

test("the project's close skill is run when the project has it", async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 }, { commands: ['session-close'] })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  expect(submitted[0]).toContain("Run this project's /session-close skill now")
  expect(submitted[0]).toContain('a fresh session then starts automatically')
})

test('a custom hand-off prompt and resume prompt are used', { options: { closePrompt: 'Wrap up at {percent}% of {threshold}%', resumePrompt: 'Go on from NOTES.md' } }, async ($, on) => {
  const { submitted, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  expect(submitted[0].startsWith('[context-handoff-cli] Wrap up at 45% of 40%')).toBe(true)
  await clock.advance(300)
  await cleared($)
  expect(submitted[1]).toBe('[context-handoff-cli] Go on from NOTES.md')
})

test('with the automatic hand-off off, only /handoff-now hands off, and runs /clear after its turn', { options: { enabled: false } }, async ($, on) => {
  const { submitted, received, clears, clock } = wire($, on, { percent: 90 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)

  await $.prompt.submit(HANDOFF_NOW)
  const instructions = received[0].context.at(-1) ?? ''
  expect(instructions).toContain("These are the /handoff-now instructions for this session's settings")
  expect(instructions).toContain('90% full; a hand-off was asked for with /handoff-now.')
  expect(instructions).toContain('Do not run /clear yourself')

  // The turn the user started is the hand-off turn
  await $.turn.start({ turnId: 't2', text: '/context-handoff-cli:handoff-now' })
  await $.turn.complete(turn('t2'))
  await clock.advance(300)
  expect(clears.length).toBe(1)
  await cleared($)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('This is a fresh session')
})

test('where only skill.prompt reaches the mod, /handoff-now still hands off', async ($, on) => {
  const { clears, clock } = wire($, on, { percent: 12 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: '/context-handoff-cli:handoff-now' })
  const { text } = await $.skill.prompt({ skill: 'context-handoff-cli:handoff-now', text: 'the static text' })
  expect(text.startsWith('[context-handoff-cli] The context window is 12% full; a hand-off was asked for with /handoff-now.')).toBe(true)

  // While one is in progress the skill says so; other skills, and context-handoff's own, pass through
  expect((await $.skill.prompt({ skill: 'handoff-now', text: 'the static text' })).text).toContain('already in progress (closing)')
  expect((await $.skill.prompt({ skill: 'commit', text: 'Commit it' })).text).toBe('Commit it')
  expect((await $.skill.prompt({ skill: 'context-handoff:handoff-now', text: 'theirs' })).text).toBe('theirs')

  await $.turn.complete(turn('t1'))
  await clock.advance(300)
  expect(clears.length).toBe(1)
})

test('/handoff-now while a hand-off runs is refused as it is submitted', async ($, on) => {
  wire($, on, { percent: 12 })
  await $.session.start(TERMINAL)
  await $.prompt.submit(HANDOFF_NOW)
  await $.turn.start({ turnId: 't1', text: '/context-handoff-cli:handoff-now' })
  const again = await $.prompt.submit(HANDOFF_NOW)
  expect(again).toEqual({ drop: 'context-handoff-cli: a hand-off is already in progress (closing)' })
})

test('a /clear the engine refuses is tried again, then the conversation is compacted here instead', async ($, on) => {
  const { submitted, clears, compactions, logged, clock } = wire($, on, { percent: 45 }, { clear: 'refused' })
  await handOff($, submitted)
  await clock.advance(300)
  expect(clears.length).toBe(1)
  await clock.advance(1500)
  expect(clears.length).toBe(2)
  await clock.advance(4000)
  expect(clears.length).toBe(3)

  // The fallback compacts, then the resume says so
  expect(compactions.length).toBe(0)
  await clock.advance(300)
  expect(compactions.length).toBe(1)
  expect(compactions[0]).toContain('Keep only')
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('The context was compacted after a hand-off')
  expect(logged).toContain('context-handoff-cli: compacted the conversation (450000 to 2100 tokens)')
})

test('a /clear that runs but ends no conversation falls back to the compaction', async ($, on) => {
  const { submitted, clears, compactions, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  await clock.advance(300)
  expect(clears.length).toBe(1)

  // No session.end follows within five seconds
  await clock.advance(5000)
  await clock.advance(300)
  expect(compactions.length).toBe(1)
  expect(submitted[1]).toContain('The context was compacted after a hand-off')
})

test('with the fallback off, a /clear that fails gives the hand-off up', { options: { fallback: 'none' } }, async ($, on) => {
  const { submitted, compactions, logged, clock } = wire($, on, { percent: 45 }, { clear: 'refused' })
  await handOff($, submitted)
  await clock.advance(300 + 1500 + 4000)
  await clock.advance(10000)
  expect(compactions.length).toBe(0)
  expect(submitted.length).toBe(1)
  expect(logged.at(-1)).toContain('context-handoff-cli: gave up: /clear could not be run')
})

test('a turn that starts before /clear is asked is let run, and the hand-off is recorded again after it', async ($, on) => {
  const { submitted, clears, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)

  // The user's waiting message starts at once, before the mod asks for /clear
  await $.turn.start({ turnId: 't3', text: 'also do this' })
  await clock.advance(1000)
  expect(clears.length).toBe(0)
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('[context-handoff-cli]')
  expect(submitted[1]).toContain('Record a hand-off')

  // The second hand-off turn ends and /clear runs then
  await $.turn.start({ turnId: 't4', text: submitted[1] })
  await $.turn.complete(turn('t4'))
  await clock.advance(300)
  expect(clears.length).toBe(1)
})

test('a message that runs after /clear was queued is passed to the fresh session', async ($, on) => {
  const { submitted, clears, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  await clock.advance(300)
  expect(clears.length).toBe(1)

  // The engine ran a waiting message before the queued /clear
  await $.turn.start({ turnId: 't3', text: 'rename the flag too' })
  await $.turn.complete(turn('t3'))
  await cleared($)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('This is a fresh session')
  expect(submitted[1]).toContain('"rename the flag too"')
})

test('when no SessionStart follows the clear, the resume is submitted by the timer, once', async ($, on) => {
  const { submitted, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  await clock.advance(300)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(submitted.length).toBe(1)
  await clock.advance(3000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('This is a fresh session')
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
})

test("the user's own /clear brings no resume, and turns the switches back to the option", async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  await $.command.run({ command: 'handoff-off' })
  expect(await status($)).toContain('Automatic hand-off: off for this conversation.')
  await cleared($)
  expect(submitted.length).toBe(0)
  expect(await status($)).toContain('Automatic hand-off: on.')
})

test('a /clear of the user while the notes are being written gives the hand-off up', async ($, on) => {
  const { submitted, logged, clock } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await cleared($)
  await clock.advance(10000)
  expect(submitted.length).toBe(1)
  expect(logged.at(-1)).toBe('context-handoff-cli: gave up: the conversation was cleared before the hand-off finished')
})

test('the turn of a message that asks to end the session starts no hand-off, and a later one does', async ($, on) => {
  const { submitted, logged } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  await $.prompt.submit({ text: '이제 세션 종료하자', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ turnId: 't1', text: '이제 세션 종료하자' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)
  expect(logged.at(-1)).toContain('this turn ends the session')

  await $.prompt.submit({ text: 'one more thing', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ turnId: 't2', text: 'one more thing' })
  await $.turn.complete(turn('t2'))
  expect(submitted.length).toBe(1)
})

test('/handoff-status tells the phase, the context, the switch, the fallback and what happened last', async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  expect(await status($)).toBe(
    'Phase: idle. Context: 45% (threshold 40%). Automatic hand-off: on. Fallback: compact. Last: nothing yet.',
  )
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  const during = await status($)
  expect(during).toContain('Phase: closing.')
  expect(during).toContain('Last: hand-off started: context at 45%, past 40%.')
})

test('/handoff-off stops the automatic hand-off and /handoff-on starts it again', async ($, on) => {
  const { submitted, clears, clock } = wire($, on, { percent: 45 })
  await $.session.start(TERMINAL)
  const off = await $.command.run({ command: 'handoff-off' })
  expect(off.text).toContain('Automatic hand-off is off for this conversation.')
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)

  const on_ = await $.command.run({ command: 'handoff-on' })
  expect(on_.text).toContain('the next turn to end past 40% starts it')
  await $.turn.start({ turnId: 't2', text: 'hello' })
  await $.turn.complete(turn('t2'))
  expect(submitted.length).toBe(1)
  await $.turn.start({ turnId: 't3', text: submitted[0] })
  await $.turn.complete(turn('t3'))
  await clock.advance(300)
  expect(clears.length).toBe(1)
})
