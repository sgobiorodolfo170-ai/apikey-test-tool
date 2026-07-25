import { defineStore } from 'pinia'
import { testOpenAIConnection, listOpenAIModels, testAllModelsConcurrently } from '../api/openai.js'
import {
  testAnthropicConnection,
  listAnthropicModels,
  testAnthropicModels,
} from '../api/anthropic.js'
import { saveTestRecord, saveProvider } from '../utils/storage.js'
import { useHistoryStore } from './historyStore.js'
import { useToastStore } from './toastStore.js'

export const useTestStore = defineStore('test', {
  state: () => ({
    isTesting: false,
    isFetchingModels: false,
    hasResult: false,
    currentConfig: null,
    currentResult: null,
    lastTestConfig: null,
    availableModels: [],
  }),
  actions: {
    setTesting(val) {
      this.isTesting = val
    },
    setFetchingModels(val) {
      this.isFetchingModels = val
    },
    setHasResult(val) {
      this.hasResult = val
    },
    setAvailableModels(models) {
      this.availableModels = models
    },
    setCurrentConfig(config) {
      this.currentConfig = { ...config }
    },
    setCurrentResult(result) {
      this.currentResult = result
      this.hasResult = true
    },
    clearResult() {
      this.currentResult = null
      this.hasResult = false
    },
    async fetchModels(config) {
      this.isFetchingModels = true
      this.availableModels = []

      try {
        let models = []

        if (config.apiMode === 'openai' || config.apiMode === 'openai-like') {
          const result = await listOpenAIModels(config)
          if (result.success && result.models.length > 0) {
            models = result.models.map((m) => m.id)
          }
        } else if (config.apiMode === 'anthropic') {
          const result = await listAnthropicModels(config)
          if (result.models.length > 0) {
            models = result.models.map((m) => m.id)
          }
        }

        this.availableModels = models
      } catch (error) {
        console.error('获取模型失败:', error)
        this.availableModels = []
      } finally {
        this.isFetchingModels = false
      }
    },
    async testConnection(config) {
      this.isTesting = true
      this.lastTestConfig = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        apiMode: config.apiMode,
      }
      this.setCurrentResult({
        connected: false,
        connectTime: 0,
        models: [],
        error: '正在测试连接...',
      })

      try {
        let connectionResult = null
        let models = []

        if (config.apiMode === 'openai' || config.apiMode === 'openai-like') {
          connectionResult = await testOpenAIConnection(config)

          if (connectionResult && connectionResult.connected) {
            const modelsResult = await listOpenAIModels(config)
            if (modelsResult.success && modelsResult.models.length > 0) {
              models = modelsResult.models
            }
          }
        } else if (config.apiMode === 'anthropic') {
          connectionResult = await testAnthropicConnection(config)

          if (connectionResult && connectionResult.connected) {
            const modelsResult = await listAnthropicModels(config)
            models = modelsResult.models
          }
        }

        if (!connectionResult || !connectionResult.connected) {
          this.setCurrentResult({
            connected: false,
            connectTime: connectionResult?.connectTime || 0,
            error: connectionResult?.error || '连接失败，请检查Base URL和API Key',
            status: connectionResult?.status,
            models: [],
          })
          return { success: false }
        }

        let modelResults = []
        if (models && models.length > 0) {
          if (config.apiMode === 'openai' || config.apiMode === 'openai-like') {
            modelResults = await testAllModelsConcurrently(config, models, 5)
          } else {
            modelResults = await testAnthropicModels(config, models, 5)
          }
        }

        const successModels = modelResults.filter((m) => m.status === 'success')
        const failedModels = modelResults.filter((m) => m.status !== 'success')
        const avgLatency =
          successModels.length > 0
            ? Math.round(
                successModels.reduce((sum, m) => sum + m.latency, 0) / successModels.length,
              )
            : 0

        const finalResult = {
          connected: true,
          connectTime: connectionResult.connectTime,
          models: modelResults,
          summary: {
            success: successModels.length,
            failed: failedModels.length,
            avgLatency,
          },
          config: {
            baseUrl: config.baseUrl,
            apiMode: config.apiMode,
            apiKey: config.apiKey,
          },
        }

        this.setCurrentResult(finalResult)
        return { success: true }
      } catch (error) {
        const errorResult = {
          connected: false,
          connectTime: 0,
          error: error.message || '测试过程中发生错误',
          models: [],
        }
        this.setCurrentResult(errorResult)

        try {
          if (window.electronAPI?.logError) {
            await window.electronAPI.logError('API Test Error', error.message, error.stack)
          }
        } catch {
          /* logError failures are non-critical */
        }
        return { success: false, error: error.message }
      } finally {
        this.isTesting = false
      }
    },
    async saveResult(config) {
      const toastStore = useToastStore()
      const historyStore = useHistoryStore()

      if (!this.currentResult) {
        toastStore.addToast('没有可保存的结果', 'warning')
        return
      }

      try {
        if (config.provider) {
          await saveProvider(config.provider, {
            baseUrl: config.baseUrl,
            apiMode: config.apiMode,
          })
        }

        const record = {
          config: {
            provider: config.provider,
            baseUrl: config.baseUrl,
            apiMode: config.apiMode,
            apiKey: config.apiKey,
          },
          result: {
            connected: this.currentResult.connected,
            connectTime: this.currentResult.connectTime,
            models: this.currentResult.models,
            summary: this.currentResult.summary,
          },
        }

        await saveTestRecord(record)
        historyStore.refresh()
        toastStore.addToast('结果已保存', 'success')
      } catch (error) {
        console.error('保存失败:', error)
        toastStore.addToast('保存失败: ' + error.message, 'error')
      }
    },
  },
})
