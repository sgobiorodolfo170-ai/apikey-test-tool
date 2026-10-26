import { defineStore } from 'pinia'
import {
  readHistory,
  deleteTestRecord,
  clearHistory as clearHistoryStorage,
  readProviderSettings,
} from '../utils/storage.js'
import { useTestStore } from './testStore.js'
import { useToastStore } from './toastStore.js'

export const useHistoryStore = defineStore('history', {
  state: () => ({
    records: [],
    loading: false,
    initialized: false,
  }),
  actions: {
    async loadHistory() {
      this.loading = true
      try {
        this.records = await readHistory()
        this.initialized = true
      } finally {
        this.loading = false
      }
    },
    async deleteRecord(id) {
      const toastStore = useToastStore()
      try {
        this.records = await deleteTestRecord(id)
        return true
      } catch (error) {
        console.error('删除记录失败:', error)
        toastStore.addToast('删除失败: ' + (error.message || '写入文件失败'), 'error')
        return false
      }
    },
    async clearAll() {
      const toastStore = useToastStore()
      try {
        this.records = await clearHistoryStorage()
        return true
      } catch (error) {
        console.error('清空历史失败:', error)
        toastStore.addToast('清空失败: ' + (error.message || '写入文件失败'), 'error')
        return false
      }
    },
    refresh() {
      this.loadHistory()
    },
    async loadConfig(record) {
      const testStore = useTestStore()
      const toastStore = useToastStore()
      const config = { ...record.config }

      if (config.provider) {
        const saved = await readProviderSettings(config.provider)
        if (saved) {
          config.baseUrl = saved.baseUrl || config.baseUrl
          config.apiMode = saved.apiMode || config.apiMode
        }
      }

      testStore.setCurrentConfig(config)
      toastStore.addToast(`配置已加载: ${config.provider || '未知'}`, 'success')
    },
    async reloadRecord(record) {
      if (!record?.config) return
      const testStore = useTestStore()
      const toastStore = useToastStore()
      if (testStore.isTesting) {
        toastStore.addToast('正在测试中，请稍候', 'warning')
        return
      }
      await this.loadConfig(record)
      await testStore.testConnection({ ...testStore.currentConfig })
    },
  },
})
