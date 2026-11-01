<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/35"
    @click.self="close"
  >
    <div
      class="w-full max-w-[560px] rounded-card border border-border bg-surface shadow-elevated flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <div class="flex items-center justify-between border-b border-border px-5 py-3 flex-shrink-0">
        <h2 class="text-base font-medium text-text-primary">设置</h2>
        <button
          type="button"
          class="w-8 h-8 flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
          title="关闭"
          aria-label="关闭"
          @click="close"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div class="flex flex-col gap-3 px-5 py-4 overflow-y-auto">
        <div class="text-[14px] font-medium text-text-primary">数据目录</div>
        <div class="text-[13px] text-text-muted leading-relaxed">
          历史记录、渠道、中转站配置与 token
          统计都保存在此目录。切换后会复制现有数据，并自动重新加载界面。
        </div>
        <div
          class="rounded-card border border-border bg-surface-alt px-3 py-2 text-[13px] text-text-primary break-all cursor-pointer"
          title="点击复制路径"
          @click="copyPath"
        >
          {{ dataDir || '读取中…' }}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn-ghost text-sm px-3 py-1.5"
            :disabled="!canChoose || busy"
            @click="chooseDir"
          >
            {{ busy ? '切换中…' : '更改目录…' }}
          </button>
          <span v-if="copied" class="text-[13px] text-success">已复制路径</span>
          <span v-if="error" class="text-[13px] text-danger">{{ error }}</span>
        </div>
        <div v-if="!canChoose" class="text-[13px] text-text-muted">
          浏览器预览模式不支持修改数据目录，请在桌面应用中使用。
        </div>

        <div class="h-px bg-border my-1"></div>

        <div class="text-[14px] font-medium text-text-primary">版本更新</div>
        <div class="text-[13px] text-text-muted leading-relaxed">
          当前 v{{ updateStore.currentVersion }} · 最新
          {{ updateStore.latestVersion ? `v${updateStore.latestVersion}` : '未获取' }}
          <span v-if="updateStore.hasUpdate" class="text-accent">· 发现新版本</span>
          <span v-else-if="updateStore.checked" class="text-success">· 已是最新</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn-ghost text-sm px-3 py-1.5"
            :disabled="updateStore.checking"
            @click="checkUpdate"
          >
            {{ updateStore.checking ? '检查中…' : '检查更新' }}
          </button>
          <button
            v-if="updateStore.hasUpdate"
            type="button"
            class="text-sm px-3 py-1.5 rounded-btn bg-accent/15 text-accent hover:bg-accent/25"
            @click="openReleasePage"
          >
            查看发布页
          </button>
          <span v-if="updateStore.error" class="text-[13px] text-danger break-all">
            {{ updateStore.error }}
          </span>
        </div>
      </div>

      <div class="flex justify-end border-t border-border px-5 py-3 flex-shrink-0">
        <button type="button" class="btn-ghost text-sm px-3 py-1.5" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, ref, watch } from 'vue'
import { useUpdateStore } from '../stores/updateStore.js'

export default {
  name: 'SettingsDialog',
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const updateStore = useUpdateStore()
    const dataDir = ref('')
    const busy = ref(false)
    const error = ref('')
    const copied = ref(false)

    const canChoose = computed(
      () => typeof window !== 'undefined' && Boolean(window.electronAPI?.chooseDataDir),
    )

    const close = () => emit('close')

    const load = async () => {
      const api = typeof window !== 'undefined' ? window.electronAPI : null
      if (!api?.getDataDir) return
      try {
        const result = await api.getDataDir()
        if (result?.ok) dataDir.value = result.dataDir || ''
      } catch (e) {
        error.value = e.message || '读取数据目录失败'
      }
    }

    watch(
      () => props.open,
      (value) => {
        if (!value) return
        error.value = ''
        copied.value = false
        load()
      },
      { immediate: true },
    )

    const chooseDir = async () => {
      if (busy.value || !canChoose.value) return
      busy.value = true
      error.value = ''
      try {
        const result = await window.electronAPI.chooseDataDir()
        if (result?.canceled) return
        if (!result?.ok) {
          error.value = result?.error || '切换数据目录失败'
          return
        }
        dataDir.value = result.dataDir || dataDir.value
        // 数据目录已切换：重新加载界面，让各 store 从新目录读取数据
        setTimeout(() => {
          try {
            window.location.reload()
          } catch {
            // 非浏览器/测试环境忽略
          }
        }, 700)
      } catch (e) {
        error.value = e.message || '切换数据目录失败'
      } finally {
        busy.value = false
      }
    }

    const copyPath = async () => {
      if (!dataDir.value) return
      try {
        await navigator.clipboard.writeText(dataDir.value)
        copied.value = true
        setTimeout(() => {
          copied.value = false
        }, 1500)
      } catch {
        // 剪贴板不可用时忽略
      }
    }

    const checkUpdate = () => updateStore.check({ force: true })

    const openReleasePage = () => {
      const url = updateStore.releaseUrl
      if (!url) return
      const bridge = typeof window !== 'undefined' ? window.electronAPI : null
      if (bridge?.openExternal) bridge.openExternal(url)
      else window.open(url, '_blank', 'noopener')
    }

    return {
      updateStore,
      checkUpdate,
      openReleasePage,
      dataDir,
      busy,
      error,
      copied,
      canChoose,
      close,
      chooseDir,
      copyPath,
    }
  },
}
</script>

<style scoped></style>
