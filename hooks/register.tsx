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
import { BIG, H, describe, hud, ringsOf } from './svg'
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

// Claude Code hands a plugin only the 5-hour and 7-day windows. The Fable week
// comes from Cosmic Pulse, whose status line caches the usage endpoint at
// ~/.cosmic-pulse/claude/usage-cache.json; without it the outer ring is dotted.
let fableWindow: HaloWindow | null = null

async function readFable($: EngineInterface) {
  const home = $.plugin.root.split(/[\\/]\.claude[\\/]/)[0]
  if (!home || home === $.plugin.root) return
  try {
    const cache: unknown = JSON.parse(await $.fs.read(`${home}/.cosmic-pulse/claude/usage-cache.json`))
    const list = (cache as { windows?: unknown }).windows
    const w = Array.isArray(list)
      ? (list as { id?: unknown; usedPercent?: unknown; resetsAt?: unknown }[]).find(x => x.id === 'seven_day_fable')
      : undefined
    fableWindow =
      w && typeof w.usedPercent === 'number'
        ? { pct: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null }
        : null
  } catch {
    fableWindow = null
  }
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
  fable: windowOf(u.rateLimits, 'seven_day_fable') ?? fableWindow,
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
  await readFable($)
  const u = await $.session.usage()
  await update($, meterA, () => meterOf(u))
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
    const u = await refreshMeter($)
    usdMark = u.cost?.usd ?? null
    // Re-sync the self-running SVG every five minutes (a hidden window may
    // pause its animation clock); a redraw costs no tokens.
    $.clock.every(5 * MIN, () => void update($, tickA, n => n + 1))
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
    await readFable($)
    await update($, meterA, () => meterOf(e))
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

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
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

    const compact = async () => {
      await update($, nextA, () => [])
      await $.session.compact({})
    }
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
    const stripW = Math.max(240, e.props.bodyColumns * 8 - 4)
    // Compact lives in the banner's right end, laid over a slot the SVG leaves
    // clear. It stays put through a turn, dim, so nothing ever shifts.
    const room = isUrgent ? 132 : 100
    const slot = isWorking ? (
      <Button
        key="compact"
        hotkey="c"
        plain
        dimColor
        label="Compact"
        onPress={() => $.ui.toast('Compact once this turn finishes.', { timeoutMs: 3000 })}
      />
    ) : (
      <Button
        key="compact"
        hotkey="c"
        plain={isUrgent ? undefined : true}
        variant={isUrgent ? 'primary' : undefined}
        label={isUrgent ? 'Compact now' : 'Compact'}
        onPress={compact}
      />
    )
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
    })
    drawn = rings
    drawnBurn = burn.length
    ;(diag.renders[e.surface] ??= { count: 0, lastAt: 0, svgChars: 0 }).svgChars = source.length

    // One banner across the band, Compact inside its right end; the chips get
    // a row under it only while there are some. The Svg sits straight in a
    // column Box with only its height given: in a row Box (a bare Box is one)
    // the desktop frame falls back to 300 x 150.
    return (
      <Box flexDirection="column" rowGap={0}>
        <Box key="banner" flexDirection="column" width="100%">
          <Svg source={source} alt={summary || 'Halo: waiting for the first reply'} height={H} isInteractive />
          <Box key="slot" position="absolute" top={0} bottom={0} right={1} flexDirection="row" alignItems="center">
            {slot}
          </Box>
        </Box>
        {chips.length > 0 && (
          <Box key="chips" flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
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
    )
}
