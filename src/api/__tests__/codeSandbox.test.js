import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  stripCodeFences,
  staticCheckCode,
  verifyCodeAnswer,
  MAX_CODE_LENGTH,
} from '../codeSandbox.js'

describe('stripCodeFences', () => {
  it('extracts code from markdown fences', () => {
    const text = '这是实现：\n```js\nfunction solve(n) { return n }\n```\n以上。'
    expect(stripCodeFences(text)).toBe('function solve(n) { return n }')
  })

  it('keeps raw code untouched', () => {
    expect(stripCodeFences('function solve(n) { return n }')).toBe('function solve(n) { return n }')
  })

  it('handles empty input', () => {
    expect(stripCodeFences('')).toBe('')
    expect(stripCodeFences(null)).toBe('')
  })
})

describe('staticCheckCode', () => {
  it('accepts ordinary solutions', () => {
    expect(staticCheckCode('function solve(n) { return n * 2 }').ok).toBe(true)
  })

  it.each([
    ['require', "const fs = require('fs')"],
    ['process', 'process.exit(0)'],
    ['eval', 'eval("1+1")'],
    ['Function', 'Function("return 1")()'],
    ['constructor', 'this.constructor.constructor("return 1")()'],
    ['__proto__', 'x.__proto__ = null'],
    ['fetch', "fetch('http://x')"],
    ['死循环', 'while (true) {}'],
  ])('rejects %s', (_label, code) => {
    const result = staticCheckCode(code)
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('rejects empty and oversized code', () => {
    expect(staticCheckCode('').ok).toBe(false)
    expect(staticCheckCode('a'.repeat(MAX_CODE_LENGTH + 1)).ok).toBe(false)
  })
})

describe('verifyCodeAnswer', () => {
  const question = {
    type: 'code',
    language: 'js',
    tests: [{ input: 5, expected: 9 }],
  }

  beforeEach(() => {
    delete window.electronAPI
  })

  afterEach(() => {
    delete window.electronAPI
  })

  it('does not execute when the bridge is missing', async () => {
    const result = await verifyCodeAnswer(question, 'function solve(n) { return n }')
    expect(result.executed).toBe(false)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain('不支持')
  })

  it('does not call the runner for forbidden code', async () => {
    const runCode = vi.fn()
    window.electronAPI = { runCode }

    const result = await verifyCodeAnswer(question, "const fs = require('fs')")
    expect(result.executed).toBe(false)
    expect(runCode).not.toHaveBeenCalled()
  })

  it('passes when every test case passes', async () => {
    const runCode = vi.fn(async () => ({
      ok: true,
      results: [{ input: 5, expected: 9, actual: 9, pass: true }],
    }))
    window.electronAPI = { runCode }

    const result = await verifyCodeAnswer(question, '```js\nfunction solve(n){return 9}\n```')
    expect(result.executed).toBe(true)
    expect(result.passed).toBe(true)
    expect(runCode).toHaveBeenCalledWith({
      language: 'js',
      code: 'function solve(n){return 9}',
      tests: question.tests,
    })
  })

  it('fails when a test case mismatches', async () => {
    window.electronAPI = {
      runCode: vi.fn(async () => ({
        ok: true,
        results: [{ input: 5, expected: 9, actual: 7, pass: false }],
      })),
    }

    const result = await verifyCodeAnswer(question, 'function solve(n){return 7}')
    expect(result.executed).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('reports execution errors without throwing', async () => {
    window.electronAPI = {
      runCode: vi.fn(async () => ({ ok: false, error: '执行超时（>3000ms）' })),
    }

    const result = await verifyCodeAnswer(question, 'function solve(n){return n}')
    expect(result.executed).toBe(false)
    expect(result.reason).toContain('超时')
  })

  it('swallows runner exceptions', async () => {
    window.electronAPI = {
      runCode: vi.fn(async () => {
        throw new Error('boom')
      }),
    }

    const result = await verifyCodeAnswer(question, 'function solve(n){return n}')
    expect(result.executed).toBe(false)
    expect(result.reason).toBe('boom')
  })
})
