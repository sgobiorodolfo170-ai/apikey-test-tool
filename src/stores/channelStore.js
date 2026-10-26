import { defineStore } from 'pinia'
import { readChannels, saveChannel, deleteChannel } from '../utils/storage.js'
import { useToastStore } from './toastStore.js'

export const useChannelStore = defineStore('channel', {
  state: () => ({
    channels: [],
    loading: false,
    initialized: false,
    // 供 ConfigPanel 消费的「待应用渠道」：ChannelPanel 点「使用」时写入，
    // ConfigPanel 监听后填充表单并清空。这样两个卡片之间不需要直接引用。
    pendingApply: null,
  }),
  getters: {
    count: (state) => state.channels.length,
  },
  actions: {
    async load({ force = false } = {}) {
      if (this.loading) return
      if (this.initialized && !force) return
      this.loading = true
      try {
        this.channels = await readChannels()
        this.initialized = true
      } catch (error) {
        useToastStore().addToast('读取渠道失败: ' + error.message, 'error')
      } finally {
        this.loading = false
      }
    },
    async upsert(channel) {
      const toastStore = useToastStore()
      try {
        this.channels = await saveChannel(channel)
        this.initialized = true
        toastStore.addToast(`渠道「${channel.name}」已保存`, 'success')
        return true
      } catch (error) {
        toastStore.addToast('保存渠道失败: ' + error.message, 'error')
        return false
      }
    },
    async remove(id) {
      const toastStore = useToastStore()
      try {
        this.channels = await deleteChannel(id)
        toastStore.addToast('渠道已删除', 'success')
        return true
      } catch (error) {
        toastStore.addToast('删除渠道失败: ' + error.message, 'error')
        return false
      }
    },
    apply(channel) {
      this.pendingApply = { ...channel }
    },
    consumeApply() {
      const channel = this.pendingApply
      this.pendingApply = null
      return channel
    },
  },
})
