<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center gap-1 border-b border-border pb-2 mb-2 flex-shrink-0">
      <button
        v-for="view in VIEWS"
        :key="view.id"
        type="button"
        class="px-2.5 py-1 text-sm rounded-card transition-colors"
        :class="
          activeView === view.id
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-surface-hover'
        "
        @click="activeView = view.id"
      >
        {{ view.label }}
      </button>
      <span class="text-[13px] text-text-muted ml-1"> 事件保留 30 天 · 长期观察保留 180 天 </span>
    </div>

    <template v-if="activeView === 'events'">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 flex-shrink-0">
        <span class="text-[14px] text-text-muted flex-1 truncate">
          共 {{ total }} 条诊断事件 · 错误 {{ counts.error }} · 警告 {{ counts.warn }} · 信息
          {{ counts.info }} · 每 10 秒刷新
        </span>
        <div class="flex rounded-card border border-border overflow-hidden">
          <button
            v-for="item in LEVELS"
            :key="item.id"
            type="button"
            class="px-2 py-0.5 text-[13px] transition-colors whitespace-nowrap"
            :class="
              activeLevel === item.id
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-hover'
            "
            @click="activeLevel = item.id"
          >
            {{ item.label }}
          </button>
        </div>
        <button type="button" class="btn-ghost text-xs px-2 py-0.5" @click="refresh">刷新</button>
        <button
          type="button"
          class="btn-ghost text-xs px-2 py-0.5 text-danger hover:bg-danger/10"
          :disabled="total === 0"
          @click="handleClear"
        >
          清空
        </button>
      </div>

      <div
        v-if="total === 0"
        class="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-4"
      >
        <div class="text-text-muted text-sm">还没有诊断日志</div>
        <div class="text-[14px] text-text-muted leading-relaxed">
          启动中转站后，启动 / 停止、配置变更、额度锁定、上游失败等运行事件会记录在这里
        </div>
      </div>

      <div v-else class="flex-1 min-h-0 overflow-auto rounded-card border border-border">
        <table class="w-full text-left text-[13px] text-text-primary border-collapse">
          <thead class="sticky top-0 z-10 bg-surface-alt text-text-secondary">
            <tr>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">时间</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">级别</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">类别</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">事件</th>
              <th class="px-2 py-1.5 font-medium whitespace-nowrap">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="filtered.length === 0">
              <td colspan="5" class="px-2 py-3 text-center text-text-muted">
                当前筛选条件下没有诊断事件
              </td>
            </tr>
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              class="border-t border-border hover:bg-surface-hover align-top"
            >
              <td class="px-2 py-1.5 whitespace-nowrap text-text-secondary">
                {{ formatTime(row.at) }}
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                <span
                  class="px-1.5 py-0.5 rounded-full text-[13px] whitespace-nowrap"
                  :class="levelClass(row.level)"
                >
                  {{ levelText(row.level) }}
                </span>
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap text-text-secondary">
                {{ row.category || '运行' }}
              </td>
              <td class="px-2 py-1.5 text-text-primary">{{ row.message }}</td>
              <td class="px-2 py-1.5 text-text-secondary break-words">
                {{ row.detail || '—' }}
              </td>
            </tr>
            <tr v-if="hiddenCount > 0">
              <td colspan="5" class="px-2 py-1.5 text-center text-text-muted">
                事件较多，仅显示最近 {{ visibleRows.length }} 条，其余 {{ hiddenCount }}
                条请缩小筛选范围或清空旧日志
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <RelayObservationsPanel v-else />
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import RelayObservationsPanel from './RelayObservationsPanel.vue'

const VIEWS = [
  { id: 'events', label: '事件日志' },
  { id: 'observe', label: '提供商观察' },
]

const LEVELS = [
  { id: 'all', label: '全部' },
  { id: 'error', label: '错误' },
  { id: 'warn', label: '警告' },
  { id: 'info', label: '信息' },
]

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 }

export default {
  name: 'RelayDiagnosticsPanel',
  components: { RelayObservationsPanel },
  setup() {
    const relayStore = useRelayStore()
    const activeView = ref('events')
    const activeLevel = ref('all')
    let timer = null

    const total = computed(() => relayStore.diagnostics.length)

    const counts = computed(() => {
      const result = { error: 0, warn: 0, info: 0 }
      for (const item of relayStore.diagnostics) {
        const level = LEVEL_ORDER[item.level] === undefined ? 'info' : item.level
        result[level] += 1
      }
      return result
    })

    // 按级别筛选；同级别内主进程已按时间倒序返回，直接使用其顺序
    const filtered = computed(() => {
      if (activeLevel.value === 'all') return relayStore.diagnostics
      return relayStore.diagnostics.filter((item) => item.level === activeLevel.value)
    })

    // 主进程最多保留 1 万条事件；一次性渲染上万行 DOM 会卡顿，
    // 界面只画最近 500 条，超出部分提示缩小筛选范围
    const RENDER_LIMIT = 500
    const visibleRows = computed(() => filtered.value.slice(0, RENDER_LIMIT))
    const hiddenCount = computed(() => Math.max(0, filtered.value.length - RENDER_LIMIT))

    const refresh = () => relayStore.loadDiagnostics()
    const poll = () => relayStore.loadDiagnostics({ skipWhenHidden: true })

    const handleClear = async () => {
      if (!confirm('确定清空诊断日志吗？')) return
      await relayStore.clearDiagnostics()
    }

    const formatTime = (iso) => {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    }

    const levelText = (level) => {
      if (level === 'error') return '错误'
      if (level === 'warn') return '警告'
      return '信息'
    }

    const levelClass = (level) => {
      if (level === 'error') return 'bg-danger/15 text-danger'
      if (level === 'warn') return 'bg-warning/15 text-warning'
      return 'bg-success/15 text-success'
    }

    onMounted(() => {
      refresh()
      timer = setInterval(poll, 10000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      timer = null
    })

    return {
      VIEWS,
      LEVELS,
      activeView,
      activeLevel,
      total,
      counts,
      filtered,
      visibleRows,
      hiddenCount,
      refresh,
      handleClear,
      formatTime,
      levelText,
      levelClass,
    }
  },
}
</script>

<style scoped></style>
