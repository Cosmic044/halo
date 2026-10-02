/** One rate-limit window: how full it is (0-100) and when it resets (epoch ms). */
export type HaloWindow = { pct: number; resetsAt: number | null }

/** The prompt cache as the last main-thread request left it. */
export type HaloCache = {
  /** When the last main-thread request finished (epoch ms); 0 before the first. */
  lastAt: number
  /** Share of that request's input the cache served, 0-1. */
  hit: number
  /** Tokens the next request re-sends (what a cold cache re-writes). */
  tokens: number
  /** Cache lifetime in ms (5m or 1h). */
  ttlMs: number
  /** A turn is running, so every request keeps the cache warm. */
  isLive: boolean
}

/** The status-line figures: rate-limit windows, context fill, session cost. */
export type HaloMeter = {
  five: HaloWindow | null
  seven: HaloWindow | null
  /** The Fable-only weekly window, from Cosmic Pulse's usage cache; absent when nobody reported it. */
  fable?: HaloWindow | null
  ctxPct: number | null
  ctxTokens: number | null
  window: number
  usd: number | null
}

/** One next-step chip: what it says, and the prompt it fills in. */
export type HaloNext = { label: string; prompt: string }

export type HaloTtl = 'auto' | '5m' | '1h'

export type HaloTheme = 'violet' | 'black'

export type HaloPrefs = { isHidden: boolean; hasChips: boolean; ttl: HaloTtl; theme?: HaloTheme }

declare module 'claude-code' {
  interface PluginState {
    halo: {
      cache: HaloCache
      meter: HaloMeter
      burn: number[]
      next: HaloNext[]
      prefs: HaloPrefs
      tick: number
      isColdSoon: boolean
      /** When the last turn finished or compaction landed (epoch ms): the party's start. */
      partyAt: number
      /** A compaction Halo asked for is running. */
      isCompacting: boolean
    }
  }
}
