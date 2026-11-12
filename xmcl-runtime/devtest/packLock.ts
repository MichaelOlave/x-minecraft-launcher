import { readFile } from 'fs/promises'
import { basename } from 'path'
import { hashFile } from './fileHash'

export interface LockedMods {
  /** Mod file name → SHA-256. */
  files: Map<string, string>
  /** Names that came from the lock's extra files rather than the lock itself. */
  extra: string[]
}

/**
 * Read the active mods of a pack lock. The format is the pack repository's
 * `pack-lock.json`: an `artifacts` array whose entries carry `file`,
 * `sha256` and `active`. Extra files newer than the lock are hashed from the
 * given copies.
 */
export async function readLockedMods(lockFile: string, extraFiles: string[] = []): Promise<LockedMods> {
  let lock: unknown
  try {
    lock = JSON.parse(await readFile(lockFile, 'utf8'))
  } catch (e) {
    throw Object.assign(new Error(`Cannot read the pack lock ${lockFile}: ${(e as Error).message}`), { name: 'LockUnreadable' })
  }
  const artifacts = (lock as { artifacts?: unknown })?.artifacts
  if (!Array.isArray(artifacts)) {
    throw Object.assign(new Error(`${lockFile} has no "artifacts" list`), { name: 'LockUnreadable' })
  }
  const files = new Map<string, string>()
  for (const artifact of artifacts as Array<Record<string, unknown>>) {
    if (artifact?.active !== true) continue
    const file = artifact.file
    const sha256 = artifact.sha256
    if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.jar')) continue
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw Object.assign(new Error(`${lockFile}: active artifact ${file} has no valid sha256`), { name: 'LockUnreadable' })
    }
    files.set(file, sha256.toLowerCase())
  }
  const extra: string[] = []
  for (const path of extraFiles) {
    const name = basename(path)
    if (files.has(name)) continue
    files.set(name, await hashFile(path).catch((e) => {
      throw Object.assign(new Error(`Cannot read extra lock file ${path}: ${(e as Error).message}`), { name: 'LockUnreadable' })
    }))
    extra.push(name)
  }
  return { files, extra }
}

export interface LockComparison {
  missing: string[]
  unexpected: string[]
  changed: string[]
}

/** Compare a folder's mod hashes against the lock. */
export function compareWithLock(locked: Map<string, string>, actual: Map<string, string>): LockComparison {
  const missing = [...locked.keys()].filter((name) => !actual.has(name)).sort()
  const unexpected = [...actual.keys()].filter((name) => !locked.has(name)).sort()
  const changed = [...actual.entries()].filter(([name, sha]) => locked.has(name) && locked.get(name) !== sha).map(([name]) => name).sort()
  return { missing, unexpected, changed }
}

export function describeLockComparison(comparison: LockComparison, limit = 10) {
  const part = (label: string, names: string[]) => names.length
    ? [`${label} (${names.length}): ${names.slice(0, limit).join(', ')}${names.length > limit ? ', …' : ''}`]
    : []
  return [
    ...part('missing from the working instance', comparison.missing),
    ...part('not in the lock', comparison.unexpected),
    ...part('different from the lock', comparison.changed),
  ].join('; ')
}
