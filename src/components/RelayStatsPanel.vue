<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 flex-shrink-0">
      <span class="text-[14px] text-text-muted flex-1 truncate">
        共 {{ summary.total }} 个请求 · 请求成功率 {{ summary.rate }}% · 尝试成功率
        {{ summary.attemptRate }}% · 故障转移 {{ summary.failovers }} 次 · 每 2 秒刷新
      </span>
      <button type="button" class="btn-ghost text-xs px-2 py-0.5" @click="refresh">刷新</button>
      <button
        type="button"
        class="btn-ghost text-xs px-2 py-0.5 text-danger hover:bg-danger/10"
        :disabled="requests.length === 0"
        @click="handleClear"
      >
        清空
      </button>
    </div>

    <div
      v-if="requests.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-4"
    >
      <div class="text-text-muted text-sm">还没有调用记录</div>
      <div class="text-[14px] text-text-muted leading-relaxed">
        启动中转站并让客户端发几次请求后，这里会按 request_id 汇总每次调用与是否发生过故障转移
      </div>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-auto rounded-card border border-border">
      <table class="w-full text-left text-[13px] text-text-primary border-collapse">
        <thead class="sticky top-0 z-10 bg-surface-alt text-text-secondary">
          <tr>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">请求 ID</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">类型（提供商）</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">模型</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">客户端</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">最近状态</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">请求状态</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">成功率</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">总调用</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">故障转移（Key）</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">延迟</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">时间</th>
            <th class="px-2 py-1.5 font-medium whitespace-nowrap">本次用量</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in requests"
            :key="row.id"
            class="border-t border-border hover:bg-surface-hover"
          >
            <td class="px-2 py-1.5 whitespace-nowrap" :title="row.id">
              <code class="text-[13px] text-text-primary">{{ shortId(row.id) }}</code>
            </td>
            <td class="px-2 py-1.5 truncate max-w-[130px] text-text-primary" :title="row.provider">
              {{ row.provider }}
            </td>
            <td class="px-2 py-1.5 truncate max-w-[150px] text-text-primary" :title="row.model">
              {{ row.model }}
            </td>
            <td class="px-2 py-1.5 truncate max-w-[110px] text-text-secondary" :title="row.client">
              {{ row.client }}
            </td>
            <td class="px-2 py-1.5 whitespace-nowrap">
              <span
                class="px-1.5 py-0.5 rounded-full text-[13px] whitespace-nowrap"
                :class="statusClass(row)"
              >
                {{ statusText(row) }}
              </span>
            </td>
            <td
              class="px-2 py-1.5 whitespace-nowrap"
              :class="
                row.status.status >= 400 || row.status.status === 0 || !row.status.status
                  ? 'text-danger'
                  : 'text-success'
              "
            >
              {{ row.status.status || 'ERR' }}
            </td>
            <td
              class="px-2 py-1.5 whitespace-nowrap"
              :class="rateClass(row)"
              :title="`尝试成功率：${row.attemptSuccess}/${row.attempts}`"
            >
              {{ row.rate }}%
              <span class="text-text-muted">({{ row.attemptSuccess }}/{{ row.attempts }})</span>
            </td>
            <td class="px-2 py-1.5 whitespace-nowrap">{{ row.attempts }}</td>
            <td
              class="px-2 py-1.5 whitespace-nowrap"
              :class="row.failover ? 'text-warning' : 'text-text-muted'"
              :title="keyChainTitle(row)"
            >
              {{ row.failover ? '是' : '否' }}
            </td>
            <td class="px-2 py-1.5 whitespace-nowrap" :title="`尝试 ${row.attempts} 次`">
              {{ row.ms }}ms
            </td>
            <td class="px-2 py-1.5 whitespace-nowrap">{{ shortTime(row.at) }}</td>
            <td class="px-2 py-1.5 whitespace-nowrap" :title="usageTitle(row)">
              {{ usageText(row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'

export default {
  name: 'RelayStatsPanel',
  setup() {
    const relayStore = useRelayStore()
    let timer = null

    // 按 request_id 聚合同一次客户端请求的所有尝试，最终结果取最后一次
    const requests = computed(() => {
      const map = new Map()
      for (const log of relayStore.logs) {
        if (!log.requestId) continue
        const group = map.get(log.requestId) || {
          id: log.requestId,
          attempts: 0,
          logs: [],
        }
        group.attempts += 1
        group.logs.push(log)
        map.set(log.requestId, group)
      }

      return [...map.values()]
        .map((group) => {
          const logs = [...group.logs].sort((a, b) => new Date(a.at) - new Date(b.at))
          const last = logs[logs.length - 1] || {}
          const keyTails = [...new Set(logs.map((item) => item.keyTail).filter(Boolean))]
          const success = Boolean(last.at) && !last.error && last.status >= 200 && last.status < 400
          const attemptSuccess = logs.filter(
            (item) => !item.error && item.status >= 200 && item.status < 400,
          ).length
          const totalMs = logs.reduce((sum, item) => sum + (Number(item.ms) || 0), 0)
          const client = logs
            .map((item) => item.client)
            .filter(Boolean)
            .pop()
          return {
            id: group.id,
            provider: last.provider || '未知',
            model: last.model || '未知',
            client: client || '未知',
            status: last,
            attempts: group.attempts,
            attemptSuccess,
            rate: group.attempts > 0 ? Math.round((attemptSuccess / group.attempts) * 100) : 0,
            keyTails,
            success,
            ms: totalMs,
            at: last.at,
            usage: last.usage || null,
            failover: group.attempts > 1 || keyTails.length > 1,
          }
        })
        .sort((a, b) => new Date(b.at) - new Date(a.at))
    })

    const summary = computed(() => {
      const total = requests.value.length
      const ok = requests.value.filter((row) => row.success).length
      const attempts = requests.value.reduce((sum, row) => sum + row.attempts, 0)
      const successAttempts = requests.value.reduce((sum, row) => sum + row.attemptSuccess, 0)
      return {
        total,
        ok,
        attempts,
        successAttempts,
        rate: total > 0 ? Math.round((ok / total) * 100) : 0,
        attemptRate: attempts > 0 ? Math.round((successAttempts / attempts) * 100) : 0,
        failovers: requests.value.filter((row) => row.failover).length,
      }
    })

    const refresh = () => relayStore.loadLogs()

    const handleClear = async () => {
      if (!confirm('确定清空调用记录吗？')) return
      await relayStore.clearLogs()
    }

    const shortId = (id) => (id ? id.slice(-10) : '—')

    const statusText = (row) => {
      if (row.success) return '成功'
      if (row.status.status === 499) return '取消'
      if (row.status.status === 429) return '限流'
      return '失败'
    }

    const statusClass = (row) => {
      if (row.success) return 'bg-success/15 text-success'
      if (row.status.status === 499) return 'bg-surface-hover text-text-muted'
      if (row.status.status === 429) return 'bg-warning/15 text-warning'
      return 'bg-danger/15 text-danger'
    }

    const rateClass = (row) => {
      if (row.rate >= 95) return 'text-success'
      if (row.rate >= 80) return 'text-warning'
      return 'text-danger'
    }

    const keyChain = (row) =>
      row.keyTails.length > 0
        ? row.keyTails.map((tail) => `…${String(tail).slice(-6)}`).join(' → ')
        : '—'

    const keyChainTitle = (row) =>
      row.keyTails.length > 0
        ? `尝试 ${row.attempts} 次 · Key 尾号 ${keyChain(row)}`
        : `尝试 ${row.attempts} 次`

    const shortTime = (iso) => {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      return date.toLocaleTimeString('zh-CN', { hour12: false })
    }

    const usageText = (row) => (row.usage ? `${row.usage.total} tokens` : '—')

    const usageTitle = (row) =>
      row.usage
        ? `输入 ${row.usage.prompt} · 输出 ${row.usage.completion} · 合计 ${row.usage.total}`
        : '该次请求未返回 usage'

    onMounted(() => {
      refresh()
      timer = setInterval(refresh, 2000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      timer = null
    })

    return {
      relayStore,
      requests,
      summary,
      refresh,
      handleClear,
      shortId,
      statusText,
      statusClass,
      rateClass,
      keyChain,
      keyChainTitle,
      shortTime,
      usageText,
      usageTitle,
    }
  },
}
</script>

<style scoped></style>
