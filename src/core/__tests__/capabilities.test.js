import { afterEach, describe, expect, it } from 'vitest'
import {
  capabilityStatusLabel,
  detectCapabilities,
  logCapabilitySnapshot,
} from '../capabilities.js'

function row(rows, id) {
  return rows.find((item) => item.id === id)
}

afterEach(() => {
  delete window.electronAPI
})

describe('capability matrix', () => {
  it('degrades optional capabilities when the desktop bridge is missing', () => {
    const rows = detectCapabilities()
    expect(row(rows, 'gateway').status).toBe('unavailable')
    expect(row(rows, 'lan').status).toBe('degraded')
    expect(row(rows, 'channels').status).toBe('degraded')
    expect(row(rows, 'lan').detail).toBe('仅回环')
  })

  it('marks available capabilities when the bridge exposes them', () => {
    window.electronAPI = {
      relay: { start: () => {}, status: () => {} },
      request: () => {},
      channel: { list: () => {} },
    }
    const rows = detectCapabilities()
    expect(row(rows, 'gateway').status).toBe('available')
    expect(row(rows, 'lan').status).toBe('available')
    expect(row(rows, 'updater').status).toBe('available')
    expect(row(rows, 'channels').status).toBe('available')
    expect(row(rows, 'tray').status).toBe('available')
  })

  it('does not report updater availability from a bare fetch', () => {
    // 渲染进程永远有 fetch；没有桌面 HTTP 桥时不得谎报「在线更新可用」
    window.electronAPI = {}
    const rows = detectCapabilities()
    expect(row(rows, 'updater').status).toBe('degraded')
    expect(row(rows, 'lan').status).toBe('degraded')
  })

  it('keeps status labels stable', () => {
    expect(capabilityStatusLabel('available')).toBe('可用')
    expect(capabilityStatusLabel('degraded')).toBe('未启用')
    expect(capabilityStatusLabel('unavailable')).toBe('不可用')
  })

  it('logs a snapshot without throwing', () => {
    expect(() => logCapabilitySnapshot()).not.toThrow()
  })
})
