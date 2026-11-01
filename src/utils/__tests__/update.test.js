import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/http.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), stream: vi.fn() },
}))

import http from '../../api/http.js'
import {
  compareVersions,
  normalizeVersion,
  parseRelease,
  fetchLatestRelease,
  isNewerVersion,
} from '../update.js'

describe('normalizeVersion', () => {
  it('strips the leading v', () => {
    expect(normalizeVersion('v1.2.0')).toBe('1.2.0')
    expect(normalizeVersion('V1.2.0')).toBe('1.2.0')
    expect(normalizeVersion(' 1.2.0 ')).toBe('1.2.0')
    expect(normalizeVersion(null)).toBe('')
  })
})

describe('compareVersions', () => {
  it('compares each segment numerically', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBe(1)
    expect(compareVersions('1.1.0', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    // 字符串比较会认为 1.9 > 1.10，这里必须是数字比较
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('v2.0.0', '1.99.99')).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBe(1)
  })
})

describe('parseRelease', () => {
  it('extracts version and url', () => {
    const release = parseRelease({
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/x/y/releases/tag/v1.2.0',
      name: 'v1.2.0 渠道对比',
      published_at: '2026-10-29T00:00:00Z',
    })

    expect(release).toEqual({
      version: '1.2.0',
      url: 'https://github.com/x/y/releases/tag/v1.2.0',
      name: 'v1.2.0 渠道对比',
      publishedAt: '2026-10-29T00:00:00Z',
    })
  })

  it('returns null for unusable payloads', () => {
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease({})).toBeNull()
    expect(parseRelease('oops')).toBeNull()
  })
})

describe('fetchLatestRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the latest release through the http facade', async () => {
    http.get.mockResolvedValue({ data: { tag_name: 'v1.3.0', html_url: 'https://github.com/a/b' } })

    const release = await fetchLatestRelease()

    expect(release.version).toBe('1.3.0')
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(http.get.mock.calls[0][0]).toContain('api.github.com')
  })

  it('throws when the payload has no tag', async () => {
    http.get.mockResolvedValue({ data: {} })
    await expect(fetchLatestRelease()).rejects.toThrow('未获取到版本信息')
  })

  it('propagates network errors', async () => {
    http.get.mockRejectedValue(new Error('429 rate limited'))
    await expect(fetchLatestRelease()).rejects.toThrow('429')
  })

  it('uses direct fetch in the desktop renderer', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v1.9.0', html_url: 'https://github.com/a/b' }),
    }))
    window.electronAPI = { request: vi.fn() }

    try {
      const release = await fetchLatestRelease()
      expect(release.version).toBe('1.9.0')
      expect(http.get).not.toHaveBeenCalled()
    } finally {
      delete window.electronAPI
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to the http facade when direct fetch fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      throw new Error('blocked')
    })
    window.electronAPI = { request: vi.fn() }
    http.get.mockResolvedValue({ data: { tag_name: 'v1.8.0', html_url: 'https://x' } })

    try {
      const release = await fetchLatestRelease()
      expect(release.version).toBe('1.8.0')
      expect(http.get).toHaveBeenCalledTimes(1)
    } finally {
      delete window.electronAPI
      globalThis.fetch = originalFetch
    }
  })
})

describe('isNewerVersion', () => {
  it('only reports strictly newer versions', () => {
    expect(isNewerVersion('1.3.0', '1.2.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.1.9', '1.2.0')).toBe(false)
  })
})
