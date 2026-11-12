import { ServiceKey } from './Service'

/** The pack's own lock file, used to check the working instance before copying it. */
export interface PackLockSource {
  /**
   * A lock file whose `artifacts` list each mod's `file`, `sha256` and
   * `active` flag, such as a pack repository's `pack-lock.json`.
   */
  file: string
  /**
   * Mod files that are newer than the lock but expected in the working
   * instance. Each is matched by file name and checked against this copy.
   */
  extra?: string[]
}

/** Files from outside the instance, applied on every stage. */
export interface DevOverlay {
  /** A file or folder to copy, usually in the pack repository. */
  from: string
  /** Where it goes, relative to the instance folder. */
  to: string
  /** `merge` (default) writes over existing files; `replace` empties the destination first. */
  mode?: 'merge' | 'replace'
}

/** A saved world to copy into the instance. */
export interface DevWorldFixture {
  /** The world folder to copy. It must contain `level.dat`. */
  from: string
  /** Folder name under `saves`. Defaults to the source folder's name. */
  name?: string
  /** Copy a fresh world on every stage (the default), or keep the one already there. */
  reset?: boolean
}

export interface StageDevInstanceOptions {
  /** The working instance to copy, by path or name. It is only read. */
  source: string
  /** Name of the disposable instance. It is created on first use. */
  name: string
  /** Verify the working instance's mods against this lock before copying. */
  lock?: PackLockSource
  /** Mod file names (`*` and `?` wildcards) in the working instance to leave out. */
  exclude?: string[]
  /**
   * Files and folders copied from the working instance only when missing in
   * the disposable one, so settings changed while testing survive a restage.
   * Defaults to `config`, `defaultconfigs`, `kubejs`, `resourcepacks`,
   * `datapacks`, `shaderpacks` and `options.txt`.
   */
  copyOnce?: string[]
  /** Copy the `copyOnce` entries again even if they exist. */
  fresh?: boolean
  overlays?: DevOverlay[]
  world?: DevWorldFixture
  /** Folder that relative paths in these options are resolved against. */
  cwd?: string
}

/** A file written or removed in the disposable instance. */
export interface DevFileChange {
  /** Path relative to the instance folder, with `/` separators. */
  path: string
  action: 'added' | 'changed' | 'removed'
  sha256?: string
  previousSha256?: string
}

export interface StageDevInstanceResult {
  instancePath: string
  name: string
  /** Whether the instance was created by this stage. */
  created: boolean
  sourcePath: string
  /** Present when the working instance was verified against a lock. */
  lock?: { file: string; mods: number; extra: string[] }
  mods: {
    /** Mod files now staged from the working instance. */
    total: number
    /** How many were copied this time (unchanged ones are kept). */
    copied: number
    removed: string[]
    excluded: string[]
  }
  /** `copyOnce` entries copied this time. */
  copied: string[]
  overlays: DevFileChange[]
  world?: { name: string; path: string; copied: boolean }
  durationMs: number
}

export interface DevTestServiceEventMap {
  /** Progress of a long step, keyed by the disposable instance's name. */
  'dev-progress': { name: string; task: string; progress: number; total?: number; message?: string }
}

/**
 * Developer tooling for pack authors: disposable test instances, local mod
 * builds and named test runs. See VARDRYNN_DEV_TESTING.md.
 */
export interface DevTestService {
  /**
   * Create or refresh a disposable instance from a working one. Mod files
   * are copy-on-write clones where the file system supports it, so they
   * share disk space with the working instance but never its writes.
   */
  stageDevInstance(options: StageDevInstanceOptions): Promise<StageDevInstanceResult>
}

export const DevTestServiceKey: ServiceKey<DevTestService> = 'DevTestService'
