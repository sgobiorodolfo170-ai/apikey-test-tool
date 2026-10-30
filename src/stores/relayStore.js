import { defineStore } from 'pinia'
import { readRelay, saveRelay } from '../utils/storage.js'
import { useToastStore } from './toastStore.js'

function bridge() {
  return typeof window !== 'undefined' ? window.electronAPI?.relay : null
}

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export const useRelayStore = defineStore('relay', {
  state: () => ({
    port: 8787,
    providers: [],
    running: false,
    status: null,
    loading: false,
    initialized: false,
    busyProviderId: null,
    logs: [],
    logsLoading: false,
  }),
  getters: {
    baseUrl: (state) => state.status?.baseUrl || `http://127.0.0.1:${state.port}/v1`,
    enabledCount: (state) => state.providers.filter((item) => item.enabled !== false).length,
    modelCount: (state) => {
      const seen = new Set()
      for (const provider of state.providers) {
        if (provider.enabled === false) continue
        for (const model of provider.models || []) seen.add(model)
      }
      return seen.size
    },
  },
  actions: {
    async load() {
      if (this.loading) return
      this.loading = true
      try {
        const config = await readRelay()
        this.port = config.port
        this.providers = config.providers
        this.initialized = true
        await this.syncStatus()
      } catch (error) {
        useToastStore().addToast('读取中转站配置失败: ' + error.message, 'error')
      } finally {
        this.loading = false
      }
    },

    async persist() {
      const saved = await saveRelay({ port: this.port, providers: this.providers })
      this.port = saved.port
      this.providers = saved.providers
      // 运行中修改配置要同步给主进程，否则新模型不生效
      if (this.running && bridge()?.update) {
        const result = await bridge().update({ port: this.port, providers: this.providers })
        if (result?.status) this.status = result.status
      }
    },

    async syncStatus() {
      const api = bridge()
      if (!api?.status) return
      try {
        const result = await api.status()
        if (result?.ok) {
          this.status = result.status
          this.running = Boolean(result.status?.running)
        }
      } catch {
        // 状态查询失败不影响使用
      }
    },

    async start() {
      const api = bridge()
      if (!api?.start) {
        useToastStore().addToast('当前环境不支持启动中转服务', 'error')
        return false
      }
      const result = await api.start({ port: this.port, providers: this.providers })
      if (!result?.ok) {
        useToastStore().addToast(result?.error || '启动失败', 'error')
        return false
      }
      this.running = true
      this.status = result.status
      useToastStore().addToast(`中转站已启动：${this.baseUrl}`, 'success')
      return true
    },

    async stop() {
      const api = bridge()
      if (!api?.stop) return
      const result = await api.stop()
      if (result?.status) this.status = result.status
      this.running = false
      useToastStore().addToast('中转站已停止', 'info')
    },

    async setPort(port) {
      const next = Number(port)
      if (!Number.isFinite(next) || next < 1024 || next > 65535) {
        useToastStore().addToast('端口需在 1024-65535 之间', 'warning')
        return
      }
      this.port = next
      await this.persist()
    },

    async addProvider(payload) {
      const provider = {
        id: newId(),
        name: payload.name?.trim() || '未命名提供商',
        baseUrl: (payload.baseUrl || '').trim(),
        apiKey: payload.apiKey || '',
        models: Array.isArray(payload.models) ? payload.models.filter(Boolean) : [],
        enabled: payload.enabled !== false,
        maxConcurrency: Number(payload.maxConcurrency) > 0 ? Number(payload.maxConcurrency) : 4,
        rpmLimit: Number(payload.rpmLimit) > 0 ? Number(payload.rpmLimit) : 0,
        presetId: payload.presetId,
        createdAt: new Date().toISOString(),
      }
      this.providers.push(provider)
      await this.persist()
      useToastStore().addToast(`已添加提供商「${provider.name}」`, 'success')
      return provider
    },

    async updateProvider(id, patch) {
      const index = this.providers.findIndex((item) => item.id === id)
      if (index === -1) return
      this.providers[index] = { ...this.providers[index], ...patch }
      await this.persist()
    },

    async removeProvider(id) {
      this.providers = this.providers.filter((item) => item.id !== id)
      await this.persist()
    },

    async toggleProvider(id) {
      const provider = this.providers.find((item) => item.id === id)
      if (!provider) return
      await this.updateProvider(id, { enabled: provider.enabled === false })
    },

    // 调整提供商顺序（顺序即故障转移优先级）
    async moveProvider(id, direction) {
      const index = this.providers.findIndex((item) => item.id === id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= this.providers.length) return
      const next = [...this.providers]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      this.providers = next
      await this.persist()
    },

    async loadLogs() {
      const api = bridge()
      if (!api?.logs) return
      this.logsLoading = true
      try {
        const result = await api.logs()
        if (result?.ok) this.logs = result.logs
        await this.syncStatus()
      } finally {
        this.logsLoading = false
      }
    },

    async clearLogs() {
      const api = bridge()
      if (!api?.clearLogs) return
      const result = await api.clearLogs()
      if (result?.ok) this.logs = []
    },

    // 从上游拉取模型列表，省得手抄模型名
    async fetchModels(id) {
      const provider = this.providers.find((item) => item.id === id)
      const api = bridge()
      if (!provider || !api?.fetchModels) return

      this.busyProviderId = id
      try {
        const result = await api.fetchModels({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
        })
        if (!result?.ok) {
          useToastStore().addToast(`拉取模型失败：${result?.error || '未知错误'}`, 'error')
          return
        }
        if (result.models.length === 0) {
          useToastStore().addToast('上游没有返回任何模型', 'warning')
          return
        }
        await this.updateProvider(id, { models: result.models })
        useToastStore().addToast(`已获取 ${result.models.length} 个模型`, 'success')
      } finally {
        this.busyProviderId = null
      }
    },
  },
})
