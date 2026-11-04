import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

describe('按 Key 调用窗口统计', () => {
  let upstream
  let info

  beforeAll(async () => {
    relay.clearStats()
    upstream = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    info = await relay.start({
      port: 0,
      providers: [
        {
          id: 'p',
          name: '上游A',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          apiKeys: ['sk-window-111111'],
          models: ['m'],
          enabled: true,
        },
      ],
    })
  })

  afterAll(() => {
    relay.stop()
    upstream.close()
    relay.clearStats()
  })

  it('counts the call in hour / 5h / day / 7d / month windows', async () => {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect(response.status).toBe(200)

    const rows = relay.getKeyUsage()
    expect(rows).toHaveLength(1)
    expect(rows[0].keyTail).toBe('111111')
    expect(rows[0].windows.hour).toMatchObject({
      calls: 1,
      success: 1,
      prompt: 1,
      completion: 1,
      total: 2,
    })
    expect(rows[0].windows.hour.lastAt).toBeTruthy()
    expect(rows[0].windows.hours5.calls).toBe(1)
    expect(rows[0].windows.day.total).toBe(2)
    expect(rows[0].windows.days7.success).toBe(1)
    expect(rows[0].windows.month.calls).toBe(1)
  })
})
