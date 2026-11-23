import { describe, expect, it } from 'vitest'
import { createProbeRunner } from '../runner.js'
import { nextProbeState } from '../state.js'

describe('probe runner', () => {
  it('dedupes targets by id and runs probes', async () => {
    let calls = 0
    const runner = createProbeRunner({
      probe: async (target) => {
        calls += 1
        return { status: target.status, latencyMs: 12 }
      },
      concurrency: 2,
      now: () => 1000,
    })

    const results = await runner.run([
      { id: 'same', status: 200 },
      { id: 'same', status: 200 },
      { id: 'other', status: 401 },
    ])

    expect(calls).toBe(2)
    expect(results).toHaveLength(2)
    expect(results.find((item) => item.id === 'same').state).toBe('reachable')
    expect(results.find((item) => item.id === 'other').state).toBe('rejected')
  })

  it('respects cooldown and allows force', async () => {
    let current = 1000
    let calls = 0
    const runner = createProbeRunner({
      probe: async () => {
        calls += 1
        return { status: 500 }
      },
      now: () => current,
    })

    const first = await runner.run([{ id: 'a' }])
    expect(first[0].state).toBe('unknown')
    expect(first[0].cooldownUntil).toBe(6000)

    current = 2000
    const skipped = await runner.run([{ id: 'a' }])
    expect(skipped[0].skipped).toBe(true)
    expect(calls).toBe(1)

    const forced = await runner.run([{ id: 'a' }], { force: true })
    expect(forced[0].skipped).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('shares an in-flight probe between concurrent runs', async () => {
    let calls = 0
    let resolveProbe
    const runner = createProbeRunner({
      probe: () => {
        calls += 1
        return new Promise((resolve) => {
          resolveProbe = resolve
        })
      },
      now: () => 1000,
    })

    const left = runner.run([{ id: 'x' }])
    const right = runner.run([{ id: 'x' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveProbe({ status: 200 })
    const [a, b] = await Promise.all([left, right])

    expect(calls).toBe(1)
    expect(a[0].state).toBe('reachable')
    expect(b[0].state).toBe('reachable')
  })

  it('keeps previous reachable state on transient 5xx', () => {
    expect(nextProbeState('reachable', { status: 500 }).state).toBe('reachable')
    expect(nextProbeState('unknown', { status: 500 }).state).toBe('unknown')
  })
})
