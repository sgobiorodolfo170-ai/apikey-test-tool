import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

describe('运行诊断日志', () => {
  const file = path.join(os.tmpdir(), `relay-diagnostics-${Date.now()}-${process.pid}.json`)

  afterAll(async () => {
    await relay.clearDiagnostics()
    try {
      fs.rmSync(file)
    } catch {
      // 文件可能已不存在
    }
  })

  it('records relay start and stop events', async () => {
    await relay.clearDiagnostics()
    const info = await relay.start({ port: 0, providers: [] })
    await relay.stop()

    const list = relay.getDiagnostics()
    expect(info.port).toBeGreaterThan(0)
    expect(list.some((item) => item.category === '启动' && item.message === '中转站已启动')).toBe(
      true,
    )
    expect(list.some((item) => item.category === '停止' && item.message === '中转站已停止')).toBe(
      true,
    )
  })

  it('persists diagnostics and drops entries older than 30 days on restore', async () => {
    const now = Date.now()
    const hour = 60 * 60 * 1000
    fs.writeFileSync(
      file,
      JSON.stringify({
        diagnostics: [
          {
            id: 'fresh',
            at: new Date(now - hour).toISOString(),
            level: 'warn',
            category: '额度',
            message: '三小时内的事件',
            detail: '',
          },
          {
            id: 'two-days',
            at: new Date(now - 48 * hour).toISOString(),
            level: 'info',
            category: '启动',
            message: '两天前的事件',
            detail: '',
          },
          {
            id: 'forty-days',
            at: new Date(now - 40 * 24 * hour).toISOString(),
            level: 'error',
            category: '上游',
            message: '四十天前的事件',
            detail: '',
          },
        ],
      }),
    )

    relay.attachStorage(file)

    expect(relay.getDiagnostics().map((item) => item.id)).toEqual(['fresh', 'two-days'])

    relay.pushDiagnostic('error', '上游', '上游连接失败', '模型 gpt-4o · 连接超时')
    const [latest] = relay.getDiagnostics()
    expect(latest).toMatchObject({
      level: 'error',
      category: '上游',
      message: '上游连接失败',
      detail: '模型 gpt-4o · 连接超时',
    })

    await relay.persistNow()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.diagnostics[0].message).toBe('上游连接失败')
    expect(saved.diagnostics).toHaveLength(3)

    await relay.clearDiagnostics()
    expect(relay.getDiagnostics()).toEqual([])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).diagnostics).toEqual([])
  })
})
