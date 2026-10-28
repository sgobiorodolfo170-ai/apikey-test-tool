import {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  VISION_MAX_EDGE,
  estimateBase64Bytes,
} from '../api/multimodal.js'

// 发送前把图片压到视觉模型的有效分辨率内：
// 手机照片动辄 5MB，直接 base64 内联会让请求体膨胀十几倍，且模型也只会降采样。
export async function prepareImage(file) {
  if (!file) throw new Error('未选择图片')
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`不支持的图片格式：${file.type || '未知'}`)
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`)
  }

  const rawDataUrl = await readAsDataUrl(file)

  // 环境不支持 createImageBitmap（如部分测试环境）时直接返回原图
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return {
      dataUrl: rawDataUrl,
      name: file.name || 'image',
      bytes: estimateBase64Bytes(String(rawDataUrl).split(',')[1] || ''),
    }
  }

  // 解码/绘制失败时退回原图：宁可传大一点，也不要因为压缩环节挂掉而发不出去
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, VISION_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    // PNG 保留透明通道，其余转 JPEG 换取体积
    const isPng = file.type === 'image/png'
    const dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85)

    return {
      dataUrl,
      name: file.name || 'image',
      width,
      height,
      bytes: estimateBase64Bytes(dataUrl.split(',')[1] || ''),
    }
  } catch {
    return {
      dataUrl: rawDataUrl,
      name: file.name || 'image',
      bytes: estimateBase64Bytes(String(rawDataUrl).split(',')[1] || ''),
    }
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}
