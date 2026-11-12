import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createWriteStream } from 'fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { ZipFile } from 'yazl'
import { HashCache } from './fileHash'
import { applyLocalMods, readLocalMods, resolveBuildPath } from './localMods'
import { ModIdentity, ModIdentityCache, planLocalMods, readModIdentity } from './modIds'
import { DevMarker, stageFiles, verifySource } from './stage'

let root: string

async function writeJar(path: string, entries: Record<string, string>) {
  await mkdir(join(path, '..'), { recursive: true })
  const zip = new ZipFile()
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name)
  zip.end()
  await pipeline(zip.outputStream as NodeJS.ReadableStream, createWriteStream(path))
}

const neoforge = (modId: string, version = '1.0.0', extra = '') => ({
  'META-INF/neoforge.mods.toml': `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="${modId}"\nversion="${version}"\n${extra}`,
})

const id = (...modIds: string[]): ModIdentity => ({ modIds, loader: 'neoforge' })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vmods-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readModIdentity', () => {
  test('reads NeoForge, Forge and Fabric metadata', async () => {
    await writeJar(join(root, 'n.jar'), neoforge('pockets', '2.1.0'))
    await writeJar(join(root, 'f.jar'), { 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="oldmod"\nversion="${file.jarVersion}"\n' })
    await writeJar(join(root, 'fa.jar'), { 'fabric.mod.json': JSON.stringify({ id: 'fabby', version: '3.0' }) })
    await writeJar(join(root, 'lib.jar'), { 'a.class': 'x' })
    expect(await readModIdentity(join(root, 'n.jar'))).toEqual({ modIds: ['pockets'], loader: 'neoforge', version: '2.1.0' })
    expect(await readModIdentity(join(root, 'f.jar'))).toEqual({ modIds: ['oldmod'], loader: 'forge', version: undefined })
    expect(await readModIdentity(join(root, 'fa.jar'))).toEqual({ modIds: ['fabby'], loader: 'fabric', version: '3.0' })
    expect(await readModIdentity(join(root, 'lib.jar'))).toEqual({ modIds: [], loader: 'unknown' })
  })

  test('lists every top-level mod a file declares', async () => {
    await writeJar(join(root, 'multi.jar'), neoforge('core', '1', '[[mods]]\nmodId="core_addon"\nversion="1"\n'))
    expect((await readModIdentity(join(root, 'multi.jar'))).modIds).toEqual(['core', 'core_addon'])
  })

  test('the cache keeps results on disk by hash', async () => {
    await writeJar(join(root, 'n.jar'), neoforge('pockets'))
    const file = join(root, 'cache', 'mod-ids.json')
    const cache = new ModIdentityCache(file)
    await cache.get(join(root, 'n.jar'), 'a'.repeat(64))
    await cache.save()
    const reloaded = new ModIdentityCache(file)
    // The path no longer matters once the hash is known.
    expect((await reloaded.get(join(root, 'missing.jar'), 'a'.repeat(64))).modIds).toEqual(['pockets'])
  })
})

describe('planLocalMods', () => {
  const instance = new Map([
    ['pockets-1.0.0.jar', id('pockets')],
    ['spatialenginelib-0.3.jar', id('spatialenginelib')],
    ['other.jar', id('other')],
  ])
  const request = (source: string, identity: ModIdentity, add = false, modId?: string) => ({ source, sha256: 'f'.repeat(64), identity, add, modId })

  test('replaces by mod ID even when the file name changed', () => {
    const plan = planLocalMods(instance, [request('/build/libs/pockets-1.1.0-dev.jar', id('pockets'))])
    expect(plan.mods).toEqual([expect.objectContaining({ file: 'pockets-1.1.0-dev.jar', replaces: ['pockets-1.0.0.jar'] })])
    expect(plan.existingDuplicates).toEqual([])
  })

  test('adding a new mod needs the add flag', () => {
    expect(() => planLocalMods(instance, [request('/b/veil-dev.jar', id('folded_veil_dev'))])).toThrow(expect.objectContaining({ name: 'ModNotInInstance' }))
    expect(planLocalMods(instance, [request('/b/veil-dev.jar', id('folded_veil_dev'), true)]).mods[0].replaces).toEqual([])
  })

  test('rejects builds without a mod ID or with the wrong one', () => {
    expect(() => planLocalMods(instance, [request('/b/lib.jar', { modIds: [], loader: 'unknown' }, true)])).toThrow(expect.objectContaining({ name: 'NoModId' }))
    expect(() => planLocalMods(instance, [request('/b/p.jar', id('pockets'), false, 'temporalengine')])).toThrow(expect.objectContaining({ name: 'ModIdMismatch' }))
  })

  test('catches two files claiming one mod ID', () => {
    expect(() => planLocalMods(instance, [
      request('/b/a.jar', id('newmod'), true),
      request('/c/b.jar', id('newmod'), true),
    ])).toThrow(expect.objectContaining({ name: 'DuplicateModId' }))
  })

  test('refuses a build whose file name belongs to an unrelated mod', () => {
    expect(() => planLocalMods(instance, [request('/b/other.jar', id('pockets'))])).toThrow(expect.objectContaining({ name: 'FileNameCollision' }))
  })

  test('reports duplicates that were already in the pack without failing', () => {
    const withDupes = new Map([...instance, ['a.jar', id('dup')], ['b.jar', id('dup')]])
    const plan = planLocalMods(withDupes, [request('/b/pockets.jar', id('pockets'))])
    expect(plan.existingDuplicates).toEqual([{ modId: 'dup', files: ['a.jar', 'b.jar'] }])
  })
})

describe('local builds', () => {
  test('resolves a versioned build path to exactly one jar', async () => {
    await writeFile(join(root, 'pockets-1.2.jar'), 'x')
    await writeFile(join(root, 'pockets-1.2-sources.jar'), 'x')
    expect(await resolveBuildPath(join(root, 'pockets-*.jar'))).toBe(join(root, 'pockets-1.2.jar'))
    await writeFile(join(root, 'pockets-1.3.jar'), 'x')
    await expect(resolveBuildPath(join(root, 'pockets-*.jar'))).rejects.toMatchObject({ name: 'LocalModMissing' })
    await expect(resolveBuildPath(join(root, 'nope.jar'))).rejects.toMatchObject({ name: 'LocalModMissing' })
  })

  test('checks pinned hashes', async () => {
    await writeJar(join(root, 'p.jar'), neoforge('pockets'))
    const cache = new ModIdentityCache()
    await expect(readLocalMods([{ path: join(root, 'p.jar'), sha256: '0'.repeat(64) }], new HashCache(), cache))
      .rejects.toMatchObject({ name: 'LocalModHashMismatch' })
    await expect(readLocalMods([{ path: join(root, 'p.jar'), sha512: '0'.repeat(128) }], new HashCache(), cache))
      .rejects.toMatchObject({ name: 'LocalModHashMismatch' })
  })

  test('a stage installs the build, and the next stage restores the original', async () => {
    const source = join(root, 'Working')
    const target = join(root, 'Test')
    await writeJar(join(source, 'mods', 'pockets-1.0.0.jar'), neoforge('pockets', '1.0.0'))
    await writeJar(join(source, 'mods', 'other.jar'), neoforge('other'))
    await writeJar(join(root, 'build', 'pockets-1.1.0.jar'), neoforge('pockets', '1.1.0'))
    await mkdir(target, { recursive: true })
    const hashes = new HashCache()
    const input = { sourcePath: source, targetPath: target, exclude: [], copyOnce: [], fresh: false, overlays: [], hashes }
    const marker: DevMarker = { version: 1, name: 'Test', source, createdAt: 0, mods: {} }

    const verified = await verifySource(input)
    const identities = new Map<string, ModIdentity>()
    for (const file of verified.mods.keys()) identities.set(file, await readModIdentity(join(source, 'mods', file)))
    const requests = await readLocalMods([{ path: join(root, 'build', 'pockets-*.jar') }], hashes, new ModIdentityCache())
    const plan = planLocalMods(identities, requests)
    await stageFiles(input, verified, marker)
    await applyLocalMods(target, marker, plan)
    expect(await readdir(join(target, 'mods'))).toEqual(['other.jar', 'pockets-1.1.0.jar'])
    expect(marker.localMods).toEqual({ 'pockets-1.1.0.jar': expect.objectContaining({ replaced: ['pockets-1.0.0.jar'] }) })

    // A later stage without the build is back to the pack's own files.
    const again = await stageFiles(input, await verifySource(input), marker)
    expect(again.mods.copied).toBe(1)
    expect(await readdir(join(target, 'mods'))).toEqual(['other.jar', 'pockets-1.0.0.jar'])
    expect(await readFile(join(target, 'mods', 'pockets-1.0.0.jar'))).toEqual(await readFile(join(source, 'mods', 'pockets-1.0.0.jar')))
    expect(marker.localMods).toEqual({})
  })
})
