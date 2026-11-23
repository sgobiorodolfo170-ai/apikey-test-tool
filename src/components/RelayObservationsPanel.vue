<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 flex-shrink-0">
      <span class="text-[14px] text-text-muted flex-1 min-w-[180px]">
        长期观察 · 数据保留 180 天 · 每 30 秒刷新
      </span>
      <div class="flex rounded-card border border-border overflow-hidden">
        <button
          v-for="item in RANGES"
          :key="item.days"
          type="button"
          class="px-2 py-0.5 text-[13px] transition-colors whitespace-nowrap"
          :class="
            rangeDays === item.days
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="rangeDays = item.days"
        >
          {{ item.label }}
        </button>
      </div>
      <select v-model="activeProvider" class="select text-xs py-0.5 max-w-[140px]">
        <option value="all">全部提供商</option>
        <option v-for="item in providerOptions" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <select v-model="activeModel" class="select text-xs py-0.5 max-w-[140px]">
        <option value="all">全部模型</option>
        <option v-for="model in modelOptions" :key="model" :value="model">
          {{ model }}
        </option>
      </select>
      <button type="button" class="btn-ghost text-xs px-2 py-0.5" @click="refresh">刷新</button>
      <button
        type="button"
        class="btn-ghost text-xs px-2 py-0.5"
        :disabled="filtered.length === 0"
        @click="copyJson"
      >
        {{ copied ? '已复制' : '复制 JSON' }}
      </button>
    </div>

    <div
      v-if="rows.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-4"
    >
      <div class="text-text-muted text-sm">还没有长期观察数据</div>
      <div class="text-[14px] text-text-muted leading-relaxed">
        启动中转站并产生真实调用后，这里会按「提供商 + 模型 + 日期」累计调用、429、锁定与延迟，保留
        180 天
      </div>
    </div>

    <div
      v-else-if="filtered.length === 0"
      class="flex-1 flex items-center justify-center text-center px-4"
    >
      <div class="text-text-muted text-sm">当前筛选条件下没有观察数据</div>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mb-2 flex-shrink-0">
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">调用 / 成功率</div>
          <div class="text-[15px] text-text-primary">
            {{ summary.calls }} · {{ summary.successRate }}%
          </div>
        </div>
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">429 / 额度锁定</div>
          <div class="text-[15px] text-text-primary">
            {{ summary.rateLimited }} · {{ summary.quotaLimited }}
          </div>
        </div>
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">5xx / 网络错误</div>
          <div class="text-[15px] text-text-primary">
            {{ summary.serverErrors }} / {{ summary.networkErrors }}
          </div>
        </div>
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">平均 / 最大延迟</div>
          <div class="text-[15px] text-text-primary">
            {{ summary.avgMs }}ms / {{ summary.maxMs }}ms
          </div>
        </div>
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">慢请求 ≥8s</div>
          <div class="text-[15px] text-text-primary">{{ summary.slowRate }}%</div>
        </div>
        <div class="rounded-card bg-surface-alt px-2.5 py-1.5">
          <div class="text-[12px] text-text-muted">锁定 / 恢复</div>
          <div class="text-[15px] text-text-primary">
            {{ summary.locks }} / {{ summary.recoveries }}
          </div>
        </div>
      </div>

      <div class="text-[13px] text-text-muted mb-2 flex-shrink-0 leading-relaxed">
        高峰时段：{{ summary.peakCalls }} · 429 高峰：{{ summary.peak429 }}
      </div>

      <div class="flex-1 min-h-0 overflow-auto rounded-card border border-border">
        <table class="w-full text-left text-[13px] text-text-primary border-collapse">
          <thead class="sticky top-0 z-10 bg-surface-alt text-text-secondary">
            <tr>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">日期</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">提供商 / 模型</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">调用</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">成功率</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">429（额度）</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">鉴权 / 4xx</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">5xx / 网络</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">平均延迟</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">慢请求</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">Tokens</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">锁定 5m/5h/7d</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">恢复</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              class="border-t border-border hover:bg-surface-hover"
            >
              <td class="px-2 py-1.5 whitespace-nowrap text-text-secondary">{{ row.date }}</td>
              <td class="px-2 py-1.5 text-text-primary max-w-[220px]">
                <div class="truncate" :title="row.provider">{{ row.provider }}</div>
                <div class="text-[12px] text-text-muted truncate" :title="row.model || '默认'">
                  {{ row.model || '默认' }}
                </div>
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ row.calls }}</td>
              <td class="px-2 py-1.5 whitespace-nowrap" :class="rateClass(row.success, row.calls)">
                {{ percent(row.success, row.calls) }}%
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                {{ row.rateLimited }}<span class="text-text-muted">（{{ row.quotaLimited }}）</span>
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                {{ row.authFailed }} / {{ row.clientErrors + row.aborted }}
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                {{ row.serverErrors }} / {{ row.networkErrors }}
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ avgMs(row) }}ms</td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ slowRate(row) }}%</td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ formatTokens(row.tokens.total) }}</td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                {{ row.locks?.probe || 0 }}/{{ row.locks?.['5h'] || 0 }}/{{ row.locks?.week || 0 }}
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                {{ row.recoveries || 0 }}
                <span v-if="row.recoveries" class="text-text-muted">
                  · {{ recoveryMinutes(row) }} 分钟
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="filtered.length > visibleRows.length" class="text-[13px] text-text-muted mt-1">
        共 {{ filtered.length }} 行，仅显示最近 {{ visibleRows.length }} 行
      </div>
    </template>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import { useToastStore } from '../stores/toastStore.js'

const RANGES = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 180, label: '180 天' },
]
const ROW_LIMIT = 300

function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export default {
  name: 'RelayObservationsPanel',
  setup() {
    const relayStore = useRelayStore()
    const toastStore = useToastStore()
    const rangeDays = ref(90)
    const activeProvider = ref('all')
    const activeModel = ref('all')
    const copied = ref(false)
    let timer = null
    let copiedTimer = null

    const rows = computed(() => relayStore.observations || [])

    const providerOptions = computed(() => {
      const map = new Map()
      for (const row of rows.value) {
        // 用提供商名称作为筛选键：升级前的回填数据没有 providerId，
        // 按名称筛选可以把新旧数据合并到同一个提供商下。
        const name = row.provider || row.providerId
        if (!map.has(name)) map.set(name, { id: name, name })
      }
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    })

    const scopedRows = computed(() => {
      if (activeProvider.value === 'all') return rows.value
      return rows.value.filter((row) => (row.provider || row.providerId) === activeProvider.value)
    })

    const modelOptions = computed(() => {
      const set = new Set()
      for (const row of scopedRows.value) set.add(row.model || '')
      return [...set].sort((a, b) => (a || '默认').localeCompare(b || '默认'))
    })

    const cutoffDate = computed(() => {
      const date = new Date()
      date.setDate(date.getDate() - Math.max(1, rangeDays.value - 1))
      return localDateKey(date)
    })

    const filtered = computed(() =>
      scopedRows.value.filter((row) => {
        if (row.date < cutoffDate.value) return false
        if (activeModel.value === 'all') return true
        return (row.model || '') === activeModel.value
      }),
    )

    const visibleRows = computed(() => filtered.value.slice(0, ROW_LIMIT))

    const summary = computed(() => {
      const result = {
        calls: 0,
        success: 0,
        rateLimited: 0,
        quotaLimited: 0,
        authFailed: 0,
        clientErrors: 0,
        serverErrors: 0,
        networkErrors: 0,
        slow: 0,
        latencySum: 0,
        maxMs: 0,
        tokens: 0,
        locks: 0,
        recoveries: 0,
      }
      const hours = Array(24).fill(0)
      const hour429 = Array(24).fill(0)
      for (const row of filtered.value) {
        result.calls += Number(row.calls) || 0
        result.success += Number(row.success) || 0
        result.rateLimited += Number(row.rateLimited) || 0
        result.quotaLimited += Number(row.quotaLimited) || 0
        result.authFailed += Number(row.authFailed) || 0
        result.clientErrors += Number(row.clientErrors) || 0
        result.serverErrors += Number(row.serverErrors) || 0
        result.networkErrors += Number(row.networkErrors) || 0
        const buckets = row.latency?.buckets || []
        result.slow += (Number(buckets[4]) || 0) + (Number(buckets[5]) || 0)
        result.latencySum += Number(row.latency?.sum) || 0
        result.maxMs = Math.max(result.maxMs, Number(row.latency?.max) || 0)
        result.tokens += Number(row.tokens?.total) || 0
        result.locks +=
          (Number(row.locks?.probe) || 0) +
          (Number(row.locks?.['5h']) || 0) +
          (Number(row.locks?.week) || 0)
        result.recoveries += Number(row.recoveries) || 0
        for (let hour = 0; hour < 24; hour += 1) {
          hours[hour] += Number(row.hourCalls?.[hour]) || 0
          hour429[hour] += Number(row.hourRateLimited?.[hour]) || 0
        }
      }
      return {
        ...result,
        successRate: percent(result.success, result.calls),
        avgMs: result.calls > 0 ? Math.round(result.latencySum / result.calls) : 0,
        slowRate: percent(result.slow, result.calls),
        peakCalls: peakText(hours),
        peak429: peakText(hour429),
      }
    })

    const percent = (value, total) => {
      const number = Number(value) || 0
      const count = Number(total) || 0
      return count > 0 ? Math.round((number / count) * 100) : 0
    }

    function peakText(hours) {
      const top = hours
        .map((count, hour) => ({ hour, count }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
      if (top.length === 0) return '暂无'
      return top.map((item) => `${item.hour} 点 ${item.count} 次`).join(' · ')
    }

    const avgMs = (row) => (row.calls > 0 ? Math.round((row.latency?.sum || 0) / row.calls) : 0)
    const slowRate = (row) => {
      const buckets = row.latency?.buckets || []
      const slow = (Number(buckets[4]) || 0) + (Number(buckets[5]) || 0)
      return percent(slow, row.calls)
    }
    const recoveryMinutes = (row) =>
      row.recoveries > 0 ? Math.round((row.recoveryMsSum || 0) / row.recoveries / 60000) : 0

    const rateClass = (value, total) => {
      const rate = percent(value, total)
      if (rate >= 95) return 'text-success'
      if (rate >= 80) return 'text-warning'
      return 'text-danger'
    }

    const formatTokens = (value) => {
      const number = Number(value) || 0
      if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`
      if (number >= 1000) return `${(number / 1000).toFixed(1)}k`
      return String(number)
    }

    const refresh = () => relayStore.loadObservations()
    const poll = () => relayStore.loadObservations({ skipWhenHidden: true })

    const copyJson = async () => {
      const payload = {
        generatedAt: new Date().toISOString(),
        rangeDays: rangeDays.value,
        provider: activeProvider.value,
        model: activeModel.value,
        rows: filtered.value,
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
        copied.value = true
        toastStore.addToast(`已复制 ${filtered.value.length} 条观察数据`, 'success')
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          copied.value = false
        }, 1500)
      } catch {
        toastStore.addToast('复制失败，请手动选择表格内容', 'error')
      }
    }

    watch(modelOptions, (list) => {
      if (activeModel.value !== 'all' && !list.includes(activeModel.value)) {
        activeModel.value = 'all'
      }
    })

    onMounted(() => {
      refresh()
      timer = setInterval(poll, 30000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      if (copiedTimer) clearTimeout(copiedTimer)
      timer = null
      copiedTimer = null
    })

    return {
      RANGES,
      rangeDays,
      activeProvider,
      activeModel,
      copied,
      rows,
      providerOptions,
      modelOptions,
      filtered,
      visibleRows,
      summary,
      refresh,
      copyJson,
      percent,
      avgMs,
      slowRate,
      recoveryMinutes,
      rateClass,
      formatTokens,
    }
  },
}
</script>

<style scoped></style>
