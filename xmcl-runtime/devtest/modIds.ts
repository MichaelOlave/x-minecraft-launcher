import { readFabricMod, readForgeModToml, readQuiltMod } from '@xmcl/mod-parser'
import { openFileSystem } from '@xmcl/system'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

export interface ModIdentity {
  /** Mod IDs the file declares at top level. Jar-in-jar libraries are not counted. */
  modIds: string[]
  loader: 'neoforge' | 'forge' | 'fabric' | 'quilt' | 'unknown'
  version?: string
}

/** Read the mod IDs a mod file declares, from whichever loader metadata it carries. */
export async function readModIdentity(path: string): Promise<ModIdentity> {
  const fs = await openFileSystem(path)
  try {
    for (const [file, loader] of [['neoforge.mods.toml', 'neoforge'], ['mods.toml', 'forge']] as const) {
      if (await fs.existsFile(`META-INF/${file}`)) {
        const mods = await readForgeModToml(fs, undefined, file)
        const ids = mods.map((m) => m.modid).filter((id): id is string => typeof id === 'string' && id.length > 0)
        if (ids.length) {
          const version = mods[0]?.version
          return { modIds: [...new Set(ids)], loader, version: version && !version.includes('${') ? version : undefined }
        }
      }
    }
    if (await fs.existsFile('fabric.mod.json')) {
      const meta = await readFabricMod(fs)
      if (meta?.id) return { modIds: [meta.id], loader: 'fabric', version: meta.version }
    }
    if (await fs.existsFile('quilt.mod.json')) {
      const meta = await readQuiltMod(fs)
      const id = meta?.quilt_loader?.id
      if (id) return { modIds: [id], loader: 'quilt', version: meta.quilt_loader.version }
    }
    return { modIds: [], loader: 'unknown' }
  } finally {
    fs.close()
  }
}

/**
 * Mod identities by file SHA-256. A pack has hundreds of mods, so the
 * results are kept on disk between launcher runs.
 */
export class ModIdentityCache {
  #entries = new Map<string, ModIdentity>()
  #loaded = false
  #dirty = false

  constructor(private readonly file?: string) {}

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    if (!this.file) return
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, ModIdentity>
      for (const [sha256, identity] of Object.entries(raw)) {
        if (/^[0-9a-f]{64}$/.test(sha256) && Array.isArray(identity?.modIds)) this.#entries.set(sha256, identity)
      }
    } catch { /* start empty */ }
  }

  async get(path: string, sha256: string): Promise<ModIdentity> {
    await this.#load()
    const cached = this.#entries.get(sha256)
    if (cached) return cached
    const identity = await readModIdentity(path).catch((): ModIdentity => ({ modIds: [], loader: 'unknown' }))
    this.#entries.set(sha256, identity)
    this.#dirty = true
    return identity
  }

  async save() {
    if (!this.file || !this.#dirty) return
    this.#dirty = false
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(Object.fromEntries(this.#entries)))
  }
}

export interface PlannedLocalMod {
  /** The local build to install. */
  source: string
  /** File name it gets in mods/. */
  file: string
  sha256: string
  identity: ModIdentity
  /** Instance mod files it replaces (same mod ID). Empty when it is added. */
  replaces: string[]
}

export interface LocalModPlan {
  mods: PlannedLocalMod[]
  /** Mod IDs declared by more than one file in the result that do not involve a local build. */
  existingDuplicates: Array<{ modId: string; files: string[] }>
}

export interface LocalModRequest {
  source: string
  sha256: string
  identity: ModIdentity
  /** Allow adding it when no instance mod has the same ID. */
  add: boolean
  /** When given, the build must declare this mod ID. */
  modId?: string
}

function planError(name: string, message: string) {
  return Object.assign(new Error(message), { name })
}

/**
 * Decide which instance mods each local build replaces, by mod ID rather
 * than file name, so a renamed build still replaces the right mod. Fails
 * when a build has no mod ID, matches nothing without `add`, collides with
 * an unrelated file name, or would leave two files claiming one mod ID.
 */
export function planLocalMods(instanceMods: ReadonlyMap<string, ModIdentity>, requests: LocalModRequest[]): LocalModPlan {
  const byId = new Map<string, string[]>()
  for (const [file, identity] of instanceMods) {
    for (const id of identity.modIds) byId.set(id, [...(byId.get(id) ?? []), file])
  }

  const mods: PlannedLocalMod[] = []
  const replaced = new Set<string>()
  const localNames = new Set<string>()
  for (const request of requests) {
    const file = request.source.split(/[\\/]/).pop()!
    const ids = request.identity.modIds
    if (!ids.length) {
      throw planError('NoModId', `${request.source} does not declare a mod ID (no neoforge.mods.toml, mods.toml, fabric.mod.json or quilt.mod.json)`)
    }
    if (request.modId && !ids.includes(request.modId)) {
      throw planError('ModIdMismatch', `${request.source} declares ${ids.join(', ')}, not ${request.modId}`)
    }
    const replaces = [...new Set(ids.flatMap((id) => byId.get(id) ?? []))].sort()
    if (!replaces.length && !request.add) {
      throw planError('ModNotInInstance', `No mod in the instance has the ID ${ids.join(' or ')} from ${file}. Mark it as an added mod to install it anyway.`)
    }
    if (localNames.has(file)) {
      throw planError('DuplicateModId', `Two local builds are named ${file}`)
    }
    localNames.add(file)
    for (const r of replaces) replaced.add(r)
    mods.push({ source: request.source, file, sha256: request.sha256, identity: request.identity, replaces })
  }

  // The resulting mods/ folder: instance mods that stay, plus the local builds.
  const result = new Map<string, string[]>()
  for (const [file, identity] of instanceMods) {
    if (!replaced.has(file)) result.set(file, identity.modIds)
  }
  for (const mod of mods) {
    if (result.has(mod.file)) {
      throw planError('FileNameCollision', `${mod.file} would overwrite an instance mod with different mod IDs (${result.get(mod.file)!.join(', ') || 'none'})`)
    }
    result.set(mod.file, mod.identity.modIds)
  }

  const owners = new Map<string, string[]>()
  for (const [file, ids] of result) {
    for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), file])
  }
  const existingDuplicates: LocalModPlan['existingDuplicates'] = []
  for (const [modId, files] of owners) {
    if (files.length < 2) continue
    if (files.some((f) => localNames.has(f))) {
      throw planError('DuplicateModId', `Mod ID ${modId} would be declared by ${files.sort().join(' and ')}`)
    }
    existingDuplicates.push({ modId, files: files.sort() })
  }
  return { mods, existingDuplicates }
}
