<template>
  <div class="card p-4 flex flex-col h-full w-full">
    <div class="flex items-center gap-1 border-b border-border pb-2 mb-2 flex-shrink-0">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="px-2.5 py-1 text-sm rounded-card transition-colors"
        :class="
          activeTab === tab.id
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-surface-hover'
        "
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="flex-1 min-h-0">
      <ChatPanel v-if="activeTab === 'chat'" />
      <EvalPanel v-else />
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import ChatPanel from './ChatPanel.vue'
import EvalPanel from './EvalPanel.vue'

const TABS = [
  { id: 'chat', label: '聊天测试' },
  { id: 'eval', label: '模型测评' },
]

export default {
  name: 'ChatEvalPanel',
  components: { ChatPanel, EvalPanel },
  setup() {
    const activeTab = ref('chat')
    return { TABS, activeTab }
  },
}
</script>

<style scoped></style>
