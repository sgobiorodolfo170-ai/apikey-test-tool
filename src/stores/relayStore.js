import { defineStore } from 'pinia'
import { readRelay, saveRelay } from '../utils/storage.js'
import { normalizeAutoProbe, normalizeQuota } from '../utils/relayConfig.js'
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

// 额度窗口的归一化由 utils/relayConfig.js 共用（与 electron/relay.cjs 保持同口径）

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
    cacheMaxEntries: 200,
    autoStart: true,
    // 模型未命中时回退到的默认上游（空＝未命中即 404，行为不变）
    defaultProviderId: '',
    // 局域网访问默认关闭；开启必须先设访问 Key，且需重启中转站生效
    lanEnabled: false,
    providers: [],
    running: false,
    status: null,
    loading: false,
    initialized: false,
    busyProviderId: null,
    logs: [],
    logsLoading: false,
    diagnostics: [],
    diagnosticsLoading: false,
    observations: [],
    observationsLoading: false,
    stats: [],
    tokenHistory: [],
    tokenHourly: [],
    keyUsage: [],
    // 手动「立即探测」进行中：按钮转圈，避免重复触发
    keyProbing: false,
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
    // 局域网是否真正生效（运行中且监听非回环）；配置开了但没重启时为 false
    lanActive: (state) => state.status?.lan?.active === true,
    lanAddresses: (state) => state.status?.lan?.addresses || [],
    defaultProviderName: (state) =>
      state.providers.find((item) => item.id === state.defaultProviderId)?.name || '',
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
        this.cacheMaxEntries = Math.max(10, Number(config.cache?.maxEntries) || 200)
        this.autoStart = config.autoStart !== false
        this.defaultProviderId = config.defaultProviderId || ''
        this.lanEnabled = config.lan?.enabled === true
        // 额度配置统一归一化为「真实响应自动保护」：
        // 旧的次数 / 积分 / 墨点字段在这里被丢弃，不会继续影响判定。
        let configPatched = false
        this.providers = (config.providers || []).map((provider) => {
          const preset = RELAY_PRESETS.find((item) => item.id === provider.presetId)
          let next = provider
          // 以预设的自动保护参数为底，只保留旧配置里仍然有效的确认参数与共享组，
          // 旧的次数 / 积分 / 墨点字段直接丢弃
          const rawQuota = next.quota || {}
          const mergedQuota = { ...(preset?.quota || {}) }
          if (rawQuota.enabled !== undefined) mergedQuota.enabled = rawQuota.enabled === true
          for (const key of [
            'confirmStrikes',
            'confirmIntervalMinutes',
            'confirmSpanMinutes',
            'burstWindowMinutes',
            'burstStrikes',
            'warmupMinutes',
          ]) {
            if (Number(rawQuota[key]) > 0) mergedQuota[key] = Number(rawQuota[key])
          }
          if (typeof rawQuota.group === 'string') mergedQuota.group = rawQuota.group
          if (Array.isArray(rawQuota.groups)) mergedQuota.groups = rawQuota.groups
          if (rawQuota.keyGroups && typeof rawQuota.keyGroups === 'object') {
            mergedQuota.keyGroups = rawQuota.keyGroups
          }
          const quota = normalizeQuota(mergedQuota)
          if (!next.quota || JSON.stringify(next.quota) !== JSON.stringify(quota)) {
            next = { ...next, quota }
            configPatched = true
          }
          // 端砚专项限流仍需要 strategy 与默认并发 / RPM / 排队参数
          if (preset?.strategy === 'duanyan') {
            const patch = {}
            if (next.strategy !== 'duanyan') patch.strategy = 'duanyan'
            // 4 是历史默认值，未显式改过时升级到预设的 8。
            // 一次性迁移：落盘 limitsMigrated 标记后不再按值判断，
            // 避免用户刻意设置的 4 每次加载都被重置。
            if (next.limitsMigrated !== true) {
              if (!(Number(next.maxConcurrency) > 0) || Number(next.maxConcurrency) === 4) {
                patch.maxConcurrency = preset.maxConcurrency
              }
              patch.limitsMigrated = true
            }
            if (!(Number(next.rpmLimit) > 0)) patch.rpmLimit = preset.rpmLimit
            if (!(Number(next.queueTimeoutMs) > 0)) patch.queueTimeoutMs = preset.queueTimeoutMs
            if (Object.keys(patch).length > 0) {
              next = { ...next, ...patch }
              configPatched = true
            }
          }
          return next
        })
        this.initialized = true
        // 归一化后的配置要落盘，主进程下次自启动才能带上新的自动保护参数
        if (configPatched) await this.persist()
        await this.syncStatus()
      } catch (error) {
        useToastStore().addToast('读取中转站配置失败: ' + error.message, 'error')
      } finally {
        this.loading = false
      }
    },

    async persist() {
      const cache = {
        enabled: this.cacheEnabled,
        ttlMs: this.cacheTtlMinutes * 60000,
        maxEntries: this.cacheMaxEntries,
      }
      const clientKeys = plain(this.clientKeys)
      const saved = await saveRelay({
        port: this.port,
        apiKey: this.apiKey,
        clientKeys,
        sticky: this.sticky,
        autoStart: this.autoStart,
        defaultProviderId: this.defaultProviderId,
        lan: { enabled: this.lanEnabled },
        cache,
        providers: plain(this.providers),
      })
      this.port = saved.port
      this.apiKey = saved.apiKey || ''
      this.clientKeys = saved.clientKeys || []
      this.sticky = saved.sticky === true
      this.defaultProviderId = saved.defaultProviderId || ''
      this.lanEnabled = saved.lan?.enabled === true
      this.providers = saved.providers
      // 运行中修改配置要同步给主进程，否则新模型 / 新 Key / 缓存设置不生效
      if (this.running && bridge()?.update) {
        const result = await bridge().update({
          port: this.port,
          apiKey: this.apiKey,
          clientKeys,
          sticky: this.sticky,
          defaultProviderId: this.defaultProviderId,
          lan: { enabled: this.lanEnabled },
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

    // 手动解除某个提供商的 429 额度锁：保留用量，只清锁定与等级记忆
    async unlockQuota(providerId) {
      const api = bridge()
      if (!api?.unlockQuota) return
      const result = await api.unlockQuota(providerId)
      if (result?.status) this.status = result.status
      const cleared = Number(result?.cleared) || 0
      if (cleared > 0) {
        useToastStore().addToast(`已解除 ${cleared} 条额度锁定，可重新尝试调用`, 'success')
      } else {
        useToastStore().addToast('没有需要解除的额度锁定', 'info')
      }
      await this.syncStatus()
    },

    // 手动触发一轮 Key 额度探测（全部或指定提供商）：
    // 主进程对每把 Key 发一次最小化真实调用，结果并入 status.keyProbe 快照；
    // 429 会走与真实流量同口径的连续确认，401/403 标记 Key 无效
    async probeNow(providerId = '') {
      const api = bridge()
      if (!api?.probeKeys) {
        useToastStore().addToast('当前环境不支持额度探测', 'error')
        return null
      }
      this.keyProbing = true
      try {
        const result = await api.probeKeys(providerId || '')
        if (result?.status) this.status = result.status
        const skipped = (result?.results || []).filter((item) => !item.ok)
        if (skipped.length > 0) {
          const reasonText = {
            no_keys: '没有配置 Key',
            no_model: '没有可用的探测模型',
            already_running: '探测进行中',
            disabled: '提供商已停用',
          }
          useToastStore().addToast(
            `${skipped.length} 个提供商未探测：${skipped
              .map((item) => `${item.name}（${reasonText[item.reason] || item.reason || '失败'}）`)
              .join('、')}`,
            'warning',
          )
        } else {
          useToastStore().addToast('额度探测完成，结果已更新', 'success')
        }
        return result
      } finally {
        this.keyProbing = false
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
        defaultProviderId: this.defaultProviderId,
        lan: { enabled: this.lanEnabled },
        cache: {
          enabled: this.cacheEnabled,
          ttlMs: this.cacheTtlMinutes * 60000,
          maxEntries: this.cacheMaxEntries,
        },
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
      if (this.running) {
        useToastStore().addToast('请先停止中转站，再修改端口', 'warning')
        return
      }
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

    // 默认上游：模型未命中时回退到它；只写 defaultProviderId，不碰任何凭据。
    // 传空字符串＝取消默认（恢复「未命中即 404」）。
    async setDefaultProvider(id) {
      const next = typeof id === 'string' ? id : ''
      if (next && !this.providers.some((item) => item.id === next)) return
      this.defaultProviderId = next
      await this.persist()
      const name = this.defaultProviderName
      useToastStore().addToast(
        name ? `已将「${name}」设为默认上游` : '已取消默认上游（模型未命中即 404）',
        'success',
      )
    },

    // 局域网访问：默认关闭。开启前必须已有访问 Key，否则拒绝（与主进程同口径）；
    // 监听地址和端口一样不能热切换，运行中改动需重启中转站才生效。
    async setLanEnabled(enabled) {
      const next = Boolean(enabled)
      if (next && !this.apiKey && this.clientKeys.length === 0) {
        useToastStore().addToast('开启局域网访问前请先生成访问 Key 或添加客户端 Key', 'warning')
        return
      }
      this.lanEnabled = next
      await this.persist()
      if (this.running) {
        useToastStore().addToast('局域网设置已保存，需停止并重新启动中转站后生效', 'info')
      } else {
        useToastStore().addToast(next ? '已开启局域网访问' : '已关闭局域网访问', 'info')
      }
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
        // 端砚专项策略：限频按 Key × 模型计数、8 秒批次冷却；其它提供商留空即保持原口径
        strategy: payload.strategy || (payload.presetId === 'duanyan' ? 'duanyan' : ''),
        queueTimeoutMs: Number(payload.queueTimeoutMs) > 0 ? Number(payload.queueTimeoutMs) : 0,
        quota: normalizeQuota(payload.quota),
        autoProbe: normalizeAutoProbe(payload.autoProbe),
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
      if (patch.autoProbe) next.autoProbe = normalizeAutoProbe(patch.autoProbe)
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

    async loadLogs({ withStatus = true, skipWhenHidden = false } = {}) {
      // 面板轮询时不重复拉 status（status 会遍历所有 provider × Key 计算额度）
      if (skipWhenHidden && typeof document !== 'undefined' && document.hidden) return
      const api = bridge()
      if (!api?.logs) return
      this.logsLoading = true
      try {
        const result = await api.logs()
        if (result?.ok) this.logs = result.logs
        if (withStatus) await this.syncStatus()
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

    // 运行诊断日志：启动/停止、配置变更、额度锁定、上游异常等事件
    async loadDiagnostics({ skipWhenHidden = false } = {}) {
      if (skipWhenHidden && typeof document !== 'undefined' && document.hidden) return
      const api = bridge()
      if (!api?.diagnostics) return
      this.diagnosticsLoading = true
      try {
        const result = await api.diagnostics()
        if (result?.ok) this.diagnostics = result.diagnostics || []
      } catch {
        // 轮询失败保留上一次数据，下个周期重试；避免未处理 rejection 刷屏
      } finally {
        this.diagnosticsLoading = false
      }
    },

    async clearDiagnostics() {
      const api = bridge()
      if (!api?.clearDiagnostics) return
      const result = await api.clearDiagnostics()
      if (result?.ok) this.diagnostics = []
    },

    // 长期提供商观察：按 提供商 + 模型 + 日期 聚合，保留 180 天
    async loadObservations({ skipWhenHidden = false } = {}) {
      if (skipWhenHidden && typeof document !== 'undefined' && document.hidden) return
      const api = bridge()
      if (!api?.observations) return
      this.observationsLoading = true
      try {
        const result = await api.observations()
        if (result?.ok) this.observations = result.observations || []
      } catch {
        // 轮询失败保留上一次数据，下个周期重试；避免未处理 rejection 刷屏
      } finally {
        this.observationsLoading = false
      }
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
      this.tokenHistory = []
      this.tokenHourly = []
      this.keyUsage = []
      useToastStore().addToast('已清空调用统计', 'info')
    },

    // 时 / 日 / 周 / 月图表与按 Key 统计：主进程持久化，不受日志条数上限影响
    async loadTokenHistory() {
      const api = bridge()
      if (!api?.tokenHistory) return
      const result = await api.tokenHistory()
      if (result?.ok) {
        this.tokenHistory = result.history || []
        this.tokenHourly = result.hourly || []
        this.keyUsage = result.keys || []
      }
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

    // 单把 Key 测通：直接透传主进程结果（ok / error / ms / models）；
    // model 非空时主进程改为对该模型发一次最小对话请求
    async testKey(baseUrl, apiKey, model = '') {
      const api = bridge()
      if (!api?.testKey) return { ok: false, error: '当前环境不支持测通' }
      return api.testKey({ baseUrl, apiKey, model })
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
