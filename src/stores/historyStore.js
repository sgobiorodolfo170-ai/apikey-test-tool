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
      this.records = await deleteTestRecord(id)
    },
    async clearAll() {
      this.records = await clearHistoryStorage()
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
  },
})
