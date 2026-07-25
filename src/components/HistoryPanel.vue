<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <div class="flex items-center border-b border-border pb-2 mb-4 flex-shrink-0">
      <h2 class="text-xl font-bold text-text-primary">历史记录 ({{ historyStore.records.length }})</h2>
    </div>

    <div v-if="historyStore.records.length === 0" class="flex-1 flex items-center justify-center text-text-muted">
      暂无历史记录
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-2">
      <div
        v-for="(record, index) in historyStore.records"
        :key="record.id"
        class="bg-surface-alt rounded p-3 hover:bg-surface-hover cursor-pointer transition-all duration-150 border-l-2"
        :class="record.result?.connected ? 'border-l-success' : 'border-l-danger'"
        @click="testStore.setCurrentResult(record.result)"
      >
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <div class="text-text-primary font-medium">{{ historyStore.records.length - index }}. {{ record.config?.provider || '未知提供商' }}</div>
            <div class="text-xs text-text-secondary mt-1">
              {{ formatTime(record.timestamp) }}
            </div>
          </div>

          <div class="flex items-center gap-2 ml-3 flex-shrink-0">
            <span class="text-sm whitespace-nowrap" :class="record.result?.connected ? 'text-success' : 'text-danger'">
              {{ record.result?.connected ? '已连接' : '失败' }}
            </span>
            <span v-if="record.result?.summary" class="text-xs text-text-secondary whitespace-nowrap">
              {{ record.result.summary.success }}个成功
            </span>
            <button
              class="btn-danger text-xs px-2 py-1"
              @click.stop="handleDelete(record.id)"
            >
              删除
            </button>
            <button
              class="btn-primary text-xs px-2 py-1"
              @click.stop="historyStore.loadConfig(record)"
            >
              加载配置
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { onMounted } from 'vue'
import { useHistoryStore } from '../stores/historyStore.js'
import { useTestStore } from '../stores/testStore.js'

export default {
  name: 'HistoryPanel',
  setup() {
    const historyStore = useHistoryStore()
    const testStore = useTestStore()

    const handleClear = async () => {
      if (!confirm('确定要清空所有历史记录吗？')) return
      await historyStore.clearAll()
    }

    const handleDelete = async (id) => {
      if (!confirm('确定要删除该记录吗？')) return
      await historyStore.deleteRecord(id)
    }

    const formatTime = (timestamp) => {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    onMounted(() => {
      if (!historyStore.initialized) {
        historyStore.loadHistory()
      }
    })

    return {
      historyStore,
      testStore,
      handleClear,
      handleDelete,
      formatTime,
    }
  },
}
</script>
