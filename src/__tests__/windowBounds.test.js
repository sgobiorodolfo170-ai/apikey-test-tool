import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { normalizeWindowBounds, DEFAULT_SIZE } = require('../../electron/lib/window-bounds.cjs')

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const left = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }

describe('normalizeWindowBounds', () => {
  it('keeps a position that is visible on a display', () => {
    const bounds = normalizeWindowBounds({ x: 100, y: 80, width: 1200, height: 800 }, [primary])
    expect(bounds).toEqual({ x: 100, y: 80, width: 1200, height: 800 })
  })

  it('supports secondary displays with negative coordinates', () => {
    const bounds = normalizeWindowBounds({ x: -1500, y: 100, width: 1000, height: 700 }, [
      primary,
      left,
    ])
    expect(bounds).toEqual({ x: -1500, y: 100, width: 1000, height: 700 })
  })

  it('drops an off-screen position and falls back to centered size', () => {
    const bounds = normalizeWindowBounds({ x: 5000, y: 3000, width: 1200, height: 800 }, [primary])
    expect(bounds).toEqual({ width: 1200, height: 800 })
    expect(bounds.x).toBeUndefined()
  })

  it('uses the default size when the state is empty or invalid', () => {
    expect(normalizeWindowBounds(null, [primary])).toEqual(DEFAULT_SIZE)
    expect(normalizeWindowBounds({ width: 'bad', height: -1 }, [primary])).toEqual(DEFAULT_SIZE)
  })
})
