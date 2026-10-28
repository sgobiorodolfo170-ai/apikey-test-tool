import { describe, it, expect } from 'vitest'
import { prepareImage } from '../image.js'
import { MAX_IMAGE_BYTES } from '../../api/multimodal.js'

function makeFile(bytes = [1, 2, 3], name = 'a.png', type = 'image/png') {
  return new File([new Uint8Array(bytes)], name, { type })
}

describe('prepareImage', () => {
  it('rejects unsupported formats', async () => {
    await expect(prepareImage(makeFile([1], 'a.bmp', 'image/bmp'))).rejects.toThrow(
      '不支持的图片格式',
    )
  })

  it('rejects oversized files', async () => {
    const big = makeFile([1], 'big.png', 'image/png')
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })

    await expect(prepareImage(big)).rejects.toThrow('图片过大')
  })

  it('rejects a missing file', async () => {
    await expect(prepareImage(null)).rejects.toThrow('未选择图片')
  })

  it('returns a data url and byte estimate', async () => {
    const prepared = await prepareImage(makeFile([137, 80, 78, 71], 'cat.png'))

    expect(prepared.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(prepared.name).toBe('cat.png')
    expect(prepared.bytes).toBeGreaterThan(0)
  })
})
