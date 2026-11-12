import type { LocalModChange, LocalModInput } from '@xmcl/runtime-api'
import { readdir, rm, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { HashCache, hashFile } from './fileHash'
import { LocalModPlan, LocalModRequest, ModIdentity, ModIdentityCache, planLocalMods } from './modIds'
import { DevMarker, cloneFile, globToRegExp, stageError } from './stage'

/** Resolve a build path, expanding one `*` in its file name to exactly one file. */
export async function resolveBuildPath(path: string): Promise<string> {
  const name = basename(path)
  if (!name.includes('*')) {
    if (!(await stat(path).catch(() => undefined))?.isFile()) throw stageError('LocalModMissing', `Local build not found: ${path}. Build it first.`)
    return path
  }
  const dir = dirname(path)
  if (dir.includes('*')) throw stageError('LocalModMissing', `Only the file name may contain *: ${path}`)
  const pattern = globToRegExp(name)
  const matches = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => pattern.test(f) && !/-(sources|javadoc)\.jar$/i.test(f))
    .sort()
  if (matches.length !== 1) {
    throw stageError('LocalModMissing', matches.length
      ? `${path} matches ${matches.length} files (${matches.join(', ')}); expected one`
      : `No file matches ${path}. Build it first.`)
  }
  return join(dir, matches[0])
}

/** Check builds exist and match their pinned hashes, and read their mod IDs. */
export async function readLocalMods(inputs: Array<LocalModInput & { path: string }>, hashes: HashCache, identities: ModIdentityCache): Promise<LocalModRequest[]> {
  const requests: LocalModRequest[] = []
  for (const input of inputs) {
    const source = await resolveBuildPath(input.path)
    const sha256 = await hashes.sha256(source)
    if (input.sha256 && input.sha256.toLowerCase() !== sha256) {
      throw stageError('LocalModHashMismatch', `${source} has SHA-256 ${sha256}, expected ${input.sha256}`)
    }
    if (input.sha512) {
      const sha512 = await hashFile(source, 'sha512')
      if (input.sha512.toLowerCase() !== sha512) throw stageError('LocalModHashMismatch', `${source} does not match its pinned SHA-512`)
    }
    requests.push({ source, sha256, identity: await identities.get(source, sha256), add: !!input.add, modId: input.modId })
  }
  return requests
}

/** Mod identities of the files that a stage puts in mods/, read from their source copies. */
export async function readInstanceIdentities(files: ReadonlyMap<string, { path: string; sha256: string }>, identities: ModIdentityCache, progress?: (done: number, total: number) => void) {
  const result = new Map<string, ModIdentity>()
  let done = 0
  for (const [file, { path, sha256 }] of files) {
    result.set(file, await identities.get(path, sha256))
    progress?.(++done, files.size)
  }
  return result
}

export function describePlan(plan: LocalModPlan, base: ReadonlyMap<string, { sha256: string }>, identities: ReadonlyMap<string, ModIdentity>): LocalModChange[] {
  return plan.mods.map((mod) => ({
    action: mod.replaces.length ? 'replaced' : 'added',
    file: mod.file,
    source: mod.source,
    sha256: mod.sha256,
    modIds: mod.identity.modIds,
    version: mod.identity.version,
    replaced: mod.replaces.map((file) => ({
      file,
      sha256: base.get(file)?.sha256 ?? '',
      modIds: identities.get(file)?.modIds ?? [],
      version: identities.get(file)?.version,
    })),
  }))
}

/** Install planned builds over a freshly staged mods/ folder and record them in the marker. */
export async function applyLocalMods(instancePath: string, marker: DevMarker, plan: LocalModPlan) {
  const modsDir = join(instancePath, 'mods')
  for (const mod of plan.mods) {
    for (const file of mod.replaces) {
      await rm(join(modsDir, file), { force: true })
      if (marker.mods[file]) marker.mods[file] = { ...marker.mods[file], mtimeMs: -1 }
    }
  }
  marker.localMods = {}
  for (const mod of plan.mods) {
    await cloneFile(mod.source, join(modsDir, mod.file))
    marker.localMods[mod.file] = { sha256: mod.sha256, source: mod.source, replaced: mod.replaces }
  }
}
