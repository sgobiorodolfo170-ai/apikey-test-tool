import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../utils/update.js', () => ({
  fetchLatestRelease: vi.fn(),
  isNewerVersion: (latest, current) => {
    const a = String(latest).split('.').map(Number)
    const b = String(current).split('.').map(Number)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] || 0) - (b[i] || 0)
      if (diff !== 0) return diff > 0
    }
    return false
  },
}))

import { useUpdateStore } from '../updateStore.js'
import { fetchLatestRelease } from '../../utils/update.js'

describe('updateStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('flags an update when the remote version is newer', async () => {
    fetchLatestRelease.mockResolvedValue({ version: '99.0.0', url: 'https://github.com/x' })
    const store = useUpdateStore()

    await store.check()

    expect(store.hasUpdate).toBe(true)
    expect(store.latestVersion).toBe('99.0.0')
    expect(store.releaseUrl).toBe('https://github.com/x')
    expect(store.checked).toBe(true)
  })

  it('stays quiet when already up to date', async () => {
    const store = useUpdateStore()
    fetchLatestRelease.mockResolvedValue({
      version: store.currentVersion,
      url: 'https://github.com/x',
    })

    await store.check()

    expect(store.hasUpdate).toBe(false)
  })

  it('only checks once unless forced', async () => {
    fetchLatestRelease.mockResolvedValue({ version: '99.0.0', url: 'https://github.com/x' })
    const store = useUpdateStore()

    await store.check()
    await store.check()
    expect(fetchLatestRelease).toHaveBeenCalledTimes(1)

    await store.check({ force: true })
    expect(fetchLatestRelease).toHaveBeenCalledTimes(2)
  })

  it('swallows failures so the UI is never blocked', async () => {
    fetchLatestRelease.mockRejectedValue(new Error('rate limited'))
    const store = useUpdateStore()

    await store.check()

    expect(store.error).toContain('rate limited')
    expect(store.hasUpdate).toBe(false)
    expect(store.checking).toBe(false)
  })
})
