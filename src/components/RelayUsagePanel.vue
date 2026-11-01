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
    </div>

    <RelayTokenChart v-if="hasAnyUsage" />

    <div
      v-if="logs.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-4"
    >
      <div class="text-text-muted text-sm">还没有 token 统计</div>
      <div class="text-[14px] text-text-muted leading-relaxed">
        启动中转站并产生调用后，这里会按 Key 与模型汇总 token 用量
      </div>
    </div>

    <template v-else>
      <div class="flex-1 min-h-0 flex flex-col gap-1">
        <div class="text-[14px] font-medium text-text-primary flex-shrink-0">按 Key 统计</div>
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
              <tr v-if="keyRows.length === 0">
                <td colspan="8" class="px-2 py-3 text-center text-text-muted">
                  暂无带 Key 的调用（缓存命中不计 Key）
                </td>
              </tr>
              <tr
                v-for="row in keyRows"
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

      <div class="flex-1 min-h-0 flex flex-col gap-1">
        <div class="text-[14px] font-medium text-text-primary flex-shrink-0">按模型统计</div>
        <div class="flex-1 min-h-0 overflow-auto rounded-card border border-border">
          <table class="w-full text-left text-[13px] text-text-primary border-collapse">
            <thead class="sticky top-0 z-10 bg-surface-alt text-text-secondary">
              <tr>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">模型</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">调用</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">成功</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">输入</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">输出</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">合计</th>
                <th class="px-2 py-1.5 font-medium whitespace-nowrap">最近</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in modelRows"
                :key="row.id"
                class="border-t border-border hover:bg-surface-hover"
              >
                <td class="px-2 py-1.5 truncate max-w-[180px]" :title="row.model">
                  {{ row.model }}
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
import { computed, onMounted, onUnmounted } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import RelayTokenChart from './RelayTokenChart.vue'
import { formatTokenAmount } from '../utils/tokenChart.js'

function emptyRow(id, extra = {}) {
  return {
    id,
    calls: 0,
    success: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    lastAt: null,
    ...extra,
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
}

export default {
  name: 'RelayUsagePanel',
  components: { RelayTokenChart },
  setup() {
    const relayStore = useRelayStore()
    let timer = null

    const logs = computed(() => relayStore.logs)

    // 只要历史日志或按日统计任一有数据，就展示图表区
    const hasAnyUsage = computed(() => relayStore.tokenHistory.length > 0 || logs.value.length > 0)

    const keyRows = computed(() => {
      const map = new Map()
      for (const log of logs.value) {
        if (!log.keyTail) continue
        const id = `${log.provider || '未知'}::${log.keyTail}`
        const row =
          map.get(id) || emptyRow(id, { provider: log.provider || '未知', keyTail: log.keyTail })
        addLog(row, log)
        map.set(id, row)
      }
      return [...map.values()].sort((a, b) => b.total - a.total)
    })

    const modelRows = computed(() => {
      const map = new Map()
      for (const log of logs.value) {
        const id = log.model || '未知'
        const row = map.get(id) || emptyRow(id, { model: id })
        addLog(row, log)
        map.set(id, row)
      }
      return [...map.values()].sort((a, b) => b.total - a.total)
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
      keyRows,
      modelRows,
      summary,
      cachedSummary,
      refresh,
      formatNumber,
      formatTokenAmount,
      shortTime,
    }
  },
}
</script>

<style scoped></style>
