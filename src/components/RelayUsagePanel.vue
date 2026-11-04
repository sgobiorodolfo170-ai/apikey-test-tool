<template>
  <div class="flex flex-col h-full min-h-0 gap-2">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 flex-shrink-0">
      <span class="text-[14px] text-text-muted flex-1 truncate">
        共 {{ summary.calls }} 次调用 · tokens {{ formatTokenAmount(summary.total) }}（输入
        {{ formatTokenAmount(summary.prompt) }} / 输出 {{ formatTokenAmount(summary.completion) }}）
        <template v-if="cachedSummary.calls > 0">
          · 缓存节省 {{ formatTokenAmount(cachedSummary.total) }}（{{ cachedSummary.calls }}
          次命中）
        </template>
        · 每 2 秒刷新
      </span>
      <button type="button" class="btn-ghost text-xs px-2 py-0.5" @click="refresh">刷新</button>
      <span v-if="cacheStats.hasData" class="basis-full text-[13px] text-text-muted">
        缓存命中：非流式 chat {{ cacheStats.chat.text }} · embeddings
        {{ cacheStats.embeddings.text }} · 节省率
        {{ savingsRate === null ? '—' : savingsRate + '%' }}
        <template v-if="cacheStats.clientText"> · 客户端：{{ cacheStats.clientText }}</template>
      </span>
    </div>

    <RelayTokenChart v-if="hasAnyUsage" />

    <div
      v-if="logs.length === 0 && keyRows.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-4"
    >
      <div class="text-text-muted text-sm">还没有 token 统计</div>
      <div class="text-[14px] text-text-muted leading-relaxed">
        启动中转站并产生调用后，这里会统计中转站内所有上游 Key 的调用情况
      </div>
    </div>

    <template v-else>
      <div class="flex-1 min-h-0 flex flex-col gap-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 flex-shrink-0">
          <span class="text-[14px] font-medium text-text-primary">按 Key 统计</span>
          <div class="flex rounded-card border border-border overflow-hidden">
            <button
              v-for="item in WINDOWS"
              :key="item.id"
              type="button"
              class="px-2 py-1 text-[13px] transition-colors whitespace-nowrap"
              :class="
                activeWindow === item.id
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-surface-hover'
              "
              @click="activeWindow = item.id"
            >
              {{ item.label }}
            </button>
          </div>
          <span class="text-[13px] font-normal text-text-muted"
            >（中转站内全部上游 Key，含未调用）</span
          >
        </div>
        <div class="flex-1 min-h-0 overflow-auto rounded-card border border-border">
          <table class="w-full text-left text-[13px] text-text-primary border-collapse">
            <thead class="sticky top-0 z-10 bg-surface-alt text-text-secondary">
              <tr>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">提供商</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">Key</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">调用</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">成功</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">输入</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">输出</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">合计</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">最近</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="displayRows.length === 0">
                <td colspan="8" class="px-2 py-3 text-center text-text-muted">
                  暂无上游 Key（请先在中转站里添加提供商与 Key）
                </td>
              </tr>
              <tr
                v-for="row in displayRows"
                :key="row.id"
                class="border-t border-border hover:bg-surface-hover"
              >
                <td class="px-2 py-1.5 truncate max-w-[130px]" :title="row.provider">
                  {{ row.provider }}
                </td>
                <td class="px-2 py-1.5 whitespace-nowrap" :title="row.keyTail">
                  <code>…{{ String(row.keyTail).slice(-6) }}</code>
                </td>
                <td class="px-2 py-1.5 whitespace-nowrap">{{ row.calls }}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">{{ row.success }}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">{{ formatNumber(row.prompt) }}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">
                  {{ formatNumber(row.completion) }}
                </td>
                <td class="px-2 py-1.5 whitespace-nowrap font-medium">
                  {{ formatNumber(row.total) }}
                </td>
                <td class="px-2 py-1.5 whitespace-nowrap">{{ shortTime(row.lastAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import RelayTokenChart from './RelayTokenChart.vue'
import { formatTokenAmount } from '../utils/tokenChart.js'

const WINDOWS = [
  { id: 'hour', label: '时调用' },
  { id: 'hours5', label: '5小时调用' },
  { id: 'day', label: '日调用' },
  { id: 'days7', label: '7日调用' },
  { id: 'month', label: '月调用' },
]

function emptyWindowStat() {
  return { calls: 0, success: 0, prompt: 0, completion: 0, total: 0, lastAt: null }
}

function emptyWindows() {
  return {
    hour: emptyWindowStat(),
    hours5: emptyWindowStat(),
    day: emptyWindowStat(),
    days7: emptyWindowStat(),
    month: emptyWindowStat(),
  }
}

// 兼容上一版只记录调用次数的数字桶
function normalizeWindowStat(value) {
  if (typeof value === 'number') {
    return { ...emptyWindowStat(), calls: Number(value) || 0 }
  }
  if (!value || typeof value !== 'object') return emptyWindowStat()
  return {
    calls: Number(value.calls) || 0,
    success: Number(value.success) || 0,
    prompt: Number(value.prompt) || 0,
    completion: Number(value.completion) || 0,
    total: Number(value.total) || 0,
    lastAt: value.lastAt || null,
  }
}

function emptyRow(id, extra = {}) {
  return {
    id,
    calls: 0,
    success: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    lastAt: null,
    windows: emptyWindows(),
    ...extra,
  }
}

// 没有主进程窗口统计时，用当前日志时间就近估算各窗口的完整统计
function addLogToWindow(row, log) {
  const date = new Date(log.at)
  if (Number.isNaN(date.getTime())) return
  row.windows ||= emptyWindows()
  const now = new Date()
  const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const flags = {
    hour: date >= hourStart,
    hours5: date >= fiveHoursAgo,
    day: date >= todayStart,
    days7: date >= weekStart,
    month: date >= monthStart,
  }
  const ok = !log.error && log.status >= 200 && log.status < 400

  for (const [key, active] of Object.entries(flags)) {
    if (!active) continue
    const stat = normalizeWindowStat(row.windows[key])
    stat.calls += 1
    if (ok) stat.success += 1
    if (log.usage) {
      stat.prompt += Number(log.usage.prompt) || 0
      stat.completion += Number(log.usage.completion) || 0
      stat.total += Number(log.usage.total) || 0
    }
    if (!stat.lastAt || new Date(log.at) > new Date(stat.lastAt)) stat.lastAt = log.at
    row.windows[key] = stat
  }
}

function addLog(row, log) {
  row.calls += 1
  if (!log.error && log.status >= 200 && log.status < 400) row.success += 1
  if (log.usage) {
    row.prompt += Number(log.usage.prompt) || 0
    row.completion += Number(log.usage.completion) || 0
    row.total += Number(log.usage.total) || 0
  }
  if (!row.lastAt || new Date(log.at) > new Date(row.lastAt)) row.lastAt = log.at
  addLogToWindow(row, log)
}

// 一个上游可以配多把 Key：apiKeys 为主，apiKey 兼容旧数据
function providerKeysOf(provider) {
  const list = Array.isArray(provider?.apiKeys) ? provider.apiKeys : []
  const keys = [...list, provider?.apiKey]
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter(Boolean)
  return [...new Set(keys)]
}

const keyTailOf = (key) => (typeof key === 'string' ? key.slice(-6) : '')

export default {
  name: 'RelayUsagePanel',
  components: { RelayTokenChart },
  setup() {
    const relayStore = useRelayStore()
    let timer = null

    const logs = computed(() => relayStore.logs)

    // 只要历史统计或日志任一有数据，就展示图表区
    const hasAnyUsage = computed(
      () =>
        relayStore.tokenHistory.length > 0 ||
        relayStore.tokenHourly.length > 0 ||
        logs.value.length > 0,
    )

    // 单独统计中转站内所有上游 Key 的调用情况：
    // 1) 先列出配置里的全部 Key（未调用也显示 0）；
    // 2) 再用主进程持久化的按 Key 统计补充调用量，不受日志 200 条上限影响。
    const keyRows = computed(() => {
      const map = new Map()

      for (const provider of relayStore.providers) {
        const name = provider.name || provider.id || '未知'
        for (const key of providerKeysOf(provider)) {
          const tail = keyTailOf(key)
          if (!tail) continue
          const id = `${name}::${tail}`
          if (map.has(id)) continue
          map.set(id, emptyRow(id, { provider: name, keyTail: tail }))
        }
      }

      for (const item of relayStore.keyUsage) {
        const tail = item?.keyTail || ''
        if (!tail) continue
        const provider = item.provider || '未知'
        const id = item.id || `${provider}::${tail}`
        const row = map.get(id) || emptyRow(id, { provider, keyTail: tail })
        row.provider = provider
        row.keyTail = tail
        row.calls = Number(item.calls) || 0
        row.success = Number(item.success) || 0
        row.prompt = Number(item.prompt) || 0
        row.completion = Number(item.completion) || 0
        row.total = Number(item.total) || 0
        row.lastAt = item.lastAt || row.lastAt
        const windows = {}
        for (const windowDef of WINDOWS) {
          windows[windowDef.id] = normalizeWindowStat(item.windows?.[windowDef.id])
        }
        row.windows = windows
        map.set(id, row)
      }

      // 兼容旧版本主进程（还没返回 keys）：退回用内存日志估算
      if (relayStore.keyUsage.length === 0) {
        for (const log of logs.value) {
          if (!log.keyTail) continue
          const provider = log.provider || '未知'
          const id = `${provider}::${log.keyTail}`
          const row = map.get(id) || emptyRow(id, { provider, keyTail: log.keyTail })
          addLog(row, log)
          map.set(id, row)
        }
      }

      return [...map.values()].sort((a, b) => b.total - a.total || b.calls - a.calls)
    })

    // 标题后的选项卡：切换后列表只展示对应时间窗口的统计
    const activeWindow = ref('hour')
    const displayRows = computed(() => {
      const windowKey = activeWindow.value
      return keyRows.value
        .map((row) => ({ ...row, ...normalizeWindowStat(row.windows?.[windowKey]) }))
        .sort((a, b) => b.total - a.total || b.calls - a.calls)
    })

    const summary = computed(() => {
      const result = { calls: 0, prompt: 0, completion: 0, total: 0 }
      for (const log of logs.value) {
        result.calls += 1
        if (log.usage) {
          result.prompt += Number(log.usage.prompt) || 0
          result.completion += Number(log.usage.completion) || 0
          result.total += Number(log.usage.total) || 0
        }
      }
      return result
    })

    // 缓存命中省下的 tokens：按日统计持久化，所以用 tokenHistory 汇总（不受日志条数上限影响）
    const cachedSummary = computed(() => {
      const result = { calls: 0, total: 0 }
      for (const day of relayStore.tokenHistory) {
        if (!day.cached) continue
        result.calls += Number(day.cached.calls) || 0
        result.total += Number(day.cached.total) || 0
      }
      return result
    })

    // 缓存命中率：只统计参与缓存的请求（非流式），同一 requestId 的多次尝试不重复计数
    const rateText = (bucket) => {
      if (bucket.requests <= 0) return '—（0/0）'
      const rate = Math.round((bucket.hits / bucket.requests) * 100)
      return `${rate}%（${bucket.hits}/${bucket.requests}）`
    }

    const cacheStats = computed(() => {
      const buckets = {
        chat: { requests: 0, hits: 0 },
        embeddings: { requests: 0, hits: 0 },
      }
      const clients = new Map()
      const seen = new Set()

      for (const log of logs.value) {
        // 流式请求不参与缓存，放进分母会把命中率稀释成无意义的 0
        if (log.stream) continue
        const id = log.requestId || log.id
        if (id) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        const kind = log.path === '/embeddings' ? 'embeddings' : 'chat'
        buckets[kind].requests += 1
        if (log.cached) buckets[kind].hits += 1

        const name = log.client || '未标注'
        const row = clients.get(name) || { client: name, requests: 0, hits: 0 }
        row.requests += 1
        if (log.cached) row.hits += 1
        clients.set(name, row)
      }

      const list = [...clients.values()].sort((a, b) => b.requests - a.requests)
      const clientText = list
        .slice(0, 4)
        .map((row) => `${row.client} ${rateText(row)}`)
        .join(' · ')

      return {
        chat: { ...buckets.chat, text: rateText(buckets.chat) },
        embeddings: { ...buckets.embeddings, text: rateText(buckets.embeddings) },
        clientText: list.length > 4 ? `${clientText} 等 ${list.length} 个` : clientText,
        hasData: buckets.chat.requests + buckets.embeddings.requests > 0,
      }
    })

    // 节省率 = 缓存节省 tokens /（真实消耗 + 节省），比命中率更能反映实际收益
    const savingsRate = computed(() => {
      let real = 0
      let saved = 0
      for (const day of relayStore.tokenHistory) {
        real += Number(day.total) || 0
        saved += Number(day.cached?.total) || 0
      }
      return real + saved > 0 ? Math.round((saved / (real + saved)) * 100) : null
    })

    const refresh = async () => {
      await relayStore.loadLogs()
      await relayStore.loadTokenHistory()
    }
    const poll = async () => {
      await relayStore.loadLogs({ withStatus: false, skipWhenHidden: true })
      await relayStore.loadTokenHistory()
    }

    const formatNumber = (value) => Number(value || 0).toLocaleString('zh-CN')

    const shortTime = (iso) => {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      return date.toLocaleTimeString('zh-CN', { hour12: false })
    }

    onMounted(() => {
      refresh()
      timer = setInterval(poll, 5000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      timer = null
    })

    return {
      relayStore,
      logs,
      hasAnyUsage,
      WINDOWS,
      activeWindow,
      keyRows,
      displayRows,
      summary,
      cachedSummary,
      cacheStats,
      savingsRate,
      refresh,
      formatNumber,
      formatTokenAmount,
      shortTime,
    }
  },
}
</script>

<style scoped></style>
