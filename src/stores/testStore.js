import { defineStore } from 'pinia'
import { getApiAdapter } from '../api/modes.js'
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
    modelsError: null,
    fetchModelsSeq: 0,
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
      this.modelsError = null
      const requestId = ++this.fetchModelsSeq

      try {
        let models = []
        let failure = null

        const adapter = getApiAdapter(config.apiMode)
        const result = await adapter.listModels(config)
        if (result.success && result.models.length > 0) {
          models = result.models.map((m) => m.id)
        } else if (!result.success) {
          failure = result.error || '无法获取模型列表，请手动输入模型名称测试'
        }

        if (requestId !== this.fetchModelsSeq) return

        this.availableModels = models
        if (models.length === 0 && failure) {
          this.modelsError = failure
        }
      } catch (error) {
        if (requestId !== this.fetchModelsSeq) return
        console.error('获取模型失败:', error)
        this.availableModels = []
        this.modelsError = error.message || '获取模型失败'
      } finally {
        if (requestId === this.fetchModelsSeq) {
          this.isFetchingModels = false
        }
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

        const adapter = getApiAdapter(config.apiMode)
        connectionResult = await adapter.testConnection(config)

        if (connectionResult && connectionResult.connected) {
          const modelsResult = await adapter.listModels(config)
          if (modelsResult.success && modelsResult.models.length > 0) {
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
          modelResults = await adapter.testModels(config, models, 5)
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
    async testSingleModel(config, modelId) {
      const toastStore = useToastStore()
      const model = (modelId || '').trim()

      if (!model) {
        toastStore.addToast('请先指定要测试的模型', 'warning')
        return { success: false }
      }
      if (this.isTesting) {
        return { success: false }
      }

      this.isTesting = true
      this.lastTestConfig = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        apiMode: config.apiMode,
      }
      this.setCurrentResult({
        connected: false,
        connectTime: 0,
        testedModel: model,
        models: [],
        error: `正在测试模型 ${model} ...`,
      })

      try {
        const adapter = getApiAdapter(config.apiMode)
        const result = await adapter.testModelLatency(config, model)

        const success = result.status === 'success'
        const finalResult = {
          connected: success,
          connectTime: success ? result.latency : 0,
          testedModel: model,
          models: [result],
          error: success ? undefined : result.error || '模型连通测试失败',
          summary: {
            success: success ? 1 : 0,
            failed: success ? 0 : 1,
            avgLatency: success ? result.latency : 0,
          },
          config: {
            baseUrl: config.baseUrl,
            apiMode: config.apiMode,
            apiKey: config.apiKey,
          },
        }
        this.setCurrentResult(finalResult)

        if (success) {
          toastStore.addToast(`模型 ${model} 连通成功 (${result.latency}ms)`, 'success')
        } else {
          toastStore.addToast(`模型 ${model} 连通失败: ${finalResult.error}`, 'error')
        }
        return { success }
      } catch (error) {
        this.setCurrentResult({
          connected: false,
          connectTime: 0,
          testedModel: model,
          models: [],
          error: error.message || '测试过程中发生错误',
        })

        try {
          if (window.electronAPI?.logError) {
            await window.electronAPI.logError('Single Model Test Error', error.message, error.stack)
          }
        } catch {
          /* logError failures are non-critical */
        }
        return { success: false, error: error.message }
      } finally {
        this.isTesting = false
      }
    },
    // 只测选中的一批模型（不重新拉模型列表），用于模型列表里批量勾选的场景
    async testSelectedModels(config, models) {
      const toastStore = useToastStore()
      const list = (models || []).filter(Boolean)

      if (list.length === 0) {
        toastStore.addToast('请先选择要测试的模型', 'warning')
        return { success: false }
      }
      if (this.isTesting) return { success: false }

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
        error: `正在测试选中的 ${list.length} 个模型...`,
      })

      try {
        const adapter = getApiAdapter(config.apiMode)
        const modelResults = await adapter.testModels(config, list, 5)
        const successModels = modelResults.filter((m) => m.status === 'success')
        const avgLatency = successModels.length
          ? Math.round(successModels.reduce((sum, m) => sum + m.latency, 0) / successModels.length)
          : 0

        this.setCurrentResult({
          connected: successModels.length > 0,
          connectTime: avgLatency,
          models: modelResults,
          summary: {
            success: successModels.length,
            failed: modelResults.length - successModels.length,
            avgLatency,
          },
          config: {
            baseUrl: config.baseUrl,
            apiMode: config.apiMode,
            apiKey: config.apiKey,
          },
        })

        toastStore.addToast(
          `选中模型测试完成：${successModels.length}/${modelResults.length} 成功`,
          successModels.length > 0 ? 'success' : 'error',
        )
        return { success: true }
      } catch (error) {
        this.setCurrentResult({
          connected: false,
          connectTime: 0,
          models: [],
          error: error.message || '测试过程中发生错误',
        })
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
