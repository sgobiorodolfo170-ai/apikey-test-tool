// 多模态消息适配：应用内部统一用
//   { role, content: '文字', images: [{ dataUrl, name }] }
// 各协议在发送前转换成自己的结构。
//
// 图片统一以 data URL 保存，便于预览与直接内联到请求体，不依赖本地文件路径。

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
// 视觉模型常见的有效分辨率上限，超过这个边长再放大没有意义，只会浪费 token
export const VISION_MAX_EDGE = 1568
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function parseDataUrl(dataUrl) {
  const matched = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!matched) return null
  return { mimeType: matched[1], data: matched[2] }
}

export function hasImages(message) {
  return Array.isArray(message?.images) && message.images.length > 0
}

function usableImages(message) {
  if (!hasImages(message)) return []
  return message.images.map((image) => parseDataUrl(image?.dataUrl)).filter(Boolean)
}

// OpenAI / Azure / OpenAI-like：content 可以是字符串，也可以是 [{type:'text'|'image_url'}]
export function toOpenAIContent(message) {
  const images = usableImages(message)
  if (images.length === 0) return message?.content || ''

  const parts = []
  if (message.content) parts.push({ type: 'text', text: message.content })
  for (const image of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })
  }
  return parts
}

// OpenAI Responses：input 里用 input_text / input_image
export function toResponsesContent(message) {
  const images = usableImages(message)
  if (images.length === 0) return message?.content || ''

  const parts = []
  if (message.content) parts.push({ type: 'input_text', text: message.content })
  for (const image of images) {
    parts.push({
      type: 'input_image',
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })
  }
  return parts
}

// Anthropic：content 为 block 数组，图片走 base64 source
export function toAnthropicContent(message) {
  const images = usableImages(message)
  if (images.length === 0) return message?.content || ''

  const blocks = images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mimeType, data: image.data },
  }))
  if (message.content) blocks.push({ type: 'text', text: message.content })
  return blocks
}

// Gemini：parts 里放 text 与 inline_data
export function toGeminiParts(message) {
  const parts = []
  if (message?.content) parts.push({ text: message.content })
  for (const image of usableImages(message)) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } })
  }
  return parts.length > 0 ? parts : [{ text: '' }]
}

// Ollama：content 仍是字符串，图片放在独立的 images 数组里（纯 base64，不带前缀）
export function toOllamaMessage(message) {
  const images = usableImages(message).map((image) => image.data)
  return {
    role: message?.role,
    content: message?.content || '',
    ...(images.length > 0 ? { images } : {}),
  }
}

// 估算 base64 体积（用于 UI 提示），返回字节数
export function estimateBase64Bytes(base64) {
  if (!base64) return 0
  const padding = (base64.match(/=+$/) || [''])[0].length
  return Math.floor((base64.length * 3) / 4) - padding
}
