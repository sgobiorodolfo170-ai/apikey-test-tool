<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6"
    @click.self="$emit('close')"
  >
    <div
      class="bg-surface rounded-card shadow-elevated w-full max-w-4xl max-h-[80vh] flex flex-col"
    >
      <div class="flex items-start justify-between p-4 border-b border-border flex-shrink-0">
        <div>
          <h3 class="text-lg font-bold text-text-primary">渠道对比</h3>
          <p class="text-xs text-text-muted mt-0.5">
            按综合评分排序 · 共 {{ rows.length }} 条有体检记录的渠道
          </p>
        </div>
        <div class="flex gap-2">
          <button class="btn-ghost text-xs px-2 py-1" @click="copyTable">复制表格</button>
          <button class="btn-ghost text-xs px-2 py-1" @click="$emit('close')">关闭</button>
        </div>
      </div>

      <div class="overflow-auto p-4">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="text-text-secondary text-xs">
              <th class="text-left font-medium py-2 pr-3 border-b border-border">渠道</th>
              <th class="text-right font-medium py-2 px-2 border-b border-border">综合</th>
              <th class="text-right font-medium py-2 px-2 border-b border-border">变化</th>
              <th class="text-right font-medium py-2 px-2 border-b border-border">能力</th>
              <th class="text-right font-medium py-2 px-2 border-b border-border">稳定性</th>
              <th class="text-right font-medium py-2 px-2 border-b border-border">一致性</th>
              <th class="text-right font-medium py-2 pl-2 border-b border-border">最近体检</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in rows"
              :key="row.key"
              class="border-b border-border-light hover:bg-surface-hover"
            >
              <td class="py-2 pr-3">
                <div class="flex items-center gap-1.5">
                  <span
                    class="font-medium text-text-primary truncate max-w-[200px]"
                    :title="row.baseUrl"
                  >
                    {{ row.name }}
                  </span>
                  <span
                    v-if="index === 0 && rows.length > 1"
                    class="text-[10px] px-1.5 py-0.5 rounded-full bg-success/15 text-success"
                  >
                    最优
                  </span>
                  <span
                    v-if="index === rows.length - 1 && rows.length > 1"
                    class="text-[10px] px-1.5 py-0.5 rounded-full bg-danger/15 text-danger"
                  >
                    最低
                  </span>
                </div>
                <div class="text-[11px] text-text-muted truncate max-w-[220px]">
                  {{ modeLabel(row.apiMode) }}<span v-if="row.model"> · {{ row.model }}</span>
                </div>
              </td>
              <td class="text-right px-2">
                <span class="font-bold" :class="scoreClass(row)">{{ row.score }}</span>
              </td>
              <td class="text-right px-2 text-xs" :class="deltaClass(row.delta)">
                {{ deltaText(row.delta) }}
              </td>
              <td class="text-right px-2 text-text-primary">{{ cell(row.capability) }}</td>
              <td class="text-right px-2 text-text-primary">{{ cell(row.stability, '%') }}</td>
              <td class="text-right px-2 text-text-primary">{{ cell(row.consistency) }}</td>
              <td class="text-right pl-2 text-xs text-text-muted">
                {{ formatDate(row.checkedAt) }}
              </td>
            </tr>
          </tbody>
        </table>

        <p v-if="rows.length === 0" class="text-text-muted text-sm text-center py-6">
          还没有体检记录，先在「渠道」里对渠道执行一次体检
        </p>
      </div>

      <div class="px-4 pb-3 text-[11px] text-text-muted flex-shrink-0">
        综合分口径 v{{ scoreVersion }}：能力 55% + 稳定性 30% + 一致性
        15%；不同版本的分数不可直接比较
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue'
import { apiModeLabel } from '../api/modes.js'
import { toComparisonMarkdown, formatCompareDate, formatDelta } from '../utils/comparison.js'
import { SCORE_VERSION } from '../utils/report.js'
import { useToastStore } from '../stores/toastStore.js'

export default {
  name: 'ChannelCompare',
  props: {
    visible: { type: Boolean, default: false },
    rows: { type: Array, default: () => [] },
  },
  emits: ['close'],
  setup(props) {
    const toastStore = useToastStore()
    const scoreVersion = SCORE_VERSION

    const modeLabel = (apiMode) => apiModeLabel(apiMode) || apiMode || '未知模式'
    const formatDate = formatCompareDate
    const deltaText = formatDelta

    const cell = (value, suffix = '') =>
      value === null || value === undefined ? '—' : `${value}${suffix}`

    const scoreClass = (row) => {
      if (row.color === 'success') return 'text-success'
      if (row.color === 'warning') return 'text-warning'
      if (row.color === 'danger') return 'text-danger'
      return 'text-text-primary'
    }

    const deltaClass = (delta) => {
      if (delta === null || delta === undefined) return 'text-text-muted'
      if (delta > 0) return 'text-success'
      if (delta < 0) return 'text-danger'
      return 'text-text-muted'
    }

    const markdown = computed(() => toComparisonMarkdown(props.rows))

    const copyTable = async () => {
      if (!markdown.value) return
      try {
        await navigator.clipboard.writeText(markdown.value)
        toastStore.addToast('对比表已复制（Markdown）', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }

    return {
      modeLabel,
      formatDate,
      deltaText,
      cell,
      scoreClass,
      deltaClass,
      copyTable,
      scoreVersion,
    }
  },
}
</script>

<style scoped></style>
