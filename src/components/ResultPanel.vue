<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <h2 class="text-xl font-bold text-text-primary border-b border-border pb-2 mb-4 flex-shrink-0">测试结果</h2>

    <div v-if="!testStore.currentResult" class="flex-1 flex items-center justify-center text-text-secondary">
      暂无测试结果，请先进行测试
    </div>

    <div v-else-if="testStore.isTesting" class="flex-1 flex items-center justify-center text-text-secondary">
      <div
        class="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent mx-auto mb-4"
      ></div>
      <span>正在测试，请稍候...</span>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-4">
      <div class="bg-surface-alt rounded-input p-4">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-text-secondary">连通状态: </span>
            <span
              class="font-bold"
              :class="testStore.currentResult.connected ? 'text-success' : 'text-danger'"
            >
              <span
                class="inline-block w-2 h-2 rounded-full mr-1"
                :class="testStore.currentResult.connected ? 'bg-success' : 'bg-danger'"
              ></span>
              {{ testStore.currentResult.connected ? '已连接' : '连接失败' }}
            </span>
          </div>
          <div>
            <span class="text-sm text-text-secondary">连接耗时: </span>
            <span class="font-bold text-accent">{{ testStore.currentResult.connectTime || 0 }}ms</span>
          </div>
        </div>
      </div>

      <div
        v-if="testStore.currentResult.error"
        class="bg-danger/10 border border-danger/30 rounded-input p-4"
      >
        <div class="text-sm text-danger font-medium">错误信息</div>
        <div class="text-danger mt-2 text-sm break-all opacity-80">
          {{ testStore.currentResult.error }}
        </div>
        <div v-if="testStore.currentResult.status" class="text-xs text-danger/70 mt-2">
          HTTP状态码: {{ testStore.currentResult.status }}
        </div>
      </div>

      <div
        v-if="testStore.currentResult.warning && testStore.currentResult.connected"
        class="bg-warning/10 border border-warning/30 rounded-input p-4"
      >
        <div class="text-sm text-warning font-medium">警告</div>
        <div class="text-warning mt-2 text-sm opacity-80">
          {{ testStore.currentResult.warning }}
        </div>
      </div>

      <div v-if="testStore.currentResult.models && testStore.currentResult.models.length > 0">
        <h3 class="text-lg font-semibold text-text-primary mb-3">
          模型测试结果 ({{ testStore.currentResult.models.length }})
        </h3>

        <div class="space-y-2 max-h-80 overflow-y-auto pr-2">
          <div
            v-for="(model, index) in sortedModels"
            :key="index"
            class="bg-surface-alt rounded-input p-3 flex justify-between items-center"
          >
            <div class="flex-1 min-w-0">
              <div class="text-text-primary font-medium truncate">{{ model.model }}</div>
              <div v-if="model.error" class="text-xs text-danger truncate">{{ model.error }}</div>
            </div>

            <div class="flex items-center gap-3 ml-4">
              <span
                v-if="model.status === 'success'"
                class="text-success font-bold whitespace-nowrap"
              >
                {{ model.latency }}ms
              </span>
              <span v-else class="text-danger whitespace-nowrap"> 失败 </span>
              <span
                :class="model.status === 'success' ? 'text-success' : 'text-danger'"
                class="text-lg"
              >
                {{ model.status === 'success' ? '●' : '○' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="testStore.currentResult.summary" class="bg-surface-alt rounded-input px-4 py-3 mt-4">
        <div class="flex items-center justify-center gap-6 text-sm">
          <span><span class="text-text-secondary">成功：</span><span class="font-bold text-success">{{ testStore.currentResult.summary.success }}</span></span>
          <span><span class="text-text-secondary">失败：</span><span class="font-bold text-danger">{{ testStore.currentResult.summary.failed }}</span></span>
          <span><span class="text-text-secondary">平均延迟：</span><span class="font-bold text-accent">{{ testStore.currentResult.summary.avgLatency }}ms</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue'
import { useTestStore } from '../stores/testStore.js'

export default {
  name: 'ResultPanel',
  setup() {
    const testStore = useTestStore()

    const sortedModels = computed(() => {
      if (!testStore.currentResult?.models) return []
      return [...testStore.currentResult.models].sort((a, b) => {
        if (a.status === 'success' && b.status !== 'success') return -1
        if (a.status !== 'success' && b.status === 'success') return 1
        if (a.status === 'success' && b.status === 'success') {
          return (a.latency || 0) - (b.latency || 0)
        }
        return 0
      })
    })

    return {
      testStore,
      sortedModels,
    }
  },
}
</script>
