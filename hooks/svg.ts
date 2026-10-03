import type { HaloCache, HaloMeter, HaloTheme, HaloWindow } from '../types'

// The HUD is one self-animating SVG. SMIL drives everything between events:
// the fuse burns and recolours itself, the countdown ticks, the mascot changes
// mood on schedule (idle → alarm → asleep in the snow), and one-shot effects
// are timed from absolute event times, so a redraw resumes them mid-flight
// (negative `begin`) instead of replaying them.

/** The narrowest strip, and the width its fixed sections were laid out at. */
export const W = 476
export const H = 52
/** Everything but the dial and the backdrop was laid out in a 44px band; it sits centred in H. */
const CH = 44
const OY = (H - CH) / 2

// The width this draw lays out at: hud() sets it, as it resets waveIds, so the
// helpers below span the whole strip however wide the band is.
let SW = W

/** The banner's corner radius, and the inset that keeps the ring and mascot off its edges. */
const R = 6
const PAD = 8

export type Rings = { five: number; seven: number; fable?: number }

export type HudInput = {
  now: number
  cache: HaloCache
  meter: HaloMeter
  burn: readonly number[]
  isWorking: boolean
  /** Ring fractions drawn last time; rings sweep from these to the new ones. */
  from: Rings
  /** Whether the newest sparkline bar arrived since the last draw. */
  isNewBurn: boolean
  /** When the last turn finished or a compaction landed: the party's start. */
  celebrateAt?: number | null
  /** Compacting is worth it right now, whatever the cache does next. */
  isUrgent?: boolean
  /** The band's width in px, or a little under; the fuse and the sparkline take what is past W. */
  width?: number
  /** Px left clear at the right end for a control laid over the banner. */
  room?: number
  /** Which look: the violet banner (the default) or matte black. */
  theme?: HaloTheme
  /** The host docks a control at the right end: square the right corners and fade into the dock's colour. */
  dock?: boolean
  /** The host lays a tray in the dock's colour under the banner: melt the bottom edge into it too. */
  tray?: boolean
}

export type CacheState = 'idle' | 'live' | 'warm' | 'cold'

const FUSE = {
  g: ['#34D399', '#22D3EE'],
  a: ['#FBBF24', '#F97316'],
  r: ['#FB7185', '#F43F5E'],
} as const

type Fuse = { readonly g: readonly [string, string]; readonly a: readonly [string, string]; readonly r: readonly [string, string] }

/** One look of the banner: every colour it draws that is not the mascot's or an alarm's. */
type Palette = {
  /** The backdrop's three stops, warm and frozen over. */
  bg: readonly [string, string, string]
  ice: readonly [string, string, string]
  /** The three drifting blobs under the blur, and how strong each is. */
  aurora: readonly [string, string, string]
  auroraOp: readonly [number, number, number]
  mut: string
  /** Ring gradients, outer to inner: the Fable week, the week, the 5-hour window. */
  rings: { f: readonly [string, string]; w: readonly [string, string]; h: readonly [string, string] }
  /** The readout captions, keyed to the rings. */
  caps: readonly [string, string, string]
  fuse: Fuse
  hit: string
  live: string
  cold: string
  recache: string
  bars: readonly [string, string]
  delta: string
  confetti: readonly string[]
  capsule: string
  track: number
  stub: number
  div: number
  grid: number
  glint: number
  /** The dither swoop's tint. */
  tintL: string
  /** How hard the amber glow behind Compact burns when the cache is about to lapse. */
  heat: number
  /** The dock's solid colour at the banner's right end, warm and frozen over. */
  end: string
  iceEnd: string
  /** A hairline round the banner and a soft light along its top (matte black only). */
  edge: string | null
  sheen: number
}

const THEMES: Record<HaloTheme, Palette> = {
  violet: {
    bg: ['#250F72', '#5530DD', '#8452F4'],
    ice: ['#1E2B6F', '#2F4BB8', '#5B7BE0'],
    aurora: ['#EC4899', '#22D3EE', '#A78BFA'],
    auroraOp: [0.45, 0.32, 0.38],
    mut: 'rgba(255,255,255,.72)',
    rings: { f: ['#FEF3C7', '#F59E0B'], w: ['#67E8F9', '#A5B4FC'], h: ['#FFFFFF', '#F472B6'] },
    caps: ['#FCD34D', '#67E8F9', '#F9A8D4'],
    fuse: FUSE,
    hit: '#5EEAD4',
    live: '#6EE7B7',
    cold: '#BFDBFE',
    recache: '#FDA4AF',
    bars: ['#C4B5FD', '#FFFFFF'],
    delta: '#C4B5FD',
    confetti: ['#F9A8D4', '#67E8F9', '#FDE68A', '#FFFFFF', '#C4B5FD', '#86EFAC'],
    capsule: 'fill="#000" fill-opacity=".28"',
    track: 0.15,
    stub: 0.2,
    div: 0.3,
    grid: 0.045,
    glint: 0.55,
    tintL: '#E9D5FF',
    heat: 0.55,
    end: '#6D45EC',
    iceEnd: '#4A69D2',
    edge: null,
    sheen: 0,
  },
  // Matte black, as ChatGPT does it: near-black, grey type, the rings told
  // apart by brightness, colour only where it means something (amber and red
  // as the cache runs out, Claude's orange).
  black: {
    bg: ['#161616', '#0F0F0F', '#0A0A0A'],
    ice: ['#121822', '#0D121B', '#0A0E15'],
    aurora: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
    auroraOp: [0.07, 0.05, 0.06],
    mut: 'rgba(255,255,255,.5)',
    rings: { f: ['#FFFFFF', '#E8E8E8'], w: ['#BDBDBD', '#A1A1A1'], h: ['#858585', '#6E6E6E'] },
    caps: ['#F2F2F2', '#B0B0B0', '#858585'],
    fuse: { g: ['#FFFFFF', '#CFCFCF'], a: ['#FCD34D', '#F59E0B'], r: ['#F87171', '#EF4444'] },
    hit: '#F2F2F2',
    live: '#F2F2F2',
    cold: '#C9D4E3',
    recache: '#F87171',
    bars: ['#3F3F3F', '#F5F5F5'],
    delta: '#D4D4D4',
    confetti: ['#FFFFFF', '#D4D4D4', '#FF7A2B', '#A3A3A3', '#FFFFFF', '#FFA35A'],
    capsule: 'fill="#fff" fill-opacity=".08"',
    track: 0.09,
    stub: 0.12,
    div: 0.12,
    grid: 0.028,
    glint: 0.42,
    tintL: '#FFFFFF',
    heat: 0.26,
    end: '#0C0C0C',
    iceEnd: '#0B1018',
    edge: 'rgba(255,255,255,.1)',
    sheen: 0.05,
  },
}

// The palette this draw uses: hud() sets it, as it sets SW.
let T: Palette = THEMES.violet

/** The dock's colour, for the host Box that holds Compact beside the banner. */
export const dockColor = (theme: HaloTheme | undefined, isCold: boolean) => {
  const p = THEMES[theme ?? 'violet']
  return isCold ? p.iceEnd : p.end
}

/** How far the banner fades into the dock colour at its right end. */
const FADE = 36
/** How far its bottom fades into the tray under it, behind the readouts. */
const TRAY_FADE = 12

// Fraction of the TTL left → colour, piecewise: teal, then amber, then rose.
const STOPS: readonly [number, 'g' | 'a' | 'r'][] = [
  [1, 'g'],
  [0.34, 'g'],
  [0.26, 'a'],
  [0.12, 'a'],
  [0.06, 'r'],
  [0, 'r'],
]

/** Below this a lapsing cache costs too little to make a fuss about. */
export const BIG = 20_000

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n2 = (n: number) => String(Math.round(n * 100) / 100)
const sec = (s: number) => `${n2(s)}s`

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`
}

export const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

export const fmtUsd = (n: number) =>
  n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`

const fmtDelta = (n: number) => (n < 1 ? `+${Math.max(1, Math.round(n * 100))}¢` : `+$${n.toFixed(n < 10 ? 2 : 1)}`)

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))

export const lerpHex = (a: string, b: string, t: number) => {
  const x = hex(a)
  const y = hex(b)
  return `#${x
    .map((v, i) => Math.round(v + ((y[i] ?? v) - v) * clamp01(t)).toString(16).padStart(2, '0'))
    .join('')}`
}

/** The fuse's colour pair at a fraction `f` of the TTL left. */
export const fuseAt = (f: number, fuse: Fuse = FUSE): [string, string] => {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [f0, k0] = STOPS[i]!
    const [f1, k1] = STOPS[i + 1]!
    if (f <= f0 && f >= f1) {
      const t = f0 === f1 ? 0 : (f0 - f) / (f0 - f1)
      return [lerpHex(fuse[k0][0], fuse[k1][0], t), lerpHex(fuse[k0][1], fuse[k1][1], t)]
    }
  }
  return [fuse.r[0], fuse.r[1]]
}

export const cacheState = (c: HaloCache, now: number, isWorking: boolean): CacheState => {
  if (isWorking || c.isLive) return 'live'
  if (c.lastAt === 0) return 'idle'
  return c.lastAt + c.ttlMs > now ? 'warm' : 'cold'
}

/** How long before a lapse the alarm goes off: 5 min on a long cache, 1 on a short. */
export const leadMs = (ttlMs: number) => (ttlMs >= 30 * 60_000 ? 5 * 60_000 : 60_000)

/**
 * The countdown as timed labels: each `[label, from, to]` in seconds from now,
 * whole minutes while over one, then seconds.
 */
export const countdown = (remS: number): [string, number, number][] => {
  const out: [string, number, number][] = []
  let t = 0
  let s = remS
  while (s > 60) {
    const m = Math.ceil(s / 60)
    const next = Math.max(60, (m - 1) * 60)
    out.push([`${m}m`, t, t + (s - next)])
    t += s - next
    s = next
  }
  while (s > 0) {
    const whole = Math.ceil(s)
    const next = whole - 1
    out.push([`${whole}s`, t, t + (s - next)])
    t += s - next
    s = next
  }
  return out
}

/** keyTimes and colour values for one fuse stop over the `remS` seconds left. */
export const fuseTimeline = (frac: number, ttlS: number, remS: number, which: 0 | 1, fuse: Fuse = FUSE) => {
  const pts: [number, string][] = [[0, fuseAt(frac, fuse)[which]]]
  for (const [f] of STOPS) {
    if (f < frac && f > 0) pts.push([(remS - f * ttlS) / remS, fuseAt(f, fuse)[which]])
  }
  pts.push([1, fuseAt(0, fuse)[which]])
  const kept = pts.filter((p, i) => i === 0 || p[0] > pts[i - 1]![0] + 1e-4)
  return {
    keyTimes: kept.map(p => p[0].toFixed(4)).join(';'),
    values: kept.map(p => p[1]).join(';'),
  }
}

export const ringsOf = (m: HaloMeter): Rings => ({
  five: clamp01((m.five?.pct ?? 0) / 100),
  seven: clamp01((m.seven?.pct ?? 0) / 100),
  fable: clamp01((m.fable?.pct ?? 0) / 100),
})

/** The plain-words summary: the SVG's alt and the terminal's line. */
export const describe = (i: Pick<HudInput, 'now' | 'cache' | 'meter' | 'isWorking'>) => {
  const { meter: m, cache: c, now } = i
  const parts: string[] = []
  if (m.five) parts.push(`5h ${Math.round(m.five.pct)}%`)
  if (m.seven) parts.push(`7d ${Math.round(m.seven.pct)}%`)
  if (m.fable) parts.push(`Fable week ${Math.round(m.fable.pct)}%`)
  const st = cacheState(c, now, i.isWorking)
  if (st === 'live') parts.push('cache live')
  if (st === 'warm') parts.push(`cache ${fmtDur(c.lastAt + c.ttlMs - now)} · ${Math.round(c.hit * 100)}% hit`)
  if (st === 'cold') parts.push(`cache cold · ${fmtTok(c.tokens)} to re-cache`)
  if (m.usd !== null) parts.push(fmtUsd(m.usd))
  return parts.join(' · ')
}

// ── small machinery ──────────────────────────────────────────────────────────

/** A seeded PRNG, so the same state draws the same sparkles and snow. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Pixel art: each row a string, each char a colour key, '.' empty; runs merge. */
const pix = (rows: readonly string[], colors: Record<string, string>, u: number, ox = 0, oy = 0) => {
  let out = ''
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]!
      const fill = colors[ch]
      if (!fill) {
        x++
        continue
      }
      let e = x
      while (e < row.length && row[e] === ch) e++
      out += `<rect x="${n2(ox + x * u)}" y="${n2(oy + y * u)}" width="${n2((e - x) * u + 0.02)}" height="${n2(u + 0.02)}" fill="${fill}"/>`
      x = e
    }
  })
  return out
}

/** A group shown from `from` to `to` seconds (null: from the start / forever). */
const window_ = (content: string, from: number | null, to: number | null) => {
  if (to !== null && to <= 0) return ''
  const isOn = from === null || from <= 0
  return (
    `<g opacity="${isOn ? 1 : 0}">` +
    (isOn ? '' : `<set attributeName="opacity" to="1" begin="${sec(from!)}" fill="freeze"/>`) +
    (to === null ? '' : `<set attributeName="opacity" to="0" begin="${sec(to)}" fill="freeze"/>`) +
    `${content}</g>`
  )
}

// ── the mascot ───────────────────────────────────────────────────────────────

const U = 3 // one mascot pixel, in SVG px
// Claude himself, in bright Claude orange: body, shade, top light, eyes.
const CLAWD = { X: '#FF7A2B', S: '#E2571A', L: '#FFA35A', E: '#1B1230' }
const BODY = [
  '..LLLLLLLL..',
  '..XEXXXXEX..',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
  '..XXXXXXXS..',
  '..XXXXXXSS..',
  '..S.S..S.S..',
]
const BODY_NO_EYES = BODY.map(r => r.replace(/E/g, 'X'))
const BODY_NO_ARM = BODY_NO_EYES.map((r, y) => (y === 2 || y === 3 ? `${r.slice(0, 10)}..` : r))
const GUITAR = [
  '...........LL.',
  '..........LKKL',
  '.........NLL..',
  '........N.....',
  '.......N......',
  '..DDD.N.......',
  '.DDDDN........',
  'DDPPNDD.......',
  'DPPPPDDD......',
  'DDPWPPDD......',
  '.DDPPDDD......',
  '..DDDDD.......',
  '...DDD........',
]
const NOTE = ['.XX', '.X.', '.X.', 'XX.', 'XX.']
const ZED = ['XXXX', '..X.', '.X..', 'XXXX']
const BANG = ['X', 'X', 'X', '.', 'X']

type Mood = 'idle' | 'rock' | 'alarm' | 'sleep' | 'sweat'

/** One pose of the mascot, its feet on (0, 0) of its own frame, 36 × 21 px. */
const mascot = (mood: Mood) => {
  const top = -BODY.length * U
  const eyes = (cls = '') =>
    `<g${cls}>` +
    `<rect x="${3 * U}" y="${top + U}" width="${U}" height="${U}" fill="${CLAWD.E}"/>` +
    `<rect x="${8 * U}" y="${top + U}" width="${U}" height="${U}" fill="${CLAWD.E}"/></g>`
  const shadow = (squash: string) =>
    `<ellipse cx="18" cy="1.6" rx="15" ry="2" fill="#12062e" opacity=".35">${squash}</ellipse>`

  if (mood === 'rock') {
    const arm = `<g>${pix(['XX', 'XX'], CLAWD, U, 10 * U, top + 2 * U)}<animateTransform attributeName="transform" type="translate" values="0 0;0 ${U};0 0" dur=".32s" calcMode="discrete" repeatCount="indefinite"/></g>`
    const notes = [0, 0.6, 1.2]
      .map(
        (b, k) =>
          `<g opacity="0" transform="translate(${30 + k * 5} ${top - 4})">${pix(NOTE, { X: '#FEF3C7' }, 1.4)}` +
          `<animateTransform attributeName="transform" type="translate" values="${30 + k * 5} ${top - 2};${34 + k * 6} ${top - 14};${30 + k * 7} ${top - 22}" dur="1.8s" begin="${b}s" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.15;.6;1" dur="1.8s" begin="${b}s" repeatCount="indefinite"/></g>`,
      )
      .join('')
    return (
      shadow('') +
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0;0 -2" dur=".64s" calcMode="discrete" repeatCount="indefinite"/>` +
      pix(BODY_NO_ARM, CLAWD, U, 0, top) +
      eyes() +
      `<g><animateTransform attributeName="transform" type="rotate" values="-4 18 ${top + 15};3 18 ${top + 15};-4 18 ${top + 15}" dur=".64s" calcMode="discrete" repeatCount="indefinite"/>` +
      pix(GUITAR, { D: '#2A2140', P: '#C4B5FD', W: '#F5F3FF', N: '#3B2F5C', L: '#E9D5FF', K: '#2A2140' }, 2, 13, top - 5) +
      `</g>${arm}</g>${notes}`
    )
  }

  if (mood === 'sleep') {
    const shut =
      `<rect x="${3 * U}" y="${top + 2 * U - 1.2}" width="${U}" height="1.2" fill="${CLAWD.E}"/>` +
      `<rect x="${8 * U}" y="${top + 2 * U - 1.2}" width="${U}" height="1.2" fill="${CLAWD.E}"/>`
    const cap = pix(['..WWWWWWWW..', '...W..W.W...'], { W: '#F8FAFF' }, U, 0, top - U * 0.6)
    const zs = [0, 1.3]
      .map(
        (b, k) =>
          `<g opacity="0">${pix(ZED, { X: '#E0E7FF' }, k ? 1.6 : 1.2)}` +
          `<animateTransform attributeName="transform" type="translate" values="30 ${top - 2};36 ${top - 10};40 ${top - 18}" dur="2.6s" begin="${b}s" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="0;1;0" dur="2.6s" begin="${b}s" repeatCount="indefinite"/></g>`,
      )
      .join('')
    return (
      shadow('') +
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;.7 0;-.7 0;.7 0;0 0;0 0" keyTimes="0;.03;.06;.09;.12;1" dur="3.2s" repeatCount="indefinite"/>` +
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="2.6s" calcMode="discrete" repeatCount="indefinite"/>` +
      pix(BODY_NO_EYES, { ...CLAWD, X: '#EE9258', L: '#F5B387', S: '#CF7340' }, U, 0, top) +
      shut +
      cap +
      `</g></g>${zs}`
    )
  }

  if (mood === 'alarm' || mood === 'sweat') {
    const isAlarm = mood === 'alarm'
    const jump = isAlarm
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -6;0 -8;0 -6;0 0;0 0" keyTimes="0;.12;.22;.32;.42;1" dur="1.1s" repeatCount="indefinite"/>`
      : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="1s" calcMode="discrete" repeatCount="indefinite"/>`
    const wide =
      `<rect x="${3 * U}" y="${top + U}" width="${U}" height="${2 * U}" fill="${CLAWD.E}"/>` +
      `<rect x="${8 * U}" y="${top + U}" width="${U}" height="${2 * U}" fill="${CLAWD.E}"/>` +
      `<rect x="${3 * U}" y="${top + U}" width="1.2" height="1.2" fill="#fff"/><rect x="${8 * U}" y="${top + U}" width="1.2" height="1.2" fill="#fff"/>`
    const point = isAlarm ? pix(['XXXXX', 'XXXXX'], CLAWD, U, 10 * U, top + 2 * U) : ''
    const drop =
      `<g opacity="0"><rect x="-1" y="${top + 2}" width="2.4" height="3.6" rx="1.2" fill="#93C5FD"/>` +
      `<animateTransform attributeName="transform" type="translate" values="0 0;-1 10" dur=".9s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="1;0" dur=".9s" repeatCount="indefinite"/></g>`
    const bubble = isAlarm
      ? `<g transform="translate(-15 ${top - 1})"><rect x="0" y="0" width="11" height="13" rx="3" fill="#fff"/>` +
        `<path d="M10.5 5 L14 7 L10.5 9 Z" fill="#fff"/>${pix(BANG, { X: '#F43F5E' }, 1.9, 4.6, 1.8)}` +
        `<animateTransform attributeName="transform" type="translate" values="-15 ${top - 1};-15 ${top - 4};-15 ${top - 1}" dur=".55s" repeatCount="indefinite"/></g>`
      : ''
    return (
      shadow(
        isAlarm
          ? `<animate attributeName="rx" values="15;10;8;10;15;15" keyTimes="0;.12;.22;.32;.42;1" dur="1.1s" repeatCount="indefinite"/>`
          : '',
      ) +
      `<g>${jump}${pix(isAlarm ? BODY_NO_ARM : BODY_NO_EYES, CLAWD, U, 0, top)}${point}${wide}${drop}</g>${bubble}`
    )
  }

  // idle: breathe, blink, glance around, and wave now and then
  const blink =
    `<g opacity="0">${pix(['...X....X...'], { X: CLAWD.X }, U, 0, top + U)}` +
    `<animate attributeName="opacity" values="0;1;0;0;1;0;0" keyTimes="0;.02;.04;.5;.52;.54;1" dur="7.3s" repeatCount="indefinite"/></g>`
  const glance = `<animateTransform attributeName="transform" type="translate" values="0 0;${U / 3} 0;${U / 3} 0;0 0;-${U / 3} 0;0 0" keyTimes="0;.2;.35;.5;.65;1" dur="9s" calcMode="discrete" repeatCount="indefinite"/>`
  const wave =
    `<g>${pix(['XX', 'XX'], CLAWD, U, 10 * U, top + 2 * U)}` +
    `<animateTransform attributeName="transform" type="rotate" values="0 ${10 * U} ${top + 3 * U};0 ${10 * U} ${top + 3 * U};-35 ${10 * U} ${top + 3 * U};-10 ${10 * U} ${top + 3 * U};-35 ${10 * U} ${top + 3 * U};0 ${10 * U} ${top + 3 * U}" keyTimes="0;.8;.84;.88;.92;1" dur="11s" calcMode="discrete" repeatCount="indefinite"/></g>`
  return (
    shadow(`<animate attributeName="rx" values="15;14;15" dur="2.4s" repeatCount="indefinite"/>`) +
    `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1" dur="2.4s" calcMode="discrete" repeatCount="indefinite"/>` +
    pix(BODY_NO_ARM, CLAWD, U, 0, top) +
    `<g>${glance}${eyes()}${blink}</g>${wave}</g>`
  )
}

// ── effects ──────────────────────────────────────────────────────────────────

const CELL = 6

/**
 * The pixel wave: a band of lit cells that steps a cell at a time across the
 * strip, brightest at its leading edge, dithered with a checker overlay. The
 * band is its own small group, masked in its own coordinates and slid whole,
 * so a step repaints its 72px, not the strip; it starts on a cell boundary, so
 * its cells land on the grid's. `every` repeats it on a period.
 */
let waveIds = 0
type Tint = '' | 'a' | 'l'
const TINT: Record<Tint, string> = { '': '#FFFFFF', a: '#FDE68A', l: '#E9D5FF' }
const BAND = [0.62, 0.55, 0.46, 0.4, 0.33, 0.27, 0.21, 0.16, 0.12, 0.08, 0.05, 0.03]
/** The most cells a second the band steps: one a frame at 60Hz, so none is dropped. */
const WAVE_RATE = 60
const pixelWave = (dir: 'ltr' | 'rtl', begin: number, every: number | null, tint: Tint = '') => {
  const span = BAND.length * CELL
  const reach = Math.ceil(SW / CELL) * CELL
  const steps = (reach + span) / CELL
  // A wider strip takes longer to cross rather than stepping faster.
  const pass = Math.max(1.05, steps / WAVE_RATE)
  if (every === null && begin + pass < 0) return ''
  const id = `w${waveIds++}`
  // plateau k (left to right) of the band; the leading edge faces the travel
  const level = (k: number) => BAND[dir === 'ltr' ? BAND.length - 1 - k : k]!
  let stops = '<stop offset="0" stop-color="#fff" stop-opacity="0"/>'
  for (let k = 0; k < BAND.length; k++) {
    const o = n2(level(k))
    stops += `<stop offset="${n2(k / BAND.length)}" stop-color="#fff" stop-opacity="${o}"/><stop offset="${n2((k + 1) / BAND.length)}" stop-color="#fff" stop-opacity="${o}"/>`
  }
  stops += '<stop offset="1" stop-color="#fff" stop-opacity="0"/>'
  const xs: number[] = []
  for (let j = 0; j <= steps; j++) xs.push(dir === 'ltr' ? -span + j * CELL : reach - j * CELL)
  const values = xs.map(x => `${x} 0`).join(';')
  // A repeat never comes round before the pass it repeats has finished.
  const period = every === null ? null : Math.max(every, pass + 0.5)
  const timing =
    period === null
      ? `dur="${n2(pass)}s" begin="${sec(begin)}" fill="freeze"`
      : `keyTimes="${xs.map((_, j) => (j / steps) * (pass / period)).map(t => t.toFixed(4)).join(';')}" dur="${n2(period)}s" begin="${sec(begin)}" repeatCount="indefinite"`
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${span}" y2="0">${stops}</linearGradient>` +
    `<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${span}" height="${H}"><rect width="${span}" height="${H}" fill="url(#${id})"/></mask>` +
    `<g transform="translate(${xs[0]} 0)"><animateTransform attributeName="transform" type="translate" values="${values}" calcMode="discrete" ${timing}/>` +
    `<g mask="url(#${id}m)"><rect width="${span}" height="${H}" fill="url(#px${tint})"/><rect width="${span}" height="${H}" fill="url(#px2${tint})" opacity=".6"/></g></g>`
  )
}

/** Single cells that glint at random, snapped to the pixel grid. */
const sparkles = (count: number, seed: number, x0: number, x1: number) => {
  const r = rng(seed)
  let out = ''
  for (let k = 0; k < count; k++) {
    const x = Math.floor((x0 + r() * (x1 - x0)) / CELL) * CELL + 1
    const y = Math.floor((r() * H) / CELL) * CELL + 1
    const dur = 2.2 + r() * 3
    out += `<rect x="${x}" y="${y}" width="${CELL - 2}" height="${CELL - 2}" fill="#fff" opacity="0"><animate attributeName="opacity" values="0;${T.glint};0" dur="${n2(dur)}s" begin="${n2(r() * 6)}s" repeatCount="indefinite"/></rect>`
  }
  return out
}

/** Pixel snow over the whole strip, falling from `begin` on. */
const snow = (begin: number, seed: number) => {
  const r = rng(seed)
  let out = ''
  for (let k = 0; k < Math.round((22 * SW) / W); k++) {
    const x = r() * SW
    const dur = 2.6 + r() * 3.4
    const b = begin <= 0 ? -r() * dur : begin + r() * 2
    const sway = (r() - 0.5) * 14
    const s = r() > 0.7 ? 2.4 : 1.6
    out +=
      `<rect width="${s}" height="${s}" fill="#fff" opacity="${n2(0.55 + r() * 0.45)}" transform="translate(${n2(x)} -4)">` +
      `<animateTransform attributeName="transform" type="translate" values="${n2(x)} -4;${n2(x + sway)} ${H / 2};${n2(x - sway / 2)} ${H + 4}" dur="${n2(dur)}s" begin="${sec(b)}" repeatCount="indefinite"/></rect>`
  }
  return window_(out, begin, null)
}

/** Confetti bursting out of (cx, cy) once, at `begin`. */
const confetti = (cx: number, cy: number, begin: number, seed: number) => {
  if (begin < -1.6) return ''
  const r = rng(seed)
  const colors = T.confetti
  let out = ''
  for (let k = 0; k < 16; k++) {
    const a = Math.PI * (0.55 + r() * 0.9) + Math.PI // up and out, mostly left
    const d = 16 + r() * 40
    const dx = Math.cos(a) * d
    const dy = Math.sin(a) * d * 0.55
    const s = 1.6 + r() * 1.8
    out +=
      `<rect width="${n2(s)}" height="${n2(s)}" fill="${colors[k % colors.length]}" opacity="0" transform="translate(${n2(cx)} ${n2(cy)})">` +
      `<animateTransform attributeName="transform" type="translate" values="${n2(cx)} ${n2(cy)};${n2(cx + dx)} ${n2(cy + dy)};${n2(cx + dx * 1.15)} ${n2(cy + dy + 14)}" keyTimes="0;.45;1" dur="1.4s" begin="${sec(begin)}" calcMode="spline" keySplines="0.2 .8 .3 1;.5 0 .9 .6" fill="freeze"/>` +
      `<animate attributeName="opacity" values="1;1;0" keyTimes="0;.6;1" dur="1.4s" begin="${sec(begin)}" fill="freeze"/></rect>`
  }
  return out
}

/** The big number rolling from one value to another over 0.9s. */
const roll = (from: number, to: number, x: number, y: number, attrs: string, suffix = '%') => {
  if (Math.round(from) === Math.round(to)) return `<text x="${x}" y="${y}" ${attrs}>${Math.round(to)}${suffix}</text>`
  const steps = 14
  let out = ''
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const ease = 1 - Math.pow(1 - t, 3)
    const v = Math.round(from + (to - from) * ease)
    const a = (0.9 * k) / steps
    const b = (0.9 * (k + 1)) / steps
    out +=
      `<text x="${x}" y="${y}" ${attrs} opacity="${k === 0 ? 1 : 0}">` +
      (k === 0 ? '' : `<set attributeName="opacity" to="1" begin="${n2(a)}s"/>`) +
      (k === steps ? '' : `<set attributeName="opacity" to="0" begin="${n2(b)}s"/>`) +
      `${v}${suffix}</text>`
  }
  return out
}

/** The dial: its centre, in the 44px band's coordinates, and each ring's stroke. */
const DX = 26
const DY = 22
const RW = 4.4

const ring = (id: string, r: number, from: number, to: number, isHot: boolean) => {
  const c = 2 * Math.PI * r
  const track = `<circle cx="${DX}" cy="${DY}" r="${r}" fill="none" stroke="#fff" stroke-opacity="${T.track}" stroke-width="${RW}"/>`
  if (to < 0.004 && from < 0.004) return track
  const off = n2(c * (1 - clamp01(to)))
  const sweep =
    Math.abs(from - to) > 0.002
      ? `<animate attributeName="stroke-dashoffset" from="${n2(c * (1 - clamp01(from)))}" to="${off}" dur="1.4s" calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1" fill="freeze"/>`
      : ''
  const pulse = isHot
    ? `<animate attributeName="stroke-width" values="${RW};${RW + 1.6};${RW}" dur="1.2s" repeatCount="indefinite"/>`
    : ''
  return `${track}<circle cx="${DX}" cy="${DY}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${RW}" stroke-linecap="round" stroke-dasharray="${n2(c)} ${n2(c)}" stroke-dashoffset="${off}" transform="rotate(-90 ${DX} ${DY})" filter="url(#glow)">${sweep}${pulse}</circle>`
}

/**
 * "↻4h11" counting down by itself: one label per minute for the next seven,
 * past the 5-minute redraw, so it never stalls between draws.
 */
const ticker = (x: number, y: number, remMs: number) => {
  const runs: [string, number][] = []
  for (let t = 0; t <= 420; t += 5) {
    const txt = `↻${fmtDur(remMs - t * 1000)}`
    if (runs.at(-1)?.[0] !== txt) runs.push([txt, t])
  }
  return runs
    .map(([txt, a], k) => {
      const b = runs[k + 1]?.[1]
      return (
        `<text x="${x}" y="${y}" class="mut" font-size="7" font-weight="650" letter-spacing=".6"${k === 0 ? '' : ' opacity="0"'}>` +
        (k === 0 ? '' : `<set attributeName="opacity" to="1" begin="${a}s"/>`) +
        (b === undefined ? '' : `<set attributeName="opacity" to="0" begin="${b}s"/>`) +
        `${esc(txt)}</text>`
      )
    })
    .join('')
}

const sevColor = (pct: number) => (pct >= 90 ? '#FDA4AF' : pct >= 75 ? '#FDE68A' : '#FFFFFF')

// ── the strip ────────────────────────────────────────────────────────────────

export const hud = (i: HudInput) => {
  waveIds = 0
  // Laid out at `width`, a floor under the band's real width: the left sections
  // sit from the left edge and the right ones from the right edge (a nested svg
  // at x=100%), so the banner spans the band exactly and any error only widens
  // the gap after the fuse. The backdrop helpers draw a little past it.
  const LW = Math.max(W + 2 * PAD, Math.round(i.width ?? W))
  SW = LW + 48
  T = THEMES[i.theme ?? 'violet']
  // The content lays out across CW, inset by PAD; ROOM at its right end stays
  // clear for the control the host lays over the banner (Compact).
  const CW = LW - 2 * PAD
  const ROOM = Math.max(0, Math.round(i.room ?? 0))
  const EW = CW - ROOM
  // Past W, the fuse takes most of the room, the sparkline some, the stage the rest.
  const grow = Math.max(0, EW - W)
  const dC = Math.round(grow * 0.55)
  const dD = Math.round(grow * 0.3)
  const { meter: m, cache: c, now } = i
  const to = ringsOf(m)
  const hasLimits = m.five !== null || m.seven !== null
  const five = m.five?.pct ?? 0

  const st = cacheState(c, now, i.isWorking)
  const remMs = c.lastAt + c.ttlMs - now
  const remS = remMs / 1000
  const frac = clamp01(remMs / c.ttlMs)
  const isBig = c.tokens >= BIG
  // When things happen, in seconds from this draw (negative: already did).
  const coldAt = st === 'warm' ? remS : st === 'cold' ? -999 : null
  // The alarm runs from the lead-up to a lapse (or now, when compacting is
  // already worth it) until the cache goes cold; then the snow takes over.
  const alarmAt =
    st === 'live' || st === 'cold'
      ? null
      : i.isUrgent
        ? 0
        : st === 'warm' && isBig
          ? remS - leadMs(c.ttlMs) / 1000
          : null
  const alarmEnd = st === 'warm' ? remS : null
  const partyAt = i.celebrateAt ? (i.celebrateAt - now) / 1000 + 0.15 : null

  // ── backdrop: a living violet band that freezes over when the cache does ──
  const ICE = T.ice
  const VIOLET = T.bg
  const stop = (k: number, o: string) =>
    `<stop offset="${o}" stop-color="${coldAt !== null && coldAt <= 0 ? ICE[k] : VIOLET[k]}">` +
    (coldAt !== null && coldAt > 0
      ? `<animate attributeName="stop-color" from="${VIOLET[k]}" to="${ICE[k]}" begin="${sec(coldAt)}" dur="2.5s" fill="freeze"/>`
      : '') +
    `</stop>`
  // Drawn at W and stretched across the strip: under the blur nobody sees the stretch.
  const aurora =
    `<g transform="scale(${n2(SW / W)} 1)"><g filter="url(#blur)" opacity=".9">` +
    `<ellipse cx="90" cy="40" rx="70" ry="22" fill="${T.aurora[0]}" opacity="${T.auroraOp[0]}"><animateTransform attributeName="transform" type="translate" values="0 0;140 -10;260 4;120 8;0 0" dur="19s" repeatCount="indefinite"/></ellipse>` +
    `<ellipse cx="380" cy="2" rx="80" ry="18" fill="${T.aurora[1]}" opacity="${T.auroraOp[1]}"><animateTransform attributeName="transform" type="translate" values="0 0;-160 10;-300 0;-120 -6;0 0" dur="23s" repeatCount="indefinite"/></ellipse>` +
    `<ellipse cx="240" cy="30" rx="60" ry="16" fill="${T.aurora[2]}" opacity="${T.auroraOp[2]}"><animateTransform attributeName="transform" type="translate" values="0 0;-90 -8;80 6;0 0" dur="15s" repeatCount="indefinite"/></ellipse>` +
    `</g></g>`
  const isDanger = five >= 90
  const urgentGlow =
    alarmAt === null
      ? ''
      : window_(
          `<rect width="100%" height="${H}" fill="url(#heat)"><animate attributeName="opacity" values=".25;1;.25" dur="1.1s" repeatCount="indefinite"/></rect>` +
            `<rect width="100%" height="${H}" rx="${i.dock ? 0 : R}" fill="none" stroke="#FBBF24" stroke-width="3.2"><animate attributeName="stroke-opacity" values=".2;1;.2" dur="1.1s" repeatCount="indefinite"/></rect>` +
            pixelWave('ltr', 0, 3.2, 'a') +
            sparkles(18, 7, SW - 140, SW),
          alarmAt,
          alarmEnd,
        )
  const dangerGlow = isDanger
    ? `<rect width="100%" height="${H}" fill="url(#aura)"><animate attributeName="opacity" values=".3;1;.3" dur="2s" repeatCount="indefinite"/></rect>`
    : ''
  const party = partyAt === null ? '' : pixelWave('rtl', partyAt, null, 'l')
  const burst = partyAt === null ? '' : confetti(EW - 52, 22, partyAt + 0.25, 3)
  const shimmer = `<g opacity=".4">${pixelWave('rtl', 3, 14, 'l')}</g>`

  // ── A · the dial: the Fable week outside, the week, the 5-hour window inside;
  // a window not reported is a dotted track. A comet circles while a turn runs.
  const seven = m.seven?.pct ?? 0
  const fable = m.fable?.pct ?? 0
  const dotted = (r: number) =>
    `<circle cx="${DX}" cy="${DY}" r="${r}" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1" stroke-dasharray="1.4 3.2"/>`
  const orbit =
    (m.fable ? ring('gf', 21.6, i.from.fable ?? 0, to.fable ?? 0, fable >= 90) : dotted(21.6)) +
    (m.seven ? ring('g7', 16.2, i.from.seven, to.seven, seven >= 90) : dotted(16.2)) +
    (m.five ? ring('g5', 10.8, i.from.five, to.five, five >= 90) : dotted(10.8)) +
    `<rect x="${DX - 1.5}" y="${DY - 1.5}" width="3" height="3" fill="#fff" opacity=".9"><animate attributeName="opacity" values=".9;.2;.9" dur="${i.isWorking ? '.6s' : '2.8s'}" repeatCount="indefinite"/></rect>` +
    (i.isWorking
      ? `<g><circle cx="${DX}" cy="${DY - 24.8}" r="1.8" fill="#fff" filter="url(#glow)"/><circle cx="${DX - 3}" cy="${DY - 24.6}" r="1.1" fill="#fff" opacity=".5"/><circle cx="${DX - 5.6}" cy="${DY - 24.2}" r=".7" fill="#fff" opacity=".3"/><animateTransform attributeName="transform" type="rotate" from="0 ${DX} ${DY}" to="360 ${DX} ${DY}" dur="1.8s" repeatCount="indefinite"/></g>`
      : '')

  // ── B · the readout: a column per ring, outer to inner, its caption in the
  // ring's colour; the 5-hour window also says when it resets.
  const AX = 44
  const cols: [string, string, HaloWindow | null | undefined, number, number][] = [
    ['FABLE', T.caps[0], m.fable, i.from.fable ?? 0, 58],
    ['WEEK', T.caps[1], m.seven, i.from.seven, 100],
    ['5H', T.caps[2], m.five, i.from.five, 140],
  ]
  let readout: string
  if (hasLimits || m.fable) {
    readout = cols
      .map(([label, color, w, from, x]) => {
        const reset = label === '5H' && w?.resetsAt ? ticker(x + 15, 15.5, w.resetsAt - now) : ''
        const cap = `<text x="${x}" y="15.5" class="cap" fill="${color}">${label}</text>${reset}`
        if (!w) return `${cap}<text x="${x}" y="33.5" class="mut" font-size="14.5" font-weight="720">—</text>`
        return cap + roll(from * 100, w.pct, x, 33.5, `fill="${sevColor(w.pct)}" font-size="14.5" font-weight="720" letter-spacing="-.2"`)
      })
      .join('')
  } else {
    readout =
      `<text x="58" y="22" class="fg" fill="#fff" font-size="16" font-weight="720">API</text>` +
      `<text x="58" y="35" font-size="9" class="mut">no plan limits</text>`
  }
  const tipA = [
    m.fable && `Fable weekly ${m.fable.pct}%${m.fable.resetsAt ? ` · resets in ${fmtDur(m.fable.resetsAt - now)}` : ''}`,
    m.five && `5-hour window ${m.five.pct}%${m.five.resetsAt ? ` · resets in ${fmtDur(m.five.resetsAt - now)}` : ''}`,
    m.seven && `7-day window ${m.seven.pct}%${m.seven.resetsAt ? ` · resets in ${fmtDur(m.seven.resetsAt - now)}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n')

  // ── C · the cache fuse: a sparkler burning toward cold ─────────────────────
  const X = 164 + AX
  const BW = 116 + dC - AX
  const BY = 27
  const hit = `<tspan fill="${T.hit}" font-weight="650">${Math.round(c.hit * 100)}%</tspan><tspan class="mut"> hit</tspan>`
  const label = `<text x="${X}" y="17" class="mut cap">CACHE</text>`
  const capsule = `<rect x="${X}" y="${BY}" width="${BW}" height="6" rx="3" ${T.capsule}/>`
  const coldText =
    `<text x="${X}" y="17" class="mut cap">CACHE</text>` +
    `<text x="${X + BW}" y="18" text-anchor="end" font-size="11" font-weight="700" fill="${T.cold}" letter-spacing=".8">❄ cold</text>` +
    `<text x="${X}" y="33" font-size="8.5" class="mut">${c.tokens ? `<tspan fill="${T.recache}" font-weight="650">~${fmtTok(c.tokens)}</tspan> to re-cache` : 'next message re-caches'}</text>`
  let fuse = ''
  if (st === 'idle') {
    fuse = `${label}<text x="${X + BW}" y="18" text-anchor="end" class="mut" font-size="11">—</text>${capsule}`
  } else if (st === 'live') {
    fuse =
      `${label}<text x="${X + 38}" y="17.5" font-size="8.5">${c.lastAt ? hit : ''}</text>` +
      `<circle cx="${X + BW - 34}" cy="14.5" r="2.2" fill="${T.live}"><animate attributeName="r" values="2.2;3.4;2.2" dur="1s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;.3;1" dur="1s" repeatCount="indefinite"/></circle>` +
      `<text x="${X + BW}" y="18" text-anchor="end" font-size="9" font-weight="750" fill="${T.live}" letter-spacing="1.4">LIVE</text>` +
      `${capsule}<g clip-path="url(#cap)"><rect x="${X}" y="${BY}" width="${BW}" height="6" fill="url(#fz)" filter="url(#glow)"/>` +
      `<rect x="${X}" y="${BY}" width="${BW}" height="6" fill="url(#chev)" opacity=".6"/>` +
      `<rect x="${X - 40}" y="${BY - 1}" width="40" height="8" fill="url(#sheen)"><animate attributeName="x" from="${X - 40}" to="${X + BW}" dur="1.3s" repeatCount="indefinite"/></rect></g>`
  } else if (st === 'warm') {
    const w0 = BW * frac
    const ttlS = c.ttlMs / 1000
    const t0 = fuseTimeline(frac, ttlS, remS, 0, T.fuse)
    const t1 = fuseTimeline(frac, ttlS, remS, 1, T.fuse)
    const ticks =
      `<g text-anchor="end" font-size="12.5" font-weight="720" fill="#fff">` +
      countdown(remS)
        .map(
          ([txt, a, b], k) =>
            `<text x="${X + BW}" y="18.5"${k === 0 ? '' : ' opacity="0"'}>` +
            (k === 0 ? '' : `<set attributeName="opacity" to="1" begin="${n2(a)}s"/>`) +
            `<set attributeName="opacity" to="0" begin="${n2(b)}s"/>${txt}</text>`,
        )
        .join('') +
      '</g>'
    const embers = [0, 0.18, 0.36, 0.54]
      .map(
        (b, k) =>
          `<rect width="1.8" height="1.8" fill="${k % 2 ? '#FDE68A' : '#fff'}" opacity="0"><animateTransform attributeName="transform" type="translate" values="0 ${BY + 2};${-3 - k} ${BY - 5 - k * 1.5}" dur=".72s" begin="${b}s" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="1;0" dur=".72s" begin="${b}s" repeatCount="indefinite"/></rect>`,
      )
      .join('')
    fuse =
      window_(`${label}<text x="${X + 38}" y="17.5" font-size="8.5">${hit}</text>${ticks}`, null, remS) +
      window_(coldText, remS, null) +
      window_(capsule, null, c.tokens ? remS : null) +
      `<linearGradient id="fz" x1="0" x2="1"><stop offset="0" stop-color="${fuseAt(frac, T.fuse)[0]}"><animate attributeName="stop-color" dur="${sec(remS)}" keyTimes="${t0.keyTimes}" values="${t0.values}" fill="freeze"/></stop>` +
      `<stop offset="1" stop-color="${fuseAt(frac, T.fuse)[1]}"><animate attributeName="stop-color" dur="${sec(remS)}" keyTimes="${t1.keyTimes}" values="${t1.values}" fill="freeze"/></stop></linearGradient>` +
      window_(
        `<g clip-path="url(#cap)"><rect x="${X}" y="${BY}" width="${n2(w0)}" height="6" fill="url(#fz)" filter="url(#glow)"><animate attributeName="width" from="${n2(w0)}" to="0" dur="${sec(remS)}" fill="freeze"/></rect>` +
          `<rect x="${X - 30}" y="${BY - 1}" width="30" height="8" fill="url(#sheen)" opacity=".7"><animate attributeName="x" from="${X - 30}" to="${n2(X + w0)}" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
        null,
        remS,
      ) +
      window_(
        `<g><animateTransform attributeName="transform" type="translate" from="${n2(X + w0)} 0" to="${X} 0" dur="${sec(remS)}" fill="freeze"/>` +
          `<circle cx="0" cy="${BY + 3}" r="2.6" fill="#fff" filter="url(#spark)"><animate attributeName="r" values="2.2;3.4;2.5;3.1;2.2" dur=".7s" repeatCount="indefinite"/></circle>${embers}</g>`,
        null,
        remS,
      )
  } else {
    fuse = coldText + (c.tokens ? '' : capsule)
  }
  const tipC =
    st === 'live'
      ? 'Prompt cache: kept warm by the running turn'
      : st === 'warm'
        ? `Prompt cache: warm for ${fmtDur(remMs)} more (${fmtDur(c.ttlMs)} TTL)\nLast request: ${Math.round(c.hit * 100)}% served from cache\nAfter it lapses the next message re-writes ~${fmtTok(c.tokens)} tokens`
        : st === 'cold'
          ? `Prompt cache: expired\nThe next message re-writes ~${fmtTok(c.tokens)} tokens at the cache-write rate`
          : 'Prompt cache: no request yet'

  // ── D · the burn: spend and a bouncing sparkline of each turn's cost ───────
  const FX = 302 + dC
  const FW = 82 + dD
  // A wider strip shows more turns at the same bar pitch, up to the 24 kept.
  const count = Math.min(24, Math.max(14, Math.round((FW * 14) / 82)))
  const bars = i.burn.slice(-count)
  const max = Math.max(...bars, 1e-9)
  const slot = FW / count
  const bw = slot * 0.64
  const barSvg = bars
    .map((v, k) => {
      const h = Math.max(1.5, (v / max) * 12)
      const x = FX + FW - (bars.length - k) * slot + (slot - bw)
      const isLast = k === bars.length - 1
      const op = isLast ? 1 : 0.35 + (0.55 * (k + 1)) / bars.length
      const grow =
        isLast && i.isNewBurn
          ? `<animate attributeName="height" values="0;${n2(h * 1.25)};${n2(h)}" keyTimes="0;.6;1" dur=".8s" fill="freeze"/><animate attributeName="y" values="35;${n2(35 - h * 1.25)};${n2(35 - h)}" keyTimes="0;.6;1" dur=".8s" fill="freeze"/>`
          : `<animate attributeName="opacity" values="${n2(op)};${n2(Math.min(1, op + 0.3))};${n2(op)}" dur="2.4s" begin="${n2(k * 0.12)}s" repeatCount="indefinite"/>`
      return `<rect x="${n2(x)}" y="${n2(35 - h)}" width="${n2(bw)}" height="${n2(h)}" rx="1" fill="url(#gb)" opacity="${n2(op)}"${isLast ? ' filter="url(#glow)"' : ''}>${grow}</rect>`
    })
    .join('')
  // Slots no turn has filled yet sit as faint stubs, so a young session still reads as a chart.
  const stubs = Array.from(
    { length: count - bars.length },
    (_, k) => `<rect x="${n2(FX + k * slot + (slot - bw))}" y="33.5" width="${n2(bw)}" height="1.5" rx=".75" fill="#fff" fill-opacity="${T.stub}"/>`,
  ).join('')
  const last = bars.at(-1)
  const burn =
    `<text x="${FX}" y="17" class="mut cap">SPENT</text>` +
    (last !== undefined
      ? `<text x="${FX + 34}" y="17.5" font-size="8.5"><tspan fill="${T.delta}" font-weight="650">${fmtDelta(last)}</tspan><tspan class="mut">${FW >= 110 ? ' last' : ''}</tspan></text>`
      : '') +
    `<text x="${FX + FW}" y="18.5" text-anchor="end" class="fg" fill="#fff" font-size="12.5" font-weight="720">${m.usd === null ? '—' : fmtUsd(m.usd)}</text>` +
    stubs +
    barSvg
  const tipD =
    m.usd === null
      ? 'Session spend: not reported'
      : `Session spend ${fmtUsd(m.usd)}${last !== undefined ? `\nLast turn ${fmtDelta(last)}` : ''}\nBars: the last ${bars.length} turns`

  // ── E · the stage: the mascot, its mood following the cache ────────────────
  const MX = EW - 64
  const MY = CH - 5
  let stage: string
  if (i.isWorking || st === 'live') {
    stage = mascot('rock')
  } else {
    const restMood: Mood = isDanger ? 'sweat' : 'idle'
    stage =
      window_(mascot(restMood), null, alarmAt ?? coldAt) +
      (alarmAt === null ? '' : window_(mascot('alarm'), alarmAt, alarmEnd)) +
      (coldAt === null ? '' : window_(mascot('sleep'), coldAt, null))
  }
  const party2 =
    partyAt === null || partyAt < -1.2
      ? ''
      : `<animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;0 -9;0 0;0 -4;0 0" keyTimes="0;.3;.55;.75;1" dur=".9s" begin="${sec(partyAt)}" fill="freeze"/>`
  const chevron = (color: string) =>
    [0, 1, 2]
      .map(
        k =>
          `<path d="M${EW - 16 + k * 4} 16 l4 6 l-4 6" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="square" opacity=".15"><animate attributeName="opacity" values=".15;1;.15" dur=".75s" begin="${n2(k * 0.18)}s" repeatCount="indefinite"/></path>`,
      )
      .join('')
  const chevrons =
    (alarmAt === null ? '' : window_(chevron('#FDE68A'), alarmAt, alarmEnd)) +
    (coldAt !== null && isBig ? window_(chevron('#BFDBFE'), coldAt, null) : '')
  const snowfall = coldAt === null ? '' : snow(coldAt, 11)

  const tipE =
    st === 'live'
      ? 'Shredding while Claude works'
      : alarmAt !== null && alarmAt <= 0
        ? i.isUrgent
          ? 'Compact now: the context is nearly full'
          : 'Compact now: the cache is about to lapse'
        : st === 'cold'
          ? 'Asleep in the snow: the cache went cold'
          : 'Keeping you company'

  // width 100% and no viewBox: the desktop sizes the frame from the markup, so
  // the banner is exactly the band's width. Every id is scoped: an id like
  // "blur" otherwise resolves to the desktop app's own element, and the filters die.
  return scopeIds(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Inter','Segoe UI Variable','Segoe UI',system-ui,sans-serif">` +
    `<style>:root{color-scheme:light dark;background:transparent}text{font-variant-numeric:tabular-nums}` +
    `.fg{fill:#fff}.mut{fill:${T.mut}}.cap{font-size:7px;letter-spacing:1.6px;font-weight:650}` +
    `.seg{transition:opacity .3s ease,transform .3s ease}svg:hover .seg{opacity:.5}svg .seg:hover{opacity:1}</style><defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">${stop(0, '0')}${stop(1, '.55')}${stop(2, '1')}</linearGradient>` +
    `<linearGradient id="g5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.rings.h[0]}"/><stop offset="1" stop-color="${T.rings.h[1]}"/></linearGradient>` +
    `<linearGradient id="gf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.rings.f[0]}"/><stop offset="1" stop-color="${T.rings.f[1]}"/></linearGradient>` +
    `<linearGradient id="g7" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${T.rings.w[0]}"/><stop offset="1" stop-color="${T.rings.w[1]}"/></linearGradient>` +
    `<linearGradient id="gb" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${T.bars[0]}"/><stop offset="1" stop-color="${T.bars[1]}"/></linearGradient>` +
    `<linearGradient id="sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="div" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="${T.div}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<radialGradient id="aura" cx=".2" cy="1.1" r=".9"><stop offset="0" stop-color="#F43F5E" stop-opacity=".45"/><stop offset="1" stop-color="#F43F5E" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="heat" cx="1" cy=".5" r=".75"><stop offset="0" stop-color="#F59E0B" stop-opacity="${T.heat}"/><stop offset="1" stop-color="#F59E0B" stop-opacity="0"/></radialGradient>` +
    (Object.keys(TINT) as Tint[])
      .map(
        t =>
          `<pattern id="px${t}" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse"><rect x=".6" y=".6" width="${CELL - 1.2}" height="${CELL - 1.2}" fill="${t === 'l' ? T.tintL : TINT[t]}"/></pattern>` +
          `<pattern id="px2${t}" width="${CELL * 2}" height="${CELL * 2}" patternUnits="userSpaceOnUse"><rect x=".6" y=".6" width="${CELL - 1.2}" height="${CELL - 1.2}" fill="${t === 'l' ? T.tintL : TINT[t]}"/><rect x="${CELL + 0.6}" y="${CELL + 0.6}" width="${CELL - 1.2}" height="${CELL - 1.2}" fill="${t === 'l' ? T.tintL : TINT[t]}"/></pattern>`,
      )
      .join('') +
    `<pattern id="grid" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse"><rect x=".6" y=".6" width="${CELL - 1.2}" height="${CELL - 1.2}" fill="#fff" fill-opacity="${T.grid}"/></pattern>` +
    `<pattern id="chev" width="10" height="6" patternUnits="userSpaceOnUse"><path d="M2 .5 L6 3 L2 5.5" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><animateTransform attributeName="patternTransform" type="translate" from="0 0" to="10 0" dur=".45s" repeatCount="indefinite"/></pattern>` +
    (st === 'warm' ? '' : `<linearGradient id="fz" x1="0" x2="1"><stop offset="0" stop-color="${T.fuse.g[0]}"/><stop offset="1" stop-color="${T.fuse.g[1]}"/></linearGradient>`) +
    `<clipPath id="pill"><rect x="0" y="0" width="100%" height="${H}" rx="${i.dock ? 0 : R}"/></clipPath>` +
    `<clipPath id="cap"><rect x="${X}" y="${BY}" width="${BW}" height="6" rx="3"/></clipPath>` +
    `<filter id="blur" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>` +
    `<filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<filter id="spark" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${T.sheen}"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    (i.dock
      ? `<linearGradient id="endfade" x1="0" x2="1"><stop offset="0" stop-color="${T.end}" stop-opacity="0"/><stop offset="1" stop-color="${coldAt !== null && coldAt <= 0 ? T.iceEnd : T.end}">` +
        (coldAt !== null && coldAt > 0 ? `<animate attributeName="stop-color" from="${T.end}" to="${T.iceEnd}" begin="${sec(coldAt)}" dur="2.5s" fill="freeze"/>` : '') +
        `</stop></linearGradient>` +
        `<linearGradient id="endfadey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.end}" stop-opacity="0"/><stop offset="1" stop-color="${coldAt !== null && coldAt <= 0 ? T.iceEnd : T.end}">` +
        (coldAt !== null && coldAt > 0 ? `<animate attributeName="stop-color" from="${T.end}" to="${T.iceEnd}" begin="${sec(coldAt)}" dur="2.5s" fill="freeze"/>` : '') +
        `</stop></linearGradient>`
      : '') +
    `</defs>` +
    `<g clip-path="url(#pill)" color="#fff">` +
    `<rect width="100%" height="${H}" fill="url(#bg)"/>${aurora}<rect width="100%" height="${H}" fill="url(#grid)"/>` +
    sparkles(Math.round((14 * SW) / W), 1, 0, SW) +
    shimmer +
    dangerGlow +
    urgentGlow +
    party +
    snowfall +
    (T.sheen ? `<rect width="100%" height="${H}" fill="url(#top)"/>` : '') +
    // A 2px stroke on the full rect, half outside the clip: a 1px hairline inside it.
    // Docked, banner and dock are one flat panel: square corners, and no rim
    // that would stop dead where the dock begins.
    (T.edge && !i.dock ? `<rect width="100%" height="${H}" rx="${R}" fill="none" stroke="${T.edge}" stroke-width="2"/>` : '') +
    // Over a tray, the bottom TRAY_FADE px melt into it the same way.
    (i.dock && i.tray ? `<rect y="${H - TRAY_FADE}" width="100%" height="${TRAY_FADE}" fill="url(#endfadey)"/>` : '') +
    // Docked, the last FADE px melt into the dock's colour, rim and glow included.
    (i.dock ? `<svg x="100%" y="0" width="1" height="${H}" overflow="visible"><rect x="${-FADE}" width="${FADE + 1}" height="${H}" fill="url(#endfade)"/></svg>` : '') +
    `</g>` +
    `<g transform="translate(${PAD} ${OY})">` +
    `<g class="seg"><title>${esc(tipA || 'Usage: waiting for the first reply')}</title><rect x="0" y="0" width="${150 + AX}" height="${CH}" fill="transparent"/>${orbit}${readout}</g>` +
    `<rect x="${152 + AX}" y="10" width="1" height="24" fill="url(#div)"/>` +
    `<g class="seg"><title>${esc(tipC)}</title><rect x="${154 + AX}" y="0" width="${136 + dC - AX}" height="${CH}" fill="transparent"/>${fuse}</g>` +
    `</g>` +
    // Everything right of the fuse hangs from the right edge: same layout, shifted
    // by however far the real width is past the one laid out.
    `<svg x="100%" y="0" width="1" height="${H}" overflow="visible"><g transform="translate(${-(CW + PAD)} ${OY})">` +
    `<rect x="${292 + dC}" y="10" width="1" height="24" fill="url(#div)"/>` +
    `<g class="seg"><title>${esc(tipD)}</title><rect x="${294 + dC}" y="0" width="${100 + dD}" height="${CH}" fill="transparent"/>${burn}</g>` +
    `<rect x="${396 + dC + dD}" y="10" width="1" height="24" fill="url(#div)"/>` +
    `<g class="seg"><title>${esc(tipE)}</title><rect x="${398 + dC + dD}" y="0" width="${EW - 398 - dC - dD}" height="${CH}" fill="transparent"/>` +
    `<g transform="translate(${MX} ${MY})" shape-rendering="crispEdges"><g>${party2}${stage}</g></g>${chevrons}${burst}</g>` +
    (ROOM ? `<rect x="${EW + 2}" y="10" width="1" height="24" fill="url(#div)"/>` : '') +
    `</g></svg>` +
    `</svg>`,
  )
}

/** Prefixes every id and every url(#…) reference with "halo-". */
const scopeIds = (svg: string) =>
  svg.replace(/ id="([^"]+)"/g, ' id="halo-$1"').replace(/url\(#([^)]+)\)/g, 'url(#halo-$1)')
