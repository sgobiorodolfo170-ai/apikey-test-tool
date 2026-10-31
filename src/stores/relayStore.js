import { defineStore } from 'pinia'
import { readRelay, saveRelay } from '../utils/storage.js'
import { RELAY_PRESETS } from '../data/relayPresets.js'
import { useToastStore } from './toastStore.js'

function bridge() {
  return typeof window !== 'undefined' ? window.electronAPI?.relay : null
}

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// 一个上游可以配多个 Key：apiKeys 为主，apiKey 兼容旧数据（存第一个）
function normalizeApiKeys(payload) {
  const list = Array.isArray(payload?.apiKeys) ? payload.apiKeys : []
  const keys = [...list, payload?.apiKey]
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter(Boolean)
  return [...new Set(keys)]
}

// IPC 参数必须是纯数据：Pinia 的响应式代理无法被结构化克隆
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

// 额度窗口：5 小时 / 7 天，按请求次数或积分（墨点）计量
function normalizeQuota(input) {
  const limit5h = Math.max(0, Number(input?.limit5h) || 0)
  const limitWeek = Math.max(0, Number(input?.limitWeek) || 0)
  return {
    enabled: input?.enabled === true && (limit5h > 0 || limitWeek > 0),
    metric: input?.metric === 'credit' ? 'credit' : 'request',
    limit5h,
    limitWeek,
    creditsPerMillionTokens: Math.max(0, Number(input?.creditsPerMillionTokens) || 0),
    confirmStrikes: Math.min(10, Math.max(0, Math.floor(Number(input?.confirmStrikes) || 0))),
    confirmIntervalMinutes: Math.max(0, Number(input?.confirmIntervalMinutes) || 0),
  }
}

// 本地端点访问 Key：生成后客户端必须带上它
function randomAccessKey() {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sk-relay-${hex}`
}

export const useRelayStore = defineStore('relay', {
  state: () => ({
    port: 8787,
    apiKey: '',
    clientKeys: [],
    sticky: false,
    cacheEnabled: false,
    cacheTtlMinutes: 5,
    autoStart: true,
    providers: [],
    running: false,
    status: null,
    loading: false,
    initialized: false,
    busyProviderId: null,
    logs: [],
    logsLoading: false,
    stats: [],
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
        this.apiKey = config.apiKey || ''
        this.clientKeys = config.clientKeys || []
        this.sticky = config.sticky === true
        this.cacheEnabled = config.cache?.enabled === true
        this.cacheTtlMinutes = Math.max(1, Math.round((config.cache?.ttlMs || 300000) / 60000))
        this.autoStart = config.autoStart !== false
        // 老配置没有额度窗口：按预设补上（商汤按次数、端砚按墨点），不改动用户已填的模型
        let quotaPatched = false
        this.providers = (config.providers || []).map((provider) => {
          if (provider.quota) return provider
          const preset = RELAY_PRESETS.find((item) => item.id === provider.presetId)
          if (!preset?.quota) return provider
          quotaPatched = true
          return { ...provider, quota: normalizeQuota(preset.quota) }
        })
        this.initialized = true
        // 补上的额度要落盘，主进程下次自启动才能带上窗口配置
        if (quotaPatched) await this.persist()
        await this.syncStatus()
      } catch (error) {
        useToastStore().addToast('读取中转站配置失败: ' + error.message, 'error')
      } finally {
        this.loading = false
      }
    },

    async persist() {
      const cache = { enabled: this.cacheEnabled, ttlMs: this.cacheTtlMinutes * 60000 }
      const clientKeys = plain(this.clientKeys)
      const saved = await saveRelay({
        port: this.port,
        apiKey: this.apiKey,
        clientKeys,
        sticky: this.sticky,
        autoStart: this.autoStart,
        cache,
        providers: plain(this.providers),
      })
      this.port = saved.port
      this.apiKey = saved.apiKey || ''
      this.clientKeys = saved.clientKeys || []
      this.sticky = saved.sticky === true
      this.providers = saved.providers
      // 运行中修改配置要同步给主进程，否则新模型 / 新 Key / 缓存设置不生效
      if (this.running && bridge()?.update) {
        const result = await bridge().update({
          port: this.port,
          apiKey: this.apiKey,
          clientKeys,
          sticky: this.sticky,
          cache,
          providers: plain(this.providers),
        })
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
      const result = await api.start({
        port: this.port,
        apiKey: this.apiKey,
        clientKeys: plain(this.clientKeys),
        sticky: this.sticky,
        cache: { enabled: this.cacheEnabled, ttlMs: this.cacheTtlMinutes * 60000 },
        providers: plain(this.providers),
      })
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

    async generateApiKey() {
      this.apiKey = randomAccessKey()
      await this.persist()
      useToastStore().addToast('已生成本地访问 Key', 'success')
      return this.apiKey
    },

    async clearApiKey() {
      this.apiKey = ''
      await this.persist()
      useToastStore().addToast('已清除本地访问 Key（本机免鉴权）', 'info')
    },

    async setCacheEnabled(enabled) {
      this.cacheEnabled = Boolean(enabled)
      await this.persist()
    },

    async setCacheTtlMinutes(minutes) {
      this.cacheTtlMinutes = Math.max(1, Math.min(1440, Number(minutes) || 5))
      await this.persist()
    },

    async setAutoStart(enabled) {
      this.autoStart = Boolean(enabled)
      await this.persist()
    },

    // 会话粘性：同一会话优先复用同一个上游 Key，减少跨家漂移
    async setSticky(enabled) {
      this.sticky = Boolean(enabled)
      await this.persist()
    },

    // 多客户端 Key：每个工具一把，日志里能看到是谁在调用
    async addClientKey(label) {
      const name = (label || '').trim() || `客户端${this.clientKeys.length + 1}`
      const item = { key: randomAccessKey(), label: name }
      this.clientKeys.push(item)
      await this.persist()
      useToastStore().addToast(`已添加客户端「${name}」`, 'success')
      return item
    },

    async renameClientKey(index, label) {
      const item = this.clientKeys[index]
      if (!item) return
      const name = (label || '').trim()
      if (!name) return
      item.label = name
      await this.persist()
    },

    async removeClientKey(index) {
      if (!this.clientKeys[index]) return
      this.clientKeys.splice(index, 1)
      await this.persist()
      useToastStore().addToast('已删除客户端 Key', 'info')
    },

    async addProvider(payload) {
      const apiKeys = normalizeApiKeys(payload)
      const provider = {
        id: newId(),
        name: payload.name?.trim() || '未命名提供商',
        baseUrl: (payload.baseUrl || '').trim(),
        apiKey: apiKeys[0] || '',
        apiKeys,
        modelAliases:
          payload.modelAliases && typeof payload.modelAliases === 'object'
            ? payload.modelAliases
            : {},
        models: Array.isArray(payload.models) ? payload.models.filter(Boolean) : [],
        enabled: payload.enabled !== false,
        maxConcurrency: Number(payload.maxConcurrency) > 0 ? Number(payload.maxConcurrency) : 4,
        rpmLimit: Number(payload.rpmLimit) > 0 ? Number(payload.rpmLimit) : 0,
        quota: normalizeQuota(payload.quota),
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
      const next = { ...this.providers[index], ...patch }
      // apiKey 始终跟随第一个 Key，旧读法（provider.apiKey）仍然有效
      if (Array.isArray(patch.apiKeys)) next.apiKey = normalizeApiKeys(patch)[0] || ''
      if (patch.quota) next.quota = normalizeQuota(patch.quota)
      this.providers[index] = next
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

    // 调用监控：按提供商 + 模型聚合的调用统计
    async loadStats() {
      const api = bridge()
      if (!api?.stats) return
      const result = await api.stats()
      if (result?.ok) this.stats = result.stats || []
    },

    async clearStats() {
      const api = bridge()
      if (api?.clearStats) await api.clearStats()
      this.stats = []
      useToastStore().addToast('已清空调用统计', 'info')
    },

    // 表单里的模型下拉：先拉一次上游列表，不写入已保存的提供商
    async previewModels(baseUrl, apiKeys = []) {
      const api = bridge()
      if (!api?.fetchModels) return []
      const keys = plain(apiKeys)
      const result = await api.fetchModels({
        baseUrl,
        apiKey: keys[0] || '',
        apiKeys: keys,
      })
      if (!result?.ok) {
        useToastStore().addToast(`拉取模型失败：${result?.error || '未知错误'}`, 'error')
        return []
      }
      return result.models || []
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
          apiKeys: plain(provider.apiKeys || []),
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
