import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

describe('请求日志保留最近 3 天', () => {
  const file = path.join(os.tmpdir(), `relay-log-retention-${Date.now()}-${process.pid}.json`)

  afterAll(async () => {
    await relay.clearLogs()
    try {
      fs.rmSync(file)
    } catch {
      // 文件可能已不存在
    }
  })

  it('drops logs older than 3 days when restored', () => {
    const now = Date.now()
    const hour = 60 * 60 * 1000
    fs.writeFileSync(
      file,
      JSON.stringify({
        logs: [
          { id: 'fresh', at: new Date(now - hour).toISOString() },
          { id: 'two-days', at: new Date(now - 48 * hour).toISOString() },
          { id: 'four-days', at: new Date(now - 96 * hour).toISOString() },
        ],
        stats: [],
        daily: [],
        hourly: [],
        keys: [],
      }),
    )

    relay.attachStorage(file)

    expect(relay.getLogs().map((log) => log.id)).toEqual(['fresh', 'two-days'])
  })
})
