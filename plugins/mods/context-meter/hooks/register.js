// The latest measurement, shared by the hooks below
let usage = null
// Context tokens when the current turn began, and whether that turn is still running
let turnBase = null
let turnOpen = false
// Context tokens the last finished turn added
let lastDelta = null
// The branch the session's directory is on, null outside a git repository
let branch = null
// The session's model, as /model shows it
let model = null
// The effort the session's last model request asked for, null before the first one or on a model that takes none
let effort = null

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Which segments to show, from the options plugin.json declares
function shownSegments(options) {
  return {
    branch: options.showBranch !== false,
    dirty: options.showDirty === true,
    model: options.showModel === true,
    effort: options.showEffort === true,
    context: options.showContext !== false,
    lastTurn: options.showLastTurn !== false,
    fiveHour: options.showFiveHour !== false,
    weekly: options.showWeekly !== false,
    otherLimits: options.showOtherLimits !== false,
    resets: options.showResetTimes !== false,
    cost: options.showCost === true,
  }
}

// 12345 -> "12.3k", 150236 -> "150k", 1000000 -> "1M"
function formatTokens(n) {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const [value, unit] = abs < 999500 ? [n / 1000, 'k'] : [n / 1000000, 'M']
  return (Math.abs(value) < 100 ? Number(value.toFixed(1)) : Math.round(value)) + unit
}

// A negative delta means the turn compacted the conversation
function formatDelta(n) {
  if (n === 0) return '±0'
  return (n > 0 ? '+' : '−') + formatTokens(Math.abs(n))
}

function contextPercent(context) {
  if (typeof context.percent === 'number') return context.percent
  return context.window > 0 ? (context.tokens / context.window) * 100 : 0
}

// The plan limit kinds Claude Code reports: the label drawn, and the segment that shows it
const LIMITS = {
  five_hour: { label: '5H', segment: 'fiveHour' },
  seven_day: { label: '1W', segment: 'weekly' },
  spend_limit: { label: 'Spend', segment: 'otherLimits' },
}

// One plan limit as the band draws it. An unknown kind is shown as it is, with the other limits.
function limitOf(raw) {
  // Round to the minute, so a reset at 12:29:59 reads 12:30
  const ms = raw.resetsAt ? Math.round(new Date(raw.resetsAt).getTime() / 60000) * 60000 : NaN
  const { label, segment } = LIMITS[raw.kind] ?? { label: String(raw.kind), segment: 'otherLimits' }
  return {
    label,
    segment,
    percent: raw.percentUsed,
    resetsAt: Number.isNaN(ms) ? null : new Date(ms),
  }
}

// "12:30" for a reset within a day, "Wed 11:00" for one further off
function formatReset(date, now) {
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  return date.getTime() - now < 24 * 60 * 60 * 1000 ? time : DAYS[date.getDay()] + ' ' + time
}

// The segments in the order they are drawn. A segment with a percent is colored by it.
function segments(shown, hasRoom, now) {
  const { context, rateLimits, cost } = usage
  const parts = []
  if (shown.branch && branch) parts.push({ text: branch })
  if (shown.model && model) parts.push({ text: model })
  if (shown.effort && effort !== null) parts.push({ text: 'Effort ' + effort })
  if (shown.context) {
    // The fill is absent until the first response reports one
    const isFilled = typeof context.tokens === 'number'
    const percent = isFilled ? contextPercent(context) : undefined
    const fill = isFilled ? `${Math.round(percent)}% (${formatTokens(context.tokens)}` : '– (–'
    parts.push({ text: `Ctx ${fill}/${formatTokens(context.window)})`, percent })
  }
  if (shown.lastTurn) parts.push({ text: 'Last ' + (lastDelta === null ? '–' : formatDelta(lastDelta)) })
  for (const limit of rateLimits.map(limitOf)) {
    if (!shown[limit.segment]) continue
    const reset = shown.resets && hasRoom && limit.resetsAt ? ' ↻' + formatReset(limit.resetsAt, now) : ''
    parts.push({ text: `${limit.label} ${Math.round(limit.percent)}%${reset}`, percent: limit.percent })
  }
  // Absent where Claude Code keeps no cost ledger
  if (shown.cost && cost) parts.push({ text: '$' + cost.usd.toFixed(2) })
  return parts
}

// Text props for how full something is: plain, then yellow, then bold red
function tone(percent) {
  if (typeof percent !== 'number' || percent < 70) return {}
  return percent < 90 ? { color: 'yellow' } : { color: 'red', bold: true }
}

// Run git in the session's directory. Resolves to what it printed, or null when it failed.
async function git($, ...args) {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

// Read the branch again and ask for a redraw. A branch with uncommitted changes gets a `*`.
async function readBranch($, shown) {
  if (!shown.branch) return
  let name = await git($, 'branch', '--show-current')
  // A detached HEAD has no branch name, so show its commit
  if (name === '') name = await git($, 'rev-parse', '--short', 'HEAD')
  const isDirty = Boolean(name) && shown.dirty && Boolean(await git($, 'status', '--porcelain'))
  branch = name ? name + (isDirty ? '*' : '') : null
  $.ui.invalidate('ui.render')
}

// Read the figures again and ask for a redraw. A failed read keeps the last figures.
async function measure($, shown) {
  try {
    usage = await $.session.usage()
    if (shown.model) model = await $.session.model()
  } catch {
    return
  }
  // Once the turn has ended, what it added is the difference from where it began
  const { tokens } = usage.context
  if (!turnOpen && turnBase !== null && typeof tokens === 'number') lastDelta = tokens - turnBase
  $.ui.invalidate('ui.render')
}

export function register(on, options) {
  const shown = shownSegments(options)

  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-meter',
      description: 'Show context usage, what the last turn added, and plan limit usage',
      immediate: true,
    })
    await readBranch($, shown)
    await measure($, shown)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // You may have switched branches since the last turn
    await readBranch($, shown)
    await measure($, shown)
    // Before the first response nothing is in the window yet
    if (usage) turnBase = usage.context.tokens ?? 0
    turnOpen = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    turnOpen = false
    // The turn may have switched branches or changed files
    await readBranch($, shown)
    await measure($, shown)
    return next(e)
  })

  // The effort is carried by each model request, so it is read there. A subagent's requests are left out.
  if (shown.effort) {
    on('turn.step', async function* ($, e, next) {
      const asked = e.effort ?? null
      if (!e.agentId && asked !== effort) {
        effort = asked
        $.ui.invalidate('ui.render')
      }
      return yield* next(e)
    })
  }

  // Fires after each turn, and when a plan limit's percent used changes
  on('session.measure', async ($, e, next) => {
    await measure($, shown)
    return next(e)
  })

  // The same line as text, for apps that don't draw the band
  on('command.run', { command: 'context-meter' }, async ($) => {
    await readBranch($, shown)
    await measure($, shown)
    if (!usage) return { text: 'No usage reading yet' }
    const text = segments(shown, true, Date.now())
      .map((part) => part.text)
      .join(' · ')
    return { text: text || 'Every segment is turned off' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Keep what the mods after this one draw in the band
    const theirs = await next(e)
    // Stay out of the way of a survey, and draw nothing before the first reading
    if (!usage || e.props.hasSurvey) return theirs
    // The reset times fit only in a wide band
    const parts = segments(shown, (e.props.bodyColumns ?? 0) >= 100, Date.now())
    if (parts.length === 0) return theirs
    const { Box, Text } = $.ui.resolve(e)
    const row = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: parts.map((part) => Text({ ...tone(part.percent), children: [part.text] })),
    })
    return theirs ? Box({ flexDirection: 'column', children: [row, theirs] }) : row
  })
}
