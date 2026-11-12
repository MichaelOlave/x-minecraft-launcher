import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { HashCache } from './fileHash'
import { DevMarker, StageInput, assertSeparate, globToRegExp, stageFiles, toInstanceRelative, verifySource } from './stage'
import { readLockedMods } from './packLock'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

let root: string
let source: string
let target: string
let pack: string

async function put(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function marker(): DevMarker {
  return { version: 1, name: 'Test', source, createdAt: 0, mods: {} }
}

function input(extra: Partial<StageInput> = {}): StageInput {
  return {
    sourcePath: source,
    targetPath: target,
    lock: { file: join(pack, 'pack-lock.json'), extra: [] },
    exclude: ['sentry-*'],
    copyOnce: ['config', 'kubejs', 'options.txt'],
    fresh: false,
    overlays: [],
    hashes: new HashCache(),
    ...extra,
  }
}

async function writeLock(mods: Record<string, string>, inactive: Record<string, string> = {}) {
  const artifacts = [
    ...Object.entries(mods).map(([file, content]) => ({ file, sha256: sha(content), active: true })),
    ...Object.entries(inactive).map(([file, content]) => ({ file, sha256: sha(content), active: false })),
  ]
  await put(join(pack, 'pack-lock.json'), JSON.stringify({ artifacts }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vstage-'))
  source = join(root, 'instances', 'Working')
  target = join(root, 'instances', 'Test')
  pack = join(root, 'pack')
  await put(join(source, 'mods', 'a.jar'), 'A')
  await put(join(source, 'mods', 'b.jar'), 'B')
  await put(join(source, 'mods', 'sentry-x.jar'), 'S')
  await put(join(source, 'config', 'x.toml'), 'x=1')
  await put(join(source, 'kubejs', 'server_scripts', 's.js'), 'log()')
  await put(join(source, 'options.txt'), 'fov:70')
  await put(join(source, 'saves', 'Mine', 'level.dat'), 'mine')
  await put(join(pack, 'worlds', 'Fixture', 'level.dat'), 'fixture')
  await put(join(pack, 'worlds', 'Fixture', 'region', 'r.0.0.mca'), 'region')
  await put(join(pack, 'worlds', 'Fixture', 'session.lock'), 'lock')
  await writeLock({ 'a.jar': 'A', 'b.jar': 'B', 'sentry-x.jar': 'S' }, { 'old.jar': 'O' })
  await mkdir(target, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('pack lock', () => {
  test('reads only active artifacts and hashes extra files', async () => {
    await put(join(pack, 'overrides', 'mods', 'fix.jar'), 'F')
    const locked = await readLockedMods(join(pack, 'pack-lock.json'), [join(pack, 'overrides', 'mods', 'fix.jar')])
    expect([...locked.files.keys()].sort()).toEqual(['a.jar', 'b.jar', 'fix.jar', 'sentry-x.jar'])
    expect(locked.files.get('fix.jar')).toBe(sha('F'))
    expect(locked.extra).toEqual(['fix.jar'])
  })

  test('rejects a lock without artifacts', async () => {
    await put(join(pack, 'bad.json'), '{}')
    await expect(readLockedMods(join(pack, 'bad.json'))).rejects.toMatchObject({ name: 'LockUnreadable' })
  })
})

describe('verifySource', () => {
  test('accepts a working instance that matches the lock, minus excluded mods', async () => {
    const verified = await verifySource(input())
    expect([...verified.mods.keys()]).toEqual(['a.jar', 'b.jar'])
    expect(verified.excluded).toEqual(['sentry-x.jar'])
    expect(verified.lock).toMatchObject({ mods: 3, extra: [] })
  })

  test('reports changed, unexpected and missing mods', async () => {
    await put(join(source, 'mods', 'b.jar'), 'B2')
    await put(join(source, 'mods', 'd.jar'), 'D')
    await rm(join(source, 'mods', 'a.jar'))
    const error = await verifySource(input()).catch((e) => e)
    expect(error.name).toBe('LockMismatch')
    expect(error.comparison).toEqual({ missing: ['a.jar'], unexpected: ['d.jar'], changed: ['b.jar'] })
    expect(error.message).toContain('different from the lock (1): b.jar')
  })

  test('accepts a newer mod listed as an extra lock file', async () => {
    await put(join(source, 'mods', 'fix.jar'), 'F')
    await put(join(pack, 'fix.jar'), 'F')
    const verified = await verifySource(input({ lock: { file: join(pack, 'pack-lock.json'), extra: [join(pack, 'fix.jar')] } }))
    expect(verified.mods.has('fix.jar')).toBe(true)
  })

  test('rejects a missing world or overlay before anything is staged', async () => {
    await expect(verifySource(input({ world: { from: join(pack, 'nope'), name: 'W', reset: true } }))).rejects.toMatchObject({ name: 'WorldMissing' })
    await expect(verifySource(input({ overlays: [{ from: join(pack, 'nope'), to: 'config', mode: 'merge' }] }))).rejects.toMatchObject({ name: 'OverlayMissing' })
    await expect(verifySource(input({ overlays: [{ from: pack, to: '../escape', mode: 'merge' }] }))).rejects.toMatchObject({ name: 'UnsafeStage' })
  })

  test('refuses a target inside the working instance', async () => {
    await expect(verifySource(input({ targetPath: join(source, 'nested') }))).rejects.toMatchObject({ name: 'UnsafeStage' })
  })
})

describe('stageFiles', () => {
  test('stages mods, settings and a fresh world', async () => {
    const i = input({ world: { from: join(pack, 'worlds', 'Fixture'), name: 'Fixture', reset: true } })
    const m = marker()
    const result = await stageFiles(i, await verifySource(i), m)
    expect(result.mods).toEqual({ total: 2, copied: 2, removed: [], excluded: ['sentry-x.jar'] })
    expect(result.copied).toEqual(['config', 'kubejs', 'options.txt'])
    expect(await readdir(join(target, 'mods'))).toEqual(['a.jar', 'b.jar'])
    expect(await readFile(join(target, 'kubejs', 'server_scripts', 's.js'), 'utf8')).toBe('log()')
    expect(await readdir(join(target, 'saves', 'Fixture'))).toEqual(['level.dat', 'region'])
    expect(Object.keys(m.mods)).toEqual(['a.jar', 'b.jar'])
    expect(m.mods['a.jar'].sha256).toBe(sha('A'))
    // Saves of the working instance are never copied.
    expect(await stat(join(target, 'saves', 'Mine')).catch(() => undefined)).toBeUndefined()
  })

  test('writes to the copy never reach the working instance', async () => {
    const i = input()
    await stageFiles(i, await verifySource(i), marker())
    await writeFile(join(target, 'mods', 'a.jar'), 'tampered')
    await writeFile(join(target, 'config', 'x.toml'), 'x=2')
    expect(await readFile(join(source, 'mods', 'a.jar'), 'utf8')).toBe('A')
    expect(await readFile(join(source, 'config', 'x.toml'), 'utf8')).toBe('x=1')
  })

  test('a restage keeps unchanged mods and settings changed while testing', async () => {
    const m = marker()
    const i = input()
    await stageFiles(i, await verifySource(i), m)
    await writeFile(join(target, 'config', 'x.toml'), 'x=tuned')
    const again = await stageFiles(i, await verifySource(i), m)
    expect(again.mods.copied).toBe(0)
    expect(again.copied).toEqual([])
    expect(await readFile(join(target, 'config', 'x.toml'), 'utf8')).toBe('x=tuned')

    const fresh = await stageFiles({ ...i, fresh: true }, await verifySource(i), m)
    expect(fresh.copied).toEqual(['config', 'kubejs', 'options.txt'])
    expect(await readFile(join(target, 'config', 'x.toml'), 'utf8')).toBe('x=1')
  })

  test('replaces a staged mod that was modified and removes ones the source dropped', async () => {
    const m = marker()
    const i = input({ lock: undefined })
    await stageFiles(i, await verifySource(i), m)
    await writeFile(join(target, 'mods', 'a.jar'), 'tampered')
    await rm(join(source, 'mods', 'b.jar'))
    const again = await stageFiles(i, await verifySource(i), m)
    expect(again.mods).toMatchObject({ copied: 1, removed: ['b.jar'] })
    expect(await readFile(join(target, 'mods', 'a.jar'), 'utf8')).toBe('A')
    expect(await readdir(join(target, 'mods'))).toEqual(['a.jar'])
    expect(m.mods['b.jar']).toBeUndefined()
  })

  test('stops when mods/ has files it did not stage', async () => {
    const i = input()
    await put(join(target, 'mods', 'stray.jar'), 'X')
    await expect(stageFiles(i, await verifySource(i), marker())).rejects.toMatchObject({ name: 'UnmanagedMods' })
  })

  test('refuses symbolic links in the disposable instance', async () => {
    const i = input()
    await symlink(join(source, 'config'), join(target, 'config'))
    await expect(stageFiles(i, await verifySource(i), marker())).rejects.toMatchObject({ name: 'UnsafeStage' })
  })

  test('allows only the launcher links to its shared folders', async () => {
    const shared = join(root, 'shared')
    await mkdir(join(shared, 'libraries'), { recursive: true })
    await mkdir(join(shared, 'elsewhere'), { recursive: true })
    await symlink(join(shared, 'libraries'), join(target, 'libraries'))
    const allowedLinks = new Map([[join(target, 'libraries'), join(shared, 'libraries')], [join(target, 'versions'), join(shared, 'versions')]])
    const i = input({ allowedLinks })
    await expect(stageFiles(i, await verifySource(i), marker())).resolves.toBeDefined()
    await symlink(join(shared, 'elsewhere'), join(target, 'versions'))
    await expect(stageFiles(i, await verifySource(i), marker())).rejects.toMatchObject({ name: 'UnsafeStage' })
  })

  test('applies overlays and reports what changed', async () => {
    await put(join(pack, 'overlay', 'config', 'x.toml'), 'x=overlay')
    await put(join(pack, 'overlay', 'config', 'new.toml'), 'n=1')
    const overlays = [{ from: join(pack, 'overlay', 'config'), to: 'config', mode: 'merge' as const }]
    const m = marker()
    const i = input({ overlays })
    const first = await stageFiles(i, await verifySource(i), m)
    expect(first.overlays.map((c) => [c.path, c.action])).toEqual([['config/new.toml', 'added'], ['config/x.toml', 'changed']])
    expect(first.overlays[1]).toMatchObject({ previousSha256: sha('x=1'), sha256: sha('x=overlay') })
    const again = await stageFiles(i, await verifySource(i), m)
    expect(again.overlays).toEqual([])
  })

  test('a replace overlay removes files the source no longer has', async () => {
    await put(join(pack, 'assets', 'a.json'), 'a')
    await put(join(pack, 'assets', 'b.json'), 'b')
    const overlays = [{ from: join(pack, 'assets'), to: 'resourcepacks/dev/assets', mode: 'replace' as const }]
    const m = marker()
    const i = input({ overlays })
    await stageFiles(i, await verifySource(i), m)
    await rm(join(pack, 'assets', 'b.json'))
    await put(join(pack, 'assets', 'a.json'), 'a2')
    const again = await stageFiles(i, await verifySource(i), m)
    expect(again.overlays.map((c) => [c.path, c.action])).toEqual([['resourcepacks/dev/assets/a.json', 'changed'], ['resourcepacks/dev/assets/b.json', 'removed']])
    expect(await readdir(join(target, 'resourcepacks', 'dev', 'assets'))).toEqual(['a.json'])
  })

  test('keeps the world from the last stage only when asked', async () => {
    const world = { from: join(pack, 'worlds', 'Fixture'), name: 'Fixture', reset: false }
    const m = marker()
    const i = input({ world })
    await stageFiles(i, await verifySource(i), m)
    await writeFile(join(target, 'saves', 'Fixture', 'level.dat'), 'played')
    expect((await stageFiles(i, await verifySource(i), m)).world?.copied).toBe(false)
    expect(await readFile(join(target, 'saves', 'Fixture', 'level.dat'), 'utf8')).toBe('played')
    const reset = { ...i, world: { ...world, reset: true } }
    expect((await stageFiles(reset, await verifySource(reset), m)).world?.copied).toBe(true)
    expect(await readFile(join(target, 'saves', 'Fixture', 'level.dat'), 'utf8')).toBe('fixture')
  })
})

describe('helpers', () => {
  test('instance-relative paths cannot escape the instance', () => {
    expect(toInstanceRelative('config/')).toBe('config')
    expect(() => toInstanceRelative('../x')).toThrow()
    expect(() => toInstanceRelative('/etc')).toThrow()
    expect(() => toInstanceRelative('a/../../b')).toThrow()
  })

  test('separate folders are required', () => {
    expect(() => assertSeparate('/a/b', '/a/b')).toThrow()
    expect(() => assertSeparate('/a/b', '/a/b/c')).toThrow()
    expect(() => assertSeparate('/a/b/c', '/a/b')).toThrow()
    expect(() => assertSeparate('/a/b', '/a/bc')).not.toThrow()
  })

  test('glob patterns match whole file names', () => {
    expect(globToRegExp('sentry-*').test('sentry-minecraft.jar')).toBe(true)
    expect(globToRegExp('sentry-*').test('my-sentry-x.jar')).toBe(false)
    expect(globToRegExp('a?.jar').test('ab.jar')).toBe(true)
  })
})
