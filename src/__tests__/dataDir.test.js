import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { resolveDataDir, migrateDataFiles, DATA_FILES } = require('../../electron/lib/data-dir.cjs')

describe('data dir', () => {
  let root
  let sourceDir
  let targetDir

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkey-data-'))
    sourceDir = path.join(root, 'source')
    targetDir = path.join(root, 'target')
    fs.mkdirSync(sourceDir)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('falls back to the config root for empty or missing directories', () => {
    expect(resolveDataDir(root, '')).toBe(root)
    expect(resolveDataDir(root, '   ')).toBe(root)
    expect(resolveDataDir(root, path.join(root, 'missing'))).toBe(root)
  })

  it('accepts an existing custom directory', () => {
    fs.mkdirSync(targetDir)
    expect(resolveDataDir(root, targetDir)).toBe(path.resolve(targetDir))
  })

  it('copies data files into a new directory', () => {
    fs.writeFileSync(path.join(sourceDir, 'history.json'), '[{"id":"1"}]')
    fs.writeFileSync(path.join(sourceDir, 'relay.json'), '{"port":8787}')

    const result = migrateDataFiles(sourceDir, targetDir)

    expect(result.copied).toEqual(expect.arrayContaining(['history.json', 'relay.json']))
    expect(fs.readFileSync(path.join(targetDir, 'history.json'), 'utf8')).toBe('[{"id":"1"}]')
    expect(fs.readFileSync(path.join(targetDir, 'relay.json'), 'utf8')).toBe('{"port":8787}')
  })

  it('keeps existing files in the target directory instead of overwriting', () => {
    fs.mkdirSync(targetDir)
    fs.writeFileSync(path.join(sourceDir, 'relay.json'), '{"port":8787}')
    fs.writeFileSync(path.join(targetDir, 'relay.json'), '{"port":9000}')

    const result = migrateDataFiles(sourceDir, targetDir)

    expect(result.kept).toContain('relay.json')
    expect(result.copied).not.toContain('relay.json')
    expect(fs.readFileSync(path.join(targetDir, 'relay.json'), 'utf8')).toBe('{"port":9000}')
  })

  it('creates the target directory and skips files that do not exist yet', () => {
    const nested = path.join(root, 'nested', 'data')
    const result = migrateDataFiles(sourceDir, nested)

    expect(fs.existsSync(nested)).toBe(true)
    expect(result.copied).toEqual([])
    expect(result.kept).toEqual([])
  })

  it('does nothing when source and target are the same directory', () => {
    const result = migrateDataFiles(sourceDir, sourceDir)
    expect(result).toEqual({ copied: [], kept: [] })
  })

  it('lists all project data files that follow the directory', () => {
    expect(DATA_FILES).toEqual([
      'history.json',
      'providers.json',
      'channels.json',
      'relay.json',
      'relay-usage.json',
      'ERROR_LOG.md',
    ])
  })
})
