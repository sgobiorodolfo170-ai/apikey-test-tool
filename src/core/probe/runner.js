// 探测编排：去重、并发、冷却与状态合并。纯逻辑，不直接发请求。
// 调用方传入 probe(target) -> { status, error, latencyMs, ... }。

import { nextProbeState } from './state.js'

function targetIdOf(target, index) {
  return String(target?.id ?? target?.model ?? target?.keyTail ?? `target-${index}`)
}

export function createProbeRunner({
  probe,
  concurrency = 3,
  now = () => Date.now(),
  defaultCooldownMs = 5000,
} = {}) {
  if (typeof probe !== 'function') throw new Error('createProbeRunner 需要 probe 函数')

  const records = new Map()
  const inFlight = new Map()

  async function execute(target, id, force) {
    const previous = records.get(id)
    const timestamp = now()
    if (!force && previous && previous.cooldownUntil > timestamp) {
      return { ...previous, id, skipped: true }
    }

    let pending = inFlight.get(id)
    if (!pending) {
      pending = Promise.resolve().then(() => probe(target))
      inFlight.set(id, pending)
    }

    try {
      const raw = await pending
      const next = nextProbeState(previous?.state || 'unknown', raw, now())
      const record = {
        id,
        target,
        ...next,
        cooldownUntil: now() + (next.cooldownMs ?? defaultCooldownMs),
      }
      records.set(id, record)
      return record
    } finally {
      if (inFlight.get(id) === pending) inFlight.delete(id)
    }
  }

  return {
    async run(targets = [], { force = false } = {}) {
      const unique = []
      const seen = new Set()
      targets.forEach((target, index) => {
        const id = targetIdOf(target, index)
        if (seen.has(id)) return
        seen.add(id)
        unique.push({ id, target })
      })

      const queue = [...unique]
      const results = []
      const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), queue.length) },
        async () => {
          while (queue.length > 0) {
            const item = queue.shift()
            results.push(await execute(item.target, item.id, force))
          }
        },
      )
      await Promise.all(workers)
      return results
    },
    get(id) {
      return records.get(String(id)) || null
    },
    snapshot() {
      return [...records.values()].map((item) => ({ ...item }))
    },
    reset() {
      records.clear()
      inFlight.clear()
    },
  }
}
