import {
  testOpenAIConnection,
  listOpenAIModels,
  testModelLatency,
  testAllModelsConcurrently,
  sendOpenAIChat,
  streamOpenAIChat,
} from './openai.js'
import {
  testAnthropicConnection,
  listAnthropicModels,
  testAnthropicModelLatency,
  testAnthropicModels,
  sendAnthropicChat,
  streamAnthropicChat,
} from './anthropic.js'
import {
  testResponsesConnection,
  listResponsesModels,
  testResponsesModelLatency,
  testResponsesModels,
  sendResponsesChat,
  streamResponsesChat,
} from './responses.js'
import {
  testAzureConnection,
  listAzureModels,
  testAzureModelLatency,
  testAzureModels,
  sendAzureChat,
  streamAzureChat,
} from './azure.js'
import {
  testGeminiConnection,
  listGeminiModels,
  testGeminiModelLatency,
  testGeminiModels,
  sendGeminiChat,
  streamGeminiChat,
} from './gemini.js'
import {
  testOllamaConnection,
  listOllamaModels,
  testOllamaModelLatency,
  testOllamaModels,
  sendOllamaChat,
  streamOllamaChat,
} from './ollama.js'
import {
  testJevConnection,
  listJevModels,
  testJevModelLatency,
  testJevModels,
  sendJevChat,
} from './jev.js'
import {
  testImageConnection,
  listImageModels,
  testImageModelLatency,
  testImageModels,
  sendImageChat,
  testSpeechConnection,
  listSpeechModels,
  testSpeechModelLatency,
  testSpeechModels,
  sendSpeechChat,
} from './openai-media.js'

// 可选 API 模式（顺序即配置面板中的展示顺序）
export const API_MODES = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-like', label: 'OpenAI-like' },
  { value: 'openai-image', label: 'OpenAI 图片' },
  { value: 'openai-speech', label: 'OpenAI 语音' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'jev', label: 'Jev (TypeSafe)' },
]

// 无需 API Key 即可访问的模式（如本地 Ollama）
export const API_MODES_WITHOUT_KEY = ['ollama']

// 支持图片输入的模式（对话里可附图）。图片生成/语音/决策类模式不在此列。
export const VISION_CAPABLE_MODES = [
  'openai',
  'openai-like',
  'openai-responses',
  'anthropic',
  'azure-openai',
  'gemini',
  'ollama',
]

export function apiModeSupportsVision(apiMode) {
  return VISION_CAPABLE_MODES.includes(apiMode)
}

const openAIAdapter = {
  testConnection: testOpenAIConnection,
  listModels: listOpenAIModels,
  testModelLatency,
  testModels: testAllModelsConcurrently,
  chat: sendOpenAIChat,
  chatStream: streamOpenAIChat,
}

const ADAPTERS = {
  openai: openAIAdapter,
  'openai-like': openAIAdapter,
  'openai-responses': {
    testConnection: testResponsesConnection,
    listModels: listResponsesModels,
    testModelLatency: testResponsesModelLatency,
    testModels: testResponsesModels,
    chat: sendResponsesChat,
    chatStream: streamResponsesChat,
  },
  anthropic: {
    testConnection: testAnthropicConnection,
    listModels: listAnthropicModels,
    testModelLatency: testAnthropicModelLatency,
    testModels: testAnthropicModels,
    chat: sendAnthropicChat,
    chatStream: streamAnthropicChat,
  },
  'azure-openai': {
    testConnection: testAzureConnection,
    listModels: listAzureModels,
    testModelLatency: testAzureModelLatency,
    testModels: testAzureModels,
    chat: sendAzureChat,
    chatStream: streamAzureChat,
  },
  gemini: {
    testConnection: testGeminiConnection,
    listModels: listGeminiModels,
    testModelLatency: testGeminiModelLatency,
    testModels: testGeminiModels,
    chat: sendGeminiChat,
    chatStream: streamGeminiChat,
  },
  ollama: {
    testConnection: testOllamaConnection,
    listModels: listOllamaModels,
    testModelLatency: testOllamaModelLatency,
    testModels: testOllamaModels,
    chat: sendOllamaChat,
    chatStream: streamOllamaChat,
  },
  jev: {
    testConnection: testJevConnection,
    listModels: listJevModels,
    testModelLatency: testJevModelLatency,
    testModels: testJevModels,
    chat: sendJevChat,
  },
  'openai-image': {
    testConnection: testImageConnection,
    listModels: listImageModels,
    testModelLatency: testImageModelLatency,
    testModels: testImageModels,
    chat: sendImageChat,
  },
  'openai-speech': {
    testConnection: testSpeechConnection,
    listModels: listSpeechModels,
    testModelLatency: testSpeechModelLatency,
    testModels: testSpeechModels,
    chat: sendSpeechChat,
  },
}

export function getApiAdapter(apiMode) {
  // 老配置可能没有 apiMode，历史默认就是 OpenAI；只有明确写了未知模式才报错
  const adapter = ADAPTERS[apiMode || 'openai']
  if (!adapter) {
    // 以前静默回退 OpenAI，协议错配时会表现成“Key 无效/模型不存在”，很难排查
    throw new Error(
      `未知 API 模式：${apiMode}，可用模式：${API_MODES.map((m) => m.value).join(', ')}`,
    )
  }
  return adapter
}

export function apiModeNeedsKey(apiMode) {
  return !API_MODES_WITHOUT_KEY.includes(apiMode)
}

export function apiModeLabel(apiMode) {
  return API_MODES.find((mode) => mode.value === apiMode)?.label || apiMode || '未知'
}
