<template>
  <div class="flex flex-col h-full min-h-0">
    <div
      v-if="channelStore.channels.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center gap-2 px-3"
    >
      <div class="text-text-muted text-sm">还没有保存的渠道</div>
      <div class="text-text-muted text-xs">
        在「配置」面板填好 Base URL 与 API Key 后，点「存为渠道」即可在这里切换与对比
      </div>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-2">
      <div
        v-for="channel in channelStore.channels"
        :key="channel.id"
        class="bg-surface-alt rounded p-2 border-l-2"
        :class="scoreColor(channel)"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-text-primary truncate" :title="channel.name">
              {{ channel.name }}
            </div>
            <div class="text-xs text-text-muted truncate" :title="channel.baseUrl">
              {{ modeLabel(channel.apiMode) }} · {{ channel.baseUrl }}
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <div
              v-if="lastCheckup(channel)"
              class="text-sm font-bold"
              :class="scoreTextColor(channel)"
            >
              {{ lastCheckup(channel).score }}
            </div>
            <div v-else class="text-xs text-text-muted">未体检</div>
            <div v-if="lastCheckup(channel)" class="text-[10px] text-text-muted">
              {{ shortTime(lastCheckup(channel).at) }}
            </div>
          </div>
        </div>

        <div class="flex gap-1 mt-2">
          <button
            class="btn-ghost text-xs px-2 py-0.5"
            title="填入配置面板"
            @click="useChannel(channel)"
          >
            使用
          </button>
          <button
            class="btn-primary text-xs px-2 py-0.5"
            :disabled="checkingId !== null"
            :title="'对该渠道跑一次完整体检'"
            @click="checkChannel(channel)"
          >
            {{ checkingId === channel.id ? '体检中' : '体检' }}
          </button>
          <button class="btn-danger text-xs px-2 py-0.5" @click="removeChannel(channel)">
            删除
          </button>
        </div>

        <div v-if="checkingId === channel.id" class="text-[11px] text-text-muted mt-1 truncate">
          {{ evalStore.checkup.progress.label }}
          ({{ Math.min(evalStore.checkup.progress.index + 1, evalStore.checkup.progress.total) }}/{{
            evalStore.checkup.progress.total
          }})
        </div>
      </div>
    </div>

    <div
      v-if="channelStore.channels.length > 0"
      class="text-[11px] text-text-muted mt-2 flex-shrink-0"
    >
      共 {{ channelStore.channels.length }} 条渠道 · 分数为最近一次体检结果
    </div>
  </div>
</template>

<script>
import { onMounted, ref } from 'vue'
import { useChannelStore } from '../stores/channelStore.js'
import { useHistoryStore } from '../stores/historyStore.js'
import { useEvalStore } from '../stores/evalStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { apiModeLabel } from '../api/modes.js'

export default {
  name: 'ChannelPanel',
  setup() {
    const channelStore = useChannelStore()
    const historyStore = useHistoryStore()
    const evalStore = useEvalStore()
    const toastStore = useToastStore()

    const checkingId = ref(null)

    const modeLabel = (apiMode) => apiModeLabel(apiMode) || apiMode || '未知模式'

    // 最近一次体检分数：从历史记录里按 Base URL 匹配，避免在渠道表里冗余存储
    const lastCheckup = (channel) => {
      const record = historyStore.records.find(
        (item) => item.checkup?.verdict && item.config?.baseUrl === channel.baseUrl,
      )
      return record ? { score: record.checkup.verdict.score, at: record.timestamp } : null
    }

    const scoreColor = (channel) => {
      const last = lastCheckup(channel)
      if (!last) return 'border-l-border'
      if (last.score >= 70) return 'border-l-success'
      if (last.score >= 55) return 'border-l-warning'
      return 'border-l-danger'
    }

    const scoreTextColor = (channel) => {
      const last = lastCheckup(channel)
      if (!last) return 'text-text-muted'
      if (last.score >= 70) return 'text-success'
      if (last.score >= 55) return 'text-warning'
      return 'text-danger'
    }

    const shortTime = (timestamp) => {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(
        date.getMinutes(),
      ).padStart(2, '0')}`
    }

    const useChannel = (channel) => {
      channelStore.apply(channel)
      toastStore.addToast(`已填入配置：${channel.name}`, 'success')
    }

    const checkChannel = async (channel) => {
      if (checkingId.value) return
      checkingId.value = channel.id
      try {
        const result = await evalStore.runFullCheckup(
          {
            provider: channel.name,
            baseUrl: channel.baseUrl,
            apiMode: channel.apiMode,
            apiKey: channel.apiKey,
          },
          '',
        )
        if (result) historyStore.refresh()
      } finally {
        checkingId.value = null
      }
    }

    const removeChannel = async (channel) => {
      if (!confirm(`确定删除渠道「${channel.name}」吗？`)) return
      await channelStore.remove(channel.id)
    }

    onMounted(() => {
      if (!channelStore.initialized) channelStore.load()
      if (!historyStore.initialized && !historyStore.loading) historyStore.loadHistory()
    })

    return {
      channelStore,
      evalStore,
      checkingId,
      modeLabel,
      lastCheckup,
      scoreColor,
      scoreTextColor,
      shortTime,
      useChannel,
      checkChannel,
      removeChannel,
    }
  },
}
</script>

<style scoped></style>
