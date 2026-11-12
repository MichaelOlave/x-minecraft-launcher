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

/** A locally built mod to test in the disposable instance. */
export interface LocalModInput {
  /**
   * The built mod file. Its file name may contain `*` for a versioned build
   * (`build/libs/pockets-*.jar`); it must then match exactly one file,
   * not counting `-sources` and `-javadoc` jars.
   */
  path: string
  /**
   * Install it even when no mod in the instance has its mod ID. Without
   * this, a build whose ID matches nothing is an error, to catch typos.
   */
  add?: boolean
  /** The build must declare this mod ID. */
  modId?: string
  /** Expected SHA-256 of the file. */
  sha256?: string
  /** Expected SHA-512 of the file. */
  sha512?: string
}

/** A local build installed in the disposable instance, and what it replaced. */
export interface LocalModChange {
  action: 'replaced' | 'added'
  /** File name in mods/. */
  file: string
  /** Where the build came from. */
  source: string
  sha256: string
  modIds: string[]
  version?: string
  replaced: Array<{ file: string; sha256: string; modIds: string[]; version?: string }>
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
  /**
   * Local builds to install, matched to instance mods by mod ID. Builds
   * installed by an earlier stage are removed first and the pack's own
   * files restored, so a stage always yields the lock plus these builds.
   */
  mods?: LocalModInput[]
  /** Check and plan everything, but change nothing. */
  dryRun?: boolean
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
  /** Local builds installed (or, in a dry run, that would be). */
  localMods: LocalModChange[]
  /** Problems that did not stop the stage, such as duplicate mod IDs already in the pack. */
  warnings: string[]
  /** Nothing was changed. */
  dryRun: boolean
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
