import { defineStore } from 'pinia'
import { fetchLatestRelease, isNewerVersion } from '../utils/update.js'
import { APP_VERSION } from '../version.js'

export const useUpdateStore = defineStore('update', {
  state: () => ({
    currentVersion: APP_VERSION,
    latest: null,
    checking: false,
    checked: false,
    error: null,
  }),
  getters: {
    hasUpdate: (state) =>
      Boolean(state.latest) && isNewerVersion(state.latest.version, state.currentVersion),
    latestVersion: (state) => state.latest?.version || null,
    releaseUrl: (state) => state.latest?.url || null,
  },
  actions: {
    // 每次启动只查一次；失败静默处理（更新检查不该打扰使用）
    async check({ force = false } = {}) {
      if (this.checking) return
      if (this.checked && !force) return

      this.checking = true
      this.error = null
      try {
        this.latest = await fetchLatestRelease()
        this.checked = true
      } catch (error) {
        this.error = error.message || '检查更新失败'
      } finally {
        this.checking = false
      }
    },
  },
})
