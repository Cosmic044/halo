import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { HaloCache, HaloMeter, HaloNext, HaloPrefs, HaloTtl, HaloWindow } from '../types'
import { BIG, H, describe, dockColor, hud, ringsOf } from './svg'
import type { Rings } from './svg'

const MIN = 60_000
const TTL: Record<Exclude<HaloTtl, 'auto'>, number> = { '5m': 5 * MIN, '1h': 60 * MIN }

const cacheA = atom({ plugin: 'halo', key: 'cache' } as const, {
  lastAt: 0,
  hit: 0,
  tokens: 0,
  ttlMs: TTL['1h'],
  isLive: false,
})
const meterA = atom({ plugin: 'halo', key: 'meter' } as const, {
  five: null,
  seven: null,
  fable: null,
  ctxPct: null,
  ctxTokens: null,
  window: 200_000,
  usd: null,
})
const burnA = atom({ plugin: 'halo', key: 'burn' } as const, [])
const nextA = atom({ plugin: 'halo', key: 'next' } as const, [])
const prefsA = atom({ plugin: 'halo', key: 'prefs' } as const, {
  isHidden: false,
  hasChips: true,
  ttl: 'auto',
})
const tickA = atom({ plugin: 'halo', key: 'tick' } as const, 0)
const coldSoonA = atom({ plugin: 'halo', key: 'isColdSoon' } as const, false)
const partyA = atom({ plugin: 'halo', key: 'partyAt' } as const, 0)
const compactingA = atom({ plugin: 'halo', key: 'isCompacting' } as const, false)

// Claude Code hands a plugin only the 5-hour and 7-day windows, as of this
// session's last reply, so they stand still between messages while other
// sessions spend the same limits. Cosmic Pulse's status line asks the usage
// server itself about every two minutes and caches the answer, Fable week
// included, at ~/.cosmic-pulse/claude/usage-cache.json. Halo polls that file and
// draws the server's numbers while they are fresh; without it, the engine's
// numbers and a dotted outer ring.
type Pulse = { five: HaloWindow | null; seven: HaloWindow | null; fable: HaloWindow | null; at: number }
const PULSE_FRESH = 10 * MIN
let pulse: Pulse | null = null
// The engine's own meter, kept so a poll can merge the file over it.
let engineMeter: HaloMeter | null = null

async function readPulse($: EngineInterface) {
  const home = $.plugin.root.split(/[\\/]\.claude[\\/]/)[0]
  if (!home || home === $.plugin.root) return
  try {
    const cache = JSON.parse(await $.fs.read(`${home}/.cosmic-pulse/claude/usage-cache.json`)) as {
      windows?: unknown
      fetchedAt?: unknown
    }
    const list = Array.isArray(cache.windows)
      ? (cache.windows as { id?: unknown; usedPercent?: unknown; resetsAt?: unknown }[])
      : []
    const of = (id: string): HaloWindow | null => {
      const w = list.find(x => x.id === id)
      return w && typeof w.usedPercent === 'number'
        ? { pct: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null }
        : null
    }
    pulse = {
      five: of('five_hour'),
      seven: of('seven_day'),
      fable: of('seven_day_fable'),
      at: typeof cache.fetchedAt === 'number' ? cache.fetchedAt : 0,
    }
  } catch {
    pulse = null
  }
}

/** Draws `m` with the usage server's windows over it while Cosmic Pulse's fetch is fresh; redraws only on a change. */
async function showMeter($: EngineInterface, m: HaloMeter) {
  engineMeter = m
  await readPulse($)
  const now = await $.clock.now()
  const p = pulse && now - pulse.at < PULSE_FRESH ? pulse : null
  const shown: HaloMeter = {
    ...m,
    five: p?.five ?? m.five,
    seven: p?.seven ?? m.seven,
    fable: m.fable ?? p?.fable ?? pulse?.fable ?? null,
  }
  if (JSON.stringify(shown) !== JSON.stringify(await read($, meterA))) await update($, meterA, () => shown)
}

const windowOf = (limits: readonly SessionRateLimit[], kind: string): HaloWindow | null => {
  const w = limits.find(l => l.kind === kind)
  if (!w) return null
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return { pct: w.percentUsed, resetsAt: Number.isNaN(at) ? null : at }
}

const meterOf = (u: {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly SessionRateLimit[]
  cost?: { usd: number }
}): HaloMeter => ({
  five: windowOf(u.rateLimits, 'five_hour'),
  seven: windowOf(u.rateLimits, 'seven_day'),
  fable: windowOf(u.rateLimits, 'seven_day_fable'),
  ctxPct: u.context.percent ?? null,
  ctxTokens: u.context.tokens ?? null,
  window: u.context.window,
  usd: u.cost?.usd ?? null,
})

/** Pulls the first JSON array of `{ label, prompt }` out of a model reply. */
export const parseChips = (text: string): HaloNext[] => {
  const raw = text.match(/\[[\s\S]*\]/)?.[0]
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (c): c is HaloNext =>
          typeof c === 'object' && c !== null && typeof c.label === 'string' && typeof c.prompt === 'string',
      )
      .map(c => ({ label: c.label.trim().replace(/\.$/, '').slice(0, 42), prompt: c.prompt.trim() }))
      .filter(c => c.label && c.prompt)
      .slice(0, 3)
  } catch {
    return []
  }
}

const SYSTEM =
  'You predict the next message a developer sends to their coding agent. Answer with a JSON array only, no prose.'

const askFor = (ask: string, answer: string) =>
  `The developer wrote:\n<ask>${ask.slice(-1500)}</ask>\n\nThe agent replied:\n<reply>${answer.slice(-3500)}</reply>\n\n` +
  'Give the 3 messages the developer is most likely to send next, most likely first. ' +
  'Each is {"label": 2-5 words, imperative, no trailing period, "prompt": the full message in the first person, one or two sentences, specific to this work}. ' +
  'If the reply ends with a question for the developer, make the options answers to it. ' +
  'Reply with only: [{"label":"...","prompt":"..."}, ...]'

// Module state restarts on a reload: only drawing hints, a turn counter and
// timers live here; everything drawn from is in $.state.
let drawn: Rings = { five: 0, seven: 0 }
let drawnBurn = 0
let usdMark: number | null = null
let gen = 0
let warnTimer: Timer | null = null
let coldTimer: Timer | null = null

// What the engine asked of us, for `/halo debug`: which surfaces attached and
// which drew. Empty `surfaces` means nothing on screen can draw a mod's band.
const diag = {
  loadedAt: 0,
  surfaces: [] as string[],
  attached: [] as string[],
  renders: {} as Record<string, { count: number; lastAt: number; svgChars: number }>,
  errors: [] as string[],
  compacts: [] as string[],
}
let isLite = false


async function ttlFor($: EngineInterface): Promise<number> {
  const { ttl } = await read($, prefsA)
  if (ttl !== 'auto') return TTL[ttl]
  const learned = await $.store.get('halo.learnedTtl')
  return learned === '5m' ? TTL['5m'] : TTL['1h']
}

async function savePrefs($: EngineInterface, fn: (p: HaloPrefs) => HaloPrefs) {
  await update($, prefsA, fn)
  await $.store.set('halo.prefs', await read($, prefsA))
}

async function refreshMeter($: EngineInterface) {
  const u = await $.session.usage()
  await showMeter($, meterOf(u))
  return u
}

/** Arms the "cooling soon" toast and the redraw at expiry for an idle cache. */
async function armTimers($: EngineInterface) {
  warnTimer?.cancel()
  coldTimer?.cancel()
  await update($, coldSoonA, () => false)
  const c = await read($, cacheA)
  if (!c.lastAt) return
  const now = await $.clock.now()
  const lead = c.ttlMs >= 30 * MIN ? 5 * MIN : MIN
  const left = c.lastAt + c.ttlMs - now
  warnTimer = $.clock.after(Math.max(0, left - lead), () => {
    void (async () => {
      await update($, coldSoonA, () => true)
      const cur = await read($, cacheA)
      if (cur.tokens >= BIG && !cur.isLive) {
        $.ui.toast(
          `Cache cools in ${Math.round(lead / MIN)}m · ~${Math.round(cur.tokens / 1000)}k tokens to re-cache. Reply now, or press Compact.`,
          { timeoutMs: 8000 },
        )
      }
    })()
  })
  coldTimer = $.clock.after(Math.max(0, left + 500), () => {
    void update($, tickA, n => n + 1)
  })
}

// A press's dispatch ends, and aborts what it started, long before a
// compaction finishes (clearing the chips alone redraws the band and ends it),
// so Compact runs from a timer, outside the press, and says how it went.
// It runs /compact as if typed: $.session.compact is refused outright in a
// desktop (SDK) session, where compaction runs inside a turn of its own.
const startCompact = ($: EngineInterface) => {
  $.clock.after(0, () => void runCompact($))
}

async function runCompact($: EngineInterface) {
  const at = await $.clock.now()
  const note = (s: string) => diag.compacts.push(`${new Date(at).toISOString()} ${s}`.slice(0, 300))
  if (await read($, compactingA)) {
    $.ui.toast('Already compacting…', { timeoutMs: 3000 })
    return
  }
  await update($, compactingA, () => true)
  note('requested')
  // A compaction that never answers must not hold the button forever.
  const watchdog = $.clock.after(5 * MIN, () => {
    void (async () => {
      if (!(await read($, compactingA))) return
      note('no answer after 5 minutes')
      await update($, compactingA, () => false)
      $.ui.toast('Compact has not answered in 5 minutes. Try /compact.', { timeoutMs: 8000 })
    })()
  })
  $.ui.toast('Compacting the conversation…', { timeoutMs: 6000 })
  try {
    // The session.compact hook frees the button and says how it went; this
    // answer may never come back (a compaction can reload the module), and
    // speaks only when no compaction ran (an error the command printed).
    const r = await $.command.run({ command: 'compact' })
    await update($, nextA, () => [])
    note(`ran /compact${r.text ? `: ${r.text}` : ''}`)
    if (await read($, compactingA)) $.ui.toast(r.text ? r.text.slice(0, 160) : 'Compacted.', { timeoutMs: 5000 })
  } catch (err) {
    note(`failed: ${String(err)}`)
    $.ui.toast(`Compact failed: ${String(err)}`.slice(0, 200), { timeoutMs: 8000 })
  } finally {
    watchdog.cancel()
    await update($, compactingA, () => false)
  }
}

async function suggest($: EngineInterface, answer: string, mine: number) {
  const rows = await $.session.messages()
  const ask = [...rows].reverse().find(r => r.role === 'user' && r.text.trim())?.text ?? ''
  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: askFor(ask, answer),
    maxTokens: 500,
    effort: 'low',
    timeoutMs: 20_000,
  })
  if (!r.isAnswered || mine !== gen) return
  const chips = parseChips(r.text)
  if (chips.length) await update($, nextA, () => chips)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    diag.loadedAt = await $.clock.now()
    diag.surfaces = [...(await $.session.surfaces())]
    await $.command.register({
      name: 'halo',
      description: "Halo HUD · /halo shows or hides it · /halo theme violet|black · /halo next on|off · /halo ttl auto|5m|1h · /halo debug",
      argumentHint: '[theme violet|black | next on|off | ttl auto|5m|1h]',
    })
    const saved = await $.store.get('halo.prefs')
    if (saved && typeof saved === 'object') {
      await update($, prefsA, p => ({ ...p, ...(saved as Partial<HaloPrefs>) }))
    }
    const ttlMs = await ttlFor($)
    await update($, cacheA, c => ({ ...c, ttlMs }))
    // A fresh load has no compaction of its own running; a flag left by the
    // last load (reloaded mid-compaction) would hold Compact on "Compacting…".
    await update($, compactingA, () => false)
    const u = await refreshMeter($)
    usdMark = u.cost?.usd ?? null
    // Re-sync the self-running SVG every five minutes (a hidden window may
    // pause its animation clock); a redraw costs no tokens.
    $.clock.every(5 * MIN, () => void update($, tickA, n => n + 1))
    // Between messages, follow the usage server through Cosmic Pulse's cache.
    $.clock.every(30_000, () => void (engineMeter && showMeter($, engineMeter)))
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    diag.attached.push(`${e.surface} ${e.clientId}`)
    diag.surfaces = [...(await $.session.surfaces())]
    return next(e)
  })

  on('command.run', { command: 'halo' }, async ($, e) => {
    const [what, value] = e.args.trim().toLowerCase().split(/\s+/)
    if (what === 'debug') {
      diag.surfaces = [...(await $.session.surfaces())]
        const hint = diag.surfaces.length
        ? ''
        : '\nNo screen is attached to this session, so nothing can draw the band. Run Halo in a session on your own computer (see the README).'
      return { text: `Halo debug\n${JSON.stringify(diag, null, 2)}${hint}` }
    }
    if (what === 'lite') {
      isLite = !isLite
      return { text: `Halo lite mode ${isLite ? 'on: plain text, no SVG' : 'off'}.` }
    }
    if (!what) {
      await savePrefs($, p => ({ ...p, isHidden: !p.isHidden }))
      return { text: (await read($, prefsA)).isHidden ? 'Halo hidden. /halo brings it back.' : 'Halo shown.' }
    }
    if (what === 'next' && (value === 'on' || value === 'off')) {
      await savePrefs($, p => ({ ...p, hasChips: value === 'on' }))
      if (value === 'off') await update($, nextA, () => [])
      return { text: `Next-step chips ${value}.` }
    }
    if (what === 'theme' && (value === 'violet' || value === 'black')) {
      await savePrefs($, p => ({ ...p, theme: value }))
      return { text: value === 'black' ? 'Halo: matte black.' : 'Halo: violet.' }
    }
    if (what === 'ttl' && (value === 'auto' || value === '5m' || value === '1h')) {
      await savePrefs($, p => ({ ...p, ttl: value }))
      const ttlMs = await ttlFor($)
      await update($, cacheA, c => ({ ...c, ttlMs }))
      await armTimers($)
      return { text: `Cache TTL: ${value}${value === 'auto' ? ` (now ${ttlMs === TTL['5m'] ? '5m' : '1h'})` : ''}.` }
    }
    return { text: 'Usage: /halo · /halo theme violet|black · /halo next on|off · /halo ttl auto|5m|1h' }
  })

  on('session.measure', async ($, e, next) => {
    await showMeter($, meterOf(e))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    gen += 1
    await update($, nextA, () => [])
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    warnTimer?.cancel()
    coldTimer?.cancel()
    await update($, coldSoonA, () => false)
    await update($, cacheA, c => ({ ...c, isLive: true }))
    return next(e)
  })

  // Every main-thread request refreshes the cache: read its hit rate, and on
  // a turn's first request after a long gap, learn which TTL the cache has.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId === undefined && u) {
      const now = await $.clock.now()
      const sent = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const hit = sent ? u.cache_read_input_tokens / sent : 0
      const prev = await read($, cacheA)
      const gap = now - prev.lastAt
      if (e.index === 0 && prev.lastAt && sent > 4000 && gap > 5.5 * MIN && gap < 58 * MIN) {
        const learned = hit > 0.6 ? '1h' : hit < 0.15 ? '5m' : null
        if (learned) await $.store.set('halo.learnedTtl', learned)
      }
      const ttlMs = await ttlFor($)
      await update($, cacheA, c => ({
        ...c,
        lastAt: now,
        hit,
        tokens: sent + u.output_tokens,
        ttlMs,
      }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const now = await $.clock.now()
    await update($, cacheA, c => ({ ...c, isLive: false, lastAt: c.lastAt ? now : 0 }))
    const u = await refreshMeter($)
    const usd = u.cost?.usd
    if (usd !== undefined) {
      const spent = usdMark === null ? 0 : usd - usdMark
      usdMark = usd
      if (spent > 0) await update($, burnA, list => [...list, spent].slice(-24))
    }
    await armTimers($)
    if (e.reason === 'answer') await update($, partyA, () => now)
    const { hasChips } = await read($, prefsA)
    if (hasChips && e.reason === 'answer' && e.answer.trim()) {
      const mine = gen
      const answer = e.answer
      // A timer runs outside this dispatch, so the turn ends without waiting.
      $.clock.after(0, () => void suggest($, answer, mine))
    }
    return done
  })

  // A precompute installs nothing; only a compaction that ran resets the band.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute') {
      // Whoever started it, a compaction that has run frees Compact.
      if (await read($, compactingA)) {
        await update($, compactingA, () => false)
        const k = (n: number) => `${Math.round(n / 1000)}k`
        const sizes = done.messages !== undefined && done.tokensBefore && done.tokensAfter ?`: ${k(done.tokensBefore)} → ${k(done.tokensAfter)} tokens` : ''
        const at = await $.clock.now()
        diag.compacts.push(`${new Date(at).toISOString()} ${done.skip ? `skipped: ${done.skip}` : `compacted${sizes}`}`.slice(0, 300))
        $.ui.toast(done.skip ? `Compact skipped: ${done.skip}`.slice(0, 200) : `Compacted${sizes}.`, { timeoutMs: 5000 })
      }
      if (done.skip) return done
      warnTimer?.cancel()
      coldTimer?.cancel()
      await update($, coldSoonA, () => false)
      await update($, cacheA, c => ({ ...c, lastAt: 0, hit: 0, tokens: 0 }))
      await refreshMeter($)
      const at = await $.clock.now()
      await update($, partyA, () => at)
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seen = (diag.renders[e.surface] ??= { count: 0, lastAt: 0, svgChars: 0 })
    seen.count += 1
    seen.lastAt = await $.clock.now()
    try {
      return await drawBand($, e, next)
    } catch (err) {
      diag.errors.push(`render (${e.surface}): ${String(err)}`.slice(0, 300))
        return next(e)
    }
  })
}

const drawBand = async (
  $: EngineInterface,
  e: RenderInput<'AbovePrompt'>,
  next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>,
) => {
    const prefs = await read($, prefsA)
    if (e.props.hasSurvey || prefs.isHidden) return next(e)

    await read($, tickA)
    const cache: HaloCache = await read($, cacheA)
    const meter = await read($, meterA)
    const burn = await read($, burnA)
    const chips = await read($, nextA)
    const isColdSoon = await read($, coldSoonA)
    const partyAt = await read($, partyA)
    const now = await $.clock.now()
    const isWorking = e.props.isWorking
    const summary = describe({ now, cache, meter, isWorking })
    const { Button } = $.ui.resolve(e)

    const compact = () => startCompact($)
    const isCold = !isWorking && !cache.isLive && cache.lastAt > 0 && cache.lastAt + cache.ttlMs <= now
    const isFull = (meter.ctxPct ?? 0) >= 80
    // Compact is always at hand once there is a conversation; it only begs
    // (primary, and the strip's launch pad lights up) when it pays off.
    const hasCompact = !isWorking && Math.max(cache.tokens, meter.ctxTokens ?? 0) >= 5_000
    const isUrgent = hasCompact && (isFull || (cache.tokens >= BIG && (isColdSoon || isCold)))
    const compactButton = hasCompact && (
      <Button
        key="compact"
        hotkey="c"
        variant={isUrgent ? 'primary' : 'secondary'}
        dimColor={!isUrgent}
        label={isUrgent ? 'Compact now' : 'Compact'}
        onPress={compact}
      />
    )

    const fill = (c: HaloNext) => async () => {
      await $.prompt.fill({ text: c.prompt })
      await update($, nextA, () => [])
    }

    if (isLite && e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text>◎ Halo lite · {summary || 'waiting for the first reply'}</Text>
          {compactButton}
        </Box>
      )
    }
    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text dimColor>◎ {summary || 'halo'}</Text>
          {chips.map((c, k) => (
            <Button key={`next-${k}`} hotkey={String(k + 1)} plain label={c.label} onPress={fill(c)} />
          ))}
          {compactButton}
        </Box>
      )
    }

    const { Box, Svg } = $.ui.resolve(e)
    // The banner sizes itself (width 100%, a fixed height, no viewBox), so it
    // spans the band exactly. bodyColumns 8px cells run a little under the real
    // width (94 ≈ 750px, 93 ≈ 762px): the layout floor, its right side hung
    // from the right edge.
    // Compact lives in a dock at the banner's right end: a Box in the row
    // beside it, filled with the colour the banner fades into, so the two read
    // as one. (Laid over the banner in an absolute Box, the Button never got
    // the press: the pointer on an absolute Box is its parent's.) It stays put
    // through a turn and a compaction, dim, so nothing ever shifts.
    const isCompacting = await read($, compactingA)
    const stripW = Math.max(240, e.props.bodyColumns * 8 - 4 - (isUrgent ? 132 : 100))
    const room = 20
    const slot = isCompacting ? (
      <Button key="compact" hotkey="c" plain dimColor label="Compacting…"
        onPress={() => $.ui.toast('Already compacting…', { timeoutMs: 3000 })} />
    ) : isWorking ? (
      <Button key="compact" hotkey="c" plain dimColor label="Compact"
        onPress={() => $.ui.toast('Compact once this turn finishes.', { timeoutMs: 3000 })} />
    ) : isUrgent ? (
      <Button key="compact" hotkey="c" variant="primary" label="Compact now" onPress={compact} />
    ) : (
      <Button key="compact" hotkey="c" plain label="Compact" onPress={compact} />
    )
    const panel = dockColor(prefs.theme, isCold)
    const hasTray = chips.length > 0
    const rings = ringsOf(meter)
    const source = hud({
      now,
      cache,
      meter,
      burn,
      isWorking,
      from: drawn,
      isNewBurn: burn.length !== drawnBurn,
      celebrateAt: partyAt || null,
      isUrgent: isFull,
      width: stripW,
      room,
      theme: prefs.theme ?? 'violet',
      dock: true,
      tray: hasTray,
    })
    drawn = rings
    drawnBurn = burn.length
    ;(diag.renders[e.surface] ??= { count: 0, lastAt: 0, svgChars: 0 }).svgChars = source.length

    // One panel in the dock's colour: the banner, and under it, only while there
    // are some, the chips, with Compact's dock running down beside both. The
    // banner melts its right end and (over chips) its bottom edge into that
    // colour. The Svg sits straight in a column Box with only its height given:
    // straight in a row Box the desktop frame falls back to 300 x 150.
    return (
      <Box key="banner" flexDirection="row" alignItems="stretch" width="100%" backgroundColor={panel}>
        <Box key="strip" flexDirection="column" flexGrow={1} backgroundColor={panel}>
          <Svg source={source} alt={summary || 'Halo: waiting for the first reply'} height={H} isInteractive />
          {hasTray && (
            <Box
              key="chips"
              flexDirection="row"
              alignItems="center"
              columnGap={1}
              flexWrap="wrap"
              paddingX={1}
              backgroundColor={panel}
            >
              {chips.map((c, k) => (
                <Button key={`next-${k}`} hotkey={String(k + 1)} plain label={c.label} onPress={fill(c)} />
              ))}
              <Button
                key="next-dismiss"
                hotkey="0"
                plain
                dimColor
                role="dismiss"
                label="Dismiss"
                onPress={() => update($, nextA, () => [])}
              />
            </Box>
          )}
        </Box>
        <Box key="dock" flexDirection="row" alignItems="center" paddingX={1} backgroundColor={panel}>
          {slot}
        </Box>
      </Box>
    )
}
