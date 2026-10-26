import { defineStore } from 'pinia'
import {
  runFingerprintMatch,
  runCapabilityTest,
  runStabilityTest,
  runConsistencyTest,
  CONSISTENCY_PROBES,
} from '../api/evalApi.js'
import { runCheckup, toHistoryCheckup } from '../api/checkup.js'
import { FINGERPRINT_PROBES } from '../data/fingerprints.js'
import { buildQuestionSet } from '../data/questionBank.js'
import { saveTestRecord } from '../utils/storage.js'
import { useHistoryStore } from './historyStore.js'
import { useToastStore } from './toastStore.js'

export const useEvalStore = defineStore('eval', {
  state: () => ({
    fingerprint: { loading: false, result: null, error: null, progress: { done: 0, total: 0 } },
    capability: { loading: false, result: null, error: null, progress: { done: 0, total: 0 } },
    stability: { loading: false, result: null, error: null, progress: { done: 0, total: 0 } },
    consistency: { loading: false, result: null, error: null, progress: { done: 0, total: 0 } },
    checkup: {
      loading: false,
      result: null,
      error: null,
      progress: { index: 0, total: 7, label: '' },
    },
  }),
  actions: {
    async runFingerprint(config, model) {
      this.fingerprint.loading = true
      this.fingerprint.error = null
      this.fingerprint.result = null
      this.fingerprint.progress = { done: 0, total: FINGERPRINT_PROBES.length }
      try {
        this.fingerprint.result = await runFingerprintMatch(config, model, {
          onProgress: (p) => {
            this.fingerprint.progress = p
          },
        })
      } catch (error) {
        this.fingerprint.error = error.message || '指纹匹配失败'
      } finally {
        this.fingerprint.loading = false
      }
    },
    async runCapability(config, model) {
      // 先建题再测：模板题每次随机生成，进度总数要跟实际题目一致
      const questions = buildQuestionSet()
      this.capability.loading = true
      this.capability.error = null
      this.capability.result = null
      this.capability.progress = { done: 0, total: questions.length }
      try {
        this.capability.result = await runCapabilityTest(config, model, {
          questions,
          onProgress: (p) => {
            this.capability.progress = p
          },
        })
      } catch (error) {
        this.capability.error = error.message || '能力测评失败'
      } finally {
        this.capability.loading = false
      }
    },
    async runStability(config, model, rounds = 5) {
      this.stability.loading = true
      this.stability.error = null
      this.stability.result = null
      this.stability.progress = { done: 0, total: rounds }
      try {
        this.stability.result = await runStabilityTest(config, model, {
          rounds,
          onProgress: (p) => {
            this.stability.progress = p
          },
        })
      } catch (error) {
        this.stability.error = error.message || '稳定性测试失败'
      } finally {
        this.stability.loading = false
      }
    },
    async runConsistency(config, model, rounds = 4) {
      this.consistency.loading = true
      this.consistency.error = null
      this.consistency.result = null
      this.consistency.progress = { done: 0, total: CONSISTENCY_PROBES.length * rounds }
      try {
        this.consistency.result = await runConsistencyTest(config, model, {
          rounds,
          onProgress: (p) => {
            this.consistency.progress = p
          },
        })
      } catch (error) {
        this.consistency.error = error.message || '一致性探测失败'
      } finally {
        this.consistency.loading = false
      }
    },
    async runFullCheckup(config, model, { persist = true } = {}) {
      const toastStore = useToastStore()
      this.checkup.loading = true
      this.checkup.error = null
      this.checkup.result = null
      this.checkup.progress = { index: 0, total: 7, label: '准备中' }

      try {
        const result = await runCheckup(config, {
          model,
          onProgress: (p) => {
            this.checkup.progress = { index: p.index, total: p.total, label: p.label }
          },
        })
        this.checkup.result = result

        // 体检结论一并沉淀到历史记录，形成可对比的「渠道档案」
        if (persist) {
          const record = {
            config: {
              provider: config.provider,
              baseUrl: config.baseUrl,
              apiMode: config.apiMode,
              apiKey: config.apiKey,
            },
            result: {
              connected: result.connection?.connected || false,
              connectTime: result.connection?.connectTime || 0,
              models: result.speed?.sample || [],
              summary: {
                success: result.speed?.success || 0,
                failed: (result.speed?.tested || 0) - (result.speed?.success || 0),
                avgLatency: result.speed?.avgLatency || 0,
              },
            },
            checkup: toHistoryCheckup(result),
          }
          await saveTestRecord(record)
          useHistoryStore().refresh()
        }

        toastStore.addToast(
          `体检完成：${result.verdict.score} 分（${result.verdict.level}）`,
          'success',
        )
        return result
      } catch (error) {
        this.checkup.error = error.message || '体检失败'
        toastStore.addToast('体检失败: ' + this.checkup.error, 'error')
        return null
      } finally {
        this.checkup.loading = false
      }
    },
  },
})
