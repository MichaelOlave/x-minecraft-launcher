import type { DevFileChange, StageDevInstanceResult } from '@xmcl/runtime-api'
import { constants } from 'fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { HashCache } from './fileHash'
import { compareWithLock, describeLockComparison, readLockedMods } from './packLock'

/** Marks a folder as a disposable instance staged by Vardrynn, and records what it owns. */
export const DEV_MARKER = '.vardrynn-dev.json'

export const DEFAULT_COPY_ONCE = ['config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'datapacks', 'shaderpacks', 'options.txt']

export interface StagedFile {
  sha256: string
  size: number
  mtimeMs: number
}

export interface DevMarker {
  version: 1
  name: string
  source: string
  createdAt: number
  stagedAt?: number
  /** Mods staged from the working instance, by file name. */
  mods: Record<string, StagedFile>
}

export function stageError(name: string, message: string) {
  return Object.assign(new Error(message), { name })
}

export async function readMarker(instancePath: string): Promise<DevMarker | undefined> {
  const raw = await readFile(join(instancePath, DEV_MARKER), 'utf8').catch(() => '')
  if (!raw) return undefined
  try {
    const marker = JSON.parse(raw) as DevMarker
    if (marker?.version !== 1 || typeof marker.mods !== 'object' || !marker.mods) return undefined
    return marker
  } catch {
    return undefined
  }
}

export async function writeMarker(instancePath: string, marker: DevMarker) {
  const path = join(instancePath, DEV_MARKER)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(marker, undefined, 2))
  await rename(temporary, path)
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The disposable instance must never share a folder with the working one. */
export function assertSeparate(sourcePath: string, targetPath: string) {
  const a = resolve(sourcePath)
  const b = resolve(targetPath)
  if (a === b || isInside(a, b) || isInside(b, a)) {
    throw stageError('UnsafeStage', 'The disposable instance must be separate from the working instance')
  }
}

/** A relative path inside the instance; rejects absolute paths and `..`. */
export function toInstanceRelative(path: string) {
  const normalized = normalize(path).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized === '.' || isAbsolute(path) || normalized.split('/').includes('..')) {
    throw stageError('UnsafeStage', `Expected a path inside the instance: ${path}`)
  }
  return normalized
}

/**
 * Symbolic links in a disposable instance could send the game's writes into
 * the working instance, so none are allowed except `allowed` ones: the
 * launcher's own links from an instance to its shared `libraries` and
 * `versions` folders, keyed by link path with the folder they must point to.
 */
export async function findSymlinks(root: string, limit = 5, allowed: ReadonlyMap<string, string> = new Map()): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const expected = allowed.get(path)
        const actual = expected ? await readlink(path).catch(() => '') : ''
        if (!expected || resolve(dirname(path), actual) !== resolve(expected)) found.push(path)
      } else if (entry.isDirectory()) {
        await walk(path)
      }
    }
  }
  if ((await lstat(root).catch(() => undefined))?.isSymbolicLink()) return [root]
  await walk(root)
  return found
}

export function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

async function listJars(folder: string) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.jar')).map((e) => e.name).sort()
}

/** Copy a file as a copy-on-write clone where supported, replacing the destination atomically. */
export async function cloneFile(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true })
  const temporary = join(dirname(to), `.${basename(to)}.${process.pid}.staging`)
  await copyFile(from, temporary, constants.COPYFILE_FICLONE)
  await rename(temporary, to)
}

/** Copy a file or folder tree as copy-on-write clones, skipping symbolic links. */
async function cloneTree(from: string, to: string) {
  await cp(from, to, {
    recursive: true,
    force: true,
    mode: constants.COPYFILE_FICLONE,
    filter: async (src) => !(await lstat(src)).isSymbolicLink() && basename(src) !== 'session.lock',
  })
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  await walk(root)
  return out.sort()
}

export interface StageInput {
  sourcePath: string
  targetPath: string
  lock?: { file: string; extra: string[] }
  exclude: string[]
  copyOnce: string[]
  fresh: boolean
  overlays: Array<{ from: string; to: string; mode: 'merge' | 'replace' }>
  world?: { from: string; name: string; reset: boolean }
  hashes: HashCache
  /** Launcher-owned links allowed in the instance: link path → the shared folder it must point to. */
  allowedLinks?: ReadonlyMap<string, string>
  progress?: (task: string, progress: number, total?: number, message?: string) => void
}

export interface VerifiedSource {
  /** Mod files of the working instance to stage, with their hashes. */
  mods: Map<string, string>
  excluded: string[]
  lock?: StageDevInstanceResult['lock']
}

/**
 * Check everything about the inputs that can fail before anything is
 * created: the working instance matches its lock, and the overlay and world
 * sources exist.
 */
export async function verifySource(input: StageInput): Promise<VerifiedSource> {
  assertSeparate(input.sourcePath, input.targetPath)
  const jars = await listJars(join(input.sourcePath, 'mods'))
  const hashes = new Map<string, string>()
  let done = 0
  for (const name of jars) {
    hashes.set(name, await input.hashes.sha256(join(input.sourcePath, 'mods', name)))
    input.progress?.('verify', ++done, jars.length, done === jars.length ? 'Checked working instance mods' : undefined)
  }

  let lock: VerifiedSource['lock']
  if (input.lock) {
    const locked = await readLockedMods(input.lock.file, input.lock.extra)
    const comparison = compareWithLock(locked.files, hashes)
    if (comparison.missing.length || comparison.unexpected.length || comparison.changed.length) {
      throw Object.assign(
        stageError('LockMismatch', `The working instance does not match ${input.lock.file}: ${describeLockComparison(comparison)}`),
        { comparison },
      )
    }
    lock = { file: input.lock.file, mods: locked.files.size, extra: locked.extra }
  }

  const patterns = input.exclude.map(globToRegExp)
  const excluded = jars.filter((name) => patterns.some((p) => p.test(name)))
  for (const name of excluded) hashes.delete(name)

  for (const overlay of input.overlays) {
    toInstanceRelative(overlay.to)
    if (!(await stat(overlay.from).catch(() => undefined))) {
      throw stageError('OverlayMissing', `Overlay source does not exist: ${overlay.from}`)
    }
    const links = await findSymlinks(overlay.from, 1)
    if (links.length) throw stageError('UnsafeStage', `Overlay sources must not contain symbolic links: ${links[0]}`)
  }
  if (input.world) {
    if (!(await stat(join(input.world.from, 'level.dat')).catch(() => undefined))?.isFile()) {
      throw stageError('WorldMissing', `No level.dat in the fixture world ${input.world.from}`)
    }
    if (basename(input.world.name) !== input.world.name || input.world.name.startsWith('.')) {
      throw stageError('UnsafeStage', `Invalid world folder name: ${input.world.name}`)
    }
  }
  return { mods: hashes, excluded, lock }
}

export type StageFilesResult = Pick<StageDevInstanceResult, 'mods' | 'copied' | 'overlays' | 'world'>

/**
 * Bring the disposable instance's files in line with the working instance.
 * Mods staged earlier are replaced only when they changed; anything in
 * `mods` that Vardrynn did not put there stops the stage, since it would
 * silently change what the test loads.
 */
export async function stageFiles(input: StageInput, verified: VerifiedSource, marker: DevMarker): Promise<StageFilesResult> {
  const { sourcePath, targetPath } = input
  const links = await findSymlinks(targetPath, 5, input.allowedLinks)
  if (links.length) {
    throw stageError('UnsafeStage', `The disposable instance contains symbolic links, which could write into other folders: ${links.join(', ')}`)
  }

  const modsDir = join(targetPath, 'mods')
  await mkdir(modsDir, { recursive: true })
  const present = await listJars(modsDir)
  const unknown = present.filter((name) => !marker.mods[name])
  if (unknown.length) {
    throw stageError('UnmanagedMods', `mods/ contains files Vardrynn did not stage: ${unknown.join(', ')}. Remove them first.`)
  }

  const removed: string[] = []
  for (const name of present) {
    if (!verified.mods.has(name)) {
      await rm(join(modsDir, name), { force: true })
      delete marker.mods[name]
      removed.push(name)
    }
  }

  let copied = 0
  let done = 0
  const total = verified.mods.size
  for (const [name, sha256] of verified.mods) {
    const target = join(modsDir, name)
    const recorded = marker.mods[name]
    const current = await stat(target).catch(() => undefined)
    const unchanged = recorded && current && recorded.sha256 === sha256 && recorded.size === current.size && recorded.mtimeMs === current.mtimeMs
    if (!unchanged) {
      await cloneFile(join(sourcePath, 'mods', name), target)
      const written = await stat(target)
      marker.mods[name] = { sha256, size: written.size, mtimeMs: written.mtimeMs }
      copied++
    }
    input.progress?.('mods', ++done, total, done === total ? `Staged ${total} mods (${copied} copied)` : undefined)
  }

  const copiedOnce: string[] = []
  for (const entry of input.copyOnce) {
    const rel = toInstanceRelative(entry)
    const from = join(sourcePath, rel)
    const to = join(targetPath, rel)
    if (!(await lstat(from).catch(() => undefined))) continue
    if (input.fresh) await rm(to, { recursive: true, force: true })
    if (await lstat(to).catch(() => undefined)) continue
    await cloneTree(from, to)
    copiedOnce.push(rel)
  }

  const overlays: DevFileChange[] = []
  for (const overlay of input.overlays) {
    const rel = toInstanceRelative(overlay.to)
    const to = join(targetPath, rel)
    const isFolder = (await stat(overlay.from)).isDirectory()
    const before = new Map<string, string>()
    if (overlay.mode === 'replace' && (await stat(to).catch(() => undefined))) {
      for (const file of (await stat(to)).isDirectory() ? await listFiles(to) : [to]) {
        before.set(file, await input.hashes.sha256(file))
      }
      await rm(to, { recursive: true, force: true })
    }
    const sources = isFolder ? await listFiles(overlay.from) : [overlay.from]
    const written = new Set<string>()
    for (const file of sources) {
      const dest = isFolder ? join(to, relative(overlay.from, file)) : to
      const sha256 = await input.hashes.sha256(file)
      const previous = before.get(dest) ?? (await stat(dest).catch(() => undefined) ? await input.hashes.sha256(dest) : undefined)
      written.add(dest)
      if (previous === sha256 && before.size === 0) continue
      await cloneFile(file, dest)
      if (previous !== sha256) {
        overlays.push({ path: relative(targetPath, dest).split(sep).join('/'), action: previous ? 'changed' : 'added', sha256, previousSha256: previous })
      }
    }
    for (const [file, sha256] of before) {
      if (!written.has(file)) overlays.push({ path: relative(targetPath, file).split(sep).join('/'), action: 'removed', previousSha256: sha256 })
    }
  }

  let world: StageFilesResult['world']
  if (input.world) {
    const saves = join(targetPath, 'saves')
    const dest = join(saves, input.world.name)
    const exists = !!(await stat(dest).catch(() => undefined))
    if (exists && !input.world.reset) {
      world = { name: input.world.name, path: dest, copied: false }
    } else {
      await mkdir(saves, { recursive: true })
      const temporary = join(saves, `.${input.world.name}.${process.pid}.staging`)
      await rm(temporary, { recursive: true, force: true })
      await cloneTree(input.world.from, temporary)
      await rm(dest, { recursive: true, force: true })
      await rename(temporary, dest)
      world = { name: input.world.name, path: dest, copied: true }
    }
  }

  return {
    mods: { total, copied, removed, excluded: verified.excluded },
    copied: copiedOnce,
    overlays,
    world,
  }
}
