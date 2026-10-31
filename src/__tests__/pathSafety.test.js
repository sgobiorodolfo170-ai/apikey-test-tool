import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isPathSafe } = require('../../electron/lib/path-safety.cjs')

const root = path.join(os.tmpdir(), 'apikey-path-root')

describe('isPathSafe', () => {
  it('allows files inside the root', () => {
    expect(isPathSafe(root, path.join(root, 'history.json'))).toBe(true)
    expect(isPathSafe(root, root)).toBe(true)
  })

  it('rejects a sibling directory sharing the same prefix', () => {
    expect(isPathSafe(root, `${root}X/secret.json`)).toBe(false)
  })

  it('rejects traversal and absolute paths outside the root', () => {
    expect(isPathSafe(root, path.join(root, '..', 'outside.json'))).toBe(false)
    expect(isPathSafe(root, path.join(os.tmpdir(), 'outside.json'))).toBe(false)
  })

  it('rejects empty or non-string input', () => {
    expect(isPathSafe(root, '')).toBe(false)
    expect(isPathSafe(root, null)).toBe(false)
    expect(isPathSafe(root, 123)).toBe(false)
  })
})
