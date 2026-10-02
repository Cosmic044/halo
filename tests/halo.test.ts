import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelUsage, RenderPropsOf } from 'claude-code'

import { parseChips } from '../hooks/register'
import { countdown, fuseAt, fuseTimeline, hud, fmtDur } from '../hooks/svg'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const USAGE = {
  startedAt: 0,
  context: { tokens: 96_000, window: 200_000, percent: 48 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-02T14:00:00Z' },
    { kind: 'seven_day', percentUsed: 31 },
  ],
  cost: { usd: 4.12 },
}

describe('the svg builder', () => {
  test('counts down in minutes, then seconds, back to back', () => {
    const ticks = countdown(130)
    expect(ticks.map(t => t[0]).slice(0, 3)).toEqual(['3m', '2m', '60s'])
    expect(ticks.at(-1)?.[0]).toBe('1s')
    for (let k = 1; k < ticks.length; k++) expect(Math.abs(ticks[k]![1] - ticks[k - 1]![2])).toBeLessThan(1e-6)
    expect(Math.abs((ticks.at(-1)?.[2] ?? 0) - 130)).toBeLessThan(1e-6)
  })

  test('the fuse burns teal to amber to rose on a rising timeline', () => {
    expect(fuseAt(1)[0]).toBe('#34d399')
    expect(fuseAt(0)[0]).toBe('#fb7185')
    const t = fuseTimeline(0.9, 3600, 3240, 0)
    const keys = t.keyTimes.split(';').map(Number)
    expect(keys[0]).toBe(0)
    expect(keys.at(-1)).toBe(1)
    for (let k = 1; k < keys.length; k++) expect(keys[k]!).toBeGreaterThan(keys[k - 1]!)
    expect(t.values.split(';')).toHaveLength(keys.length)
  })

  test('the busiest moment still fits the Svg size limit', () => {
    const svg = hud({
      now: 1_000,
      cache: { lastAt: 1_000, hit: 0.98, tokens: 96_000, ttlMs: 3_600_000, isLive: false },
      meter: { five: { pct: 92, resetsAt: 8_000_000 }, seven: { pct: 31, resetsAt: null }, ctxPct: 91, ctxTokens: 182_000, window: 200_000, usd: 12.4 },
      burn: Array.from({ length: 24 }, (_, k) => k / 10),
      isWorking: false,
      from: { five: 0, seven: 0 },
      isNewBurn: true,
      celebrateAt: 1_000,
      isUrgent: true,
    })
    expect(svg.length).toBeLessThan(131_072 * 0.8)
    expect(svg).toStartWith('<svg')
    expect(svg).toContain('60m')
    expect(svg).not.toContain('ctx')
    expect(fmtDur(2 * 3_600_000 + 14 * 60_000)).toBe('2h14')
  })

  test('the mascot follows the cache: shreds while live, sleeps in the snow when cold', () => {
    const base = {
      now: 10_000_000,
      meter: { five: { pct: 40, resetsAt: null }, seven: null, ctxPct: 30, ctxTokens: 60_000, window: 200_000, usd: 1 },
      burn: [],
      from: { five: 0.4, seven: 0 },
      isNewBurn: false,
    }
    const live = hud({ ...base, isWorking: true, cache: { lastAt: 9_990_000, hit: 0.9, tokens: 60_000, ttlMs: 300_000, isLive: true } })
    expect(live).toContain('#2A2140') // the guitar
    expect(live).toContain('LIVE')
    const cold = hud({ ...base, isWorking: false, cache: { lastAt: 1_000, hit: 0.9, tokens: 60_000, ttlMs: 300_000, isLive: false } })
    expect(cold).toContain('#F8FAFF') // the snow cap
    expect(cold).toContain('cold')
    expect(cold).not.toContain('#2A2140')
  })
})

describe('next-step chips', () => {
  test('reads a JSON array out of a chatty reply and keeps three', () => {
    const chips = parseChips(
      'Sure:\n[{"label":"Commit the tracker.","prompt":"Commit it."},{"label":"Polish","prompt":"Polish it"},{"label":"a","prompt":"b"},{"label":"d","prompt":"e"}]',
    )
    expect(chips).toHaveLength(3)
    expect(chips[0]).toEqual({ label: 'Commit the tracker', prompt: 'Commit it.' })
    expect(parseChips('no json here')).toEqual([])
  })

  test('a finished turn grows chips, a chip fills the prompt, typing clears them', async ($, on) => {
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    mock.store(on)
    let filled = ''
    on('session.usage', () => ({ value: USAGE }))
    on('session.messages', () => ({ value: [{ role: 'user', text: 'build the habit tracker', toolUses: [] }] }))
    on('model.complete', () => ({
      value: {
        isAnswered: true as const,
        text: '[{"label":"Commit the habit tracker","prompt":"Commit the habit tracker."}]',
        usage: ZERO,
      },
    }))
    on('prompt.fill', ($, e) => {
      filled = e.text
      return { isFilled: true }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.complete({ answer: 'Done: habits/index.html.', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(1)

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'halo', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ key: 'next-0' })).toBeDefined()
      if (surface === 'desktop') {
        const svg = await ui.find({ type: 'Svg' })
        expect(String(svg?.props.alt)).toContain('5h 62%')
      }
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'halo', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'next-0' })
    expect(filled).toBe('Commit the habit tracker.')
    expect(await ui.find({ key: 'next-0' })).toBeUndefined()
    await ui.unmount()
  })
})
