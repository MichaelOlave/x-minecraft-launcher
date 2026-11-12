import type { Instance } from '@xmcl/instance'
import {
  DevTestServiceKey,
  InstanceNotFoundError,
  type BeginTestRunOptions,
  type DevTestService as IDevTestService,
  type StageDevInstanceOptions,
  type StageDevInstanceResult,
  type TestRunRecord,
} from '@xmcl/runtime-api'
import { readdir } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { Inject, LauncherAppKey, kGameDataPath, type PathResolver } from '~/app'
import { LauncherApp } from '~/app/LauncherApp'
import { InstanceService } from '~/instance'
import { LaunchService } from '~/launch'
import { LaunchHistoryStore } from '~/launch/LaunchHistoryStore'
import { AbstractService, ExposeServiceKey } from '~/service'
import { HashCache } from './fileHash'
import { applyLocalMods, describePlan, readInstanceIdentities, readLocalMods } from './localMods'
import { LocalModPlan, ModIdentity, ModIdentityCache, planLocalMods } from './modIds'
import { DEFAULT_COPY_ONCE, DevMarker, readMarker, stageError, stageFiles, verifySource, writeMarker } from './stage'
import { TestRunStore } from './testRuns'

type RunUpdate = Partial<Omit<TestRunRecord, 'runId' | 'runDir' | 'createdAt'>>

/** Instance settings a disposable copy inherits so it launches like the working instance. */
const INHERITED_SETTINGS = ['version', 'java', 'assignMemory', 'minMemory', 'maxMemory', 'vmOptions', 'mcOptions', 'env', 'resolution', 'prependCommand', 'preExecuteCommand'] as const

@ExposeServiceKey(DevTestServiceKey)
export class DevTestService extends AbstractService implements IDevTestService {
  readonly #hashes = new HashCache()
  readonly #identities: ModIdentityCache
  readonly #runs: TestRunStore
  readonly #launchHistory: LaunchHistoryStore

  constructor(
    @Inject(LauncherAppKey) app: LauncherApp,
    @Inject(InstanceService) private instanceService: InstanceService,
    @Inject(LaunchService) private launchService: LaunchService,
    @Inject(kGameDataPath) private getPath: PathResolver,
  ) {
    super(app)
    this.#identities = new ModIdentityCache(this.getAppDataPath('dev-cache', 'mod-ids.json'))
    this.#runs = new TestRunStore(this.getAppDataPath('test-runs'))
    this.#launchHistory = new LaunchHistoryStore(this.getAppDataPath('launch-history'))
  }

  beginTestRun(options: BeginTestRunOptions): Promise<TestRunRecord> {
    return this.#runs.begin({ ...options, launcherVersion: this.app.version })
  }

  recordTestRun(runId: string, update: RunUpdate): Promise<TestRunRecord> {
    return this.#runs.update(runId, update)
  }

  async finishTestRun(runId: string, update: RunUpdate): Promise<TestRunRecord> {
    const record = await this.#runs.update(runId, { ...update, endedAt: update.endedAt ?? Date.now() })
    this.log(`Test run ${runId} finished: ${record.outcome}`)
    return record
  }

  getTestRun(runId: string) {
    return this.#runs.get(runId)
  }

  listTestRuns(limit?: number) {
    return this.#runs.list(limit)
  }

  async getLaunchRecordPath(instancePath: string, launchId: string) {
    return this.#launchHistory.getRecordPath(instancePath, launchId)
  }

  /** Find an instance by path (absolute or relative to `cwd`) or by name. */
  async resolveInstance(ref: string, cwd = process.cwd()): Promise<Instance | undefined> {
    const state = await this.instanceService.getSharedInstancesState()
    return state.all[resolve(cwd, ref)] ?? state.instances.find((i) => i.name === ref)
  }

  async assertNotRunning(instancePath: string) {
    const running = (await this.launchService.getGameProcesses()).find((p) => resolve(p.options.gameDirectory) === resolve(instancePath))
    if (running) {
      throw stageError('InstanceRunning', `Minecraft is running in ${instancePath} (pid ${running.pid}). Close it before staging.`)
    }
  }

  async stageDevInstance(options: StageDevInstanceOptions): Promise<StageDevInstanceResult> {
    const startedAt = Date.now()
    const cwd = options.cwd ?? process.cwd()
    const at = (path: string) => resolve(cwd, path)
    const source = await this.resolveInstance(options.source, cwd)
    if (!source) throw new InstanceNotFoundError(options.source)

    let target = await this.resolveInstance(options.name, cwd)
    if (target && target.path === source.path) {
      throw stageError('UnsafeStage', 'The disposable instance must be separate from the working instance')
    }
    if (target && !(await readMarker(target.path))) {
      throw stageError('NotDisposable', `The instance "${target.name}" was not created by a Vardrynn stage, so it will not be overwritten. Choose another name.`)
    }

    const input = {
      sourcePath: source.path,
      // A new instance's folder is only known once it is created; verify against a placeholder.
      targetPath: target?.path ?? resolve(source.path, '..', `.${basename(source.path)}-stage-check`),
      lock: options.lock ? { file: at(options.lock.file), extra: (options.lock.extra ?? []).map(at) } : undefined,
      exclude: options.exclude ?? [],
      copyOnce: options.copyOnce ?? DEFAULT_COPY_ONCE,
      fresh: options.fresh ?? false,
      overlays: (options.overlays ?? []).map((o) => ({ from: at(o.from), to: o.to, mode: o.mode ?? 'merge' as const })),
      world: options.world
        ? { from: at(options.world.from), name: options.world.name ?? basename(at(options.world.from)), reset: options.world.reset ?? true }
        : undefined,
      hashes: this.#hashes,
      progress: (task: string, progress: number, total?: number, message?: string) => {
        this.emit('dev-progress', { name: options.name, task, progress, total, message })
      },
    }
    const verified = await verifySource(input)

    // Plan local builds against the mods this stage will put in place, before changing anything.
    let plan: LocalModPlan | undefined
    let identities = new Map<string, ModIdentity>()
    const baseFiles = new Map([...verified.mods].map(([file, sha256]) => [file, { path: join(source.path, 'mods', file), sha256 }]))
    if (options.mods?.length) {
      const requests = await readLocalMods(options.mods.map((m) => ({ ...m, path: at(m.path) })), this.#hashes, this.#identities)
      identities = await readInstanceIdentities(baseFiles, this.#identities, (done, total) => {
        input.progress('mod-ids', done, total, done === total ? 'Read mod IDs' : undefined)
      })
      await this.#identities.save().catch((e) => this.warn(e))
      plan = planLocalMods(identities, requests)
    }
    const localMods = plan ? describePlan(plan, baseFiles, identities) : []
    const warnings = (plan?.existingDuplicates ?? []).map((d) => `Mod ID ${d.modId} is declared by ${d.files.join(' and ')} (already so in the working instance)`)

    if (options.dryRun) {
      return {
        instancePath: target?.path ?? '',
        name: options.name,
        created: false,
        sourcePath: source.path,
        lock: verified.lock,
        mods: { total: verified.mods.size, copied: 0, removed: [], excluded: verified.excluded },
        copied: [],
        overlays: [],
        localMods,
        warnings,
        dryRun: true,
        durationMs: Date.now() - startedAt,
      }
    }

    let created = false
    let marker: DevMarker
    if (!target) {
      const settings: Record<string, unknown> = {}
      for (const key of INHERITED_SETTINGS) {
        if (source[key] !== undefined) settings[key] = JSON.parse(JSON.stringify(source[key]))
      }
      const path = await this.instanceService.createInstance({
        ...settings,
        name: options.name,
        runtime: { ...source.runtime },
        description: `Disposable test copy of ${source.name}`,
      })
      const leftovers = (await readdir(path).catch(() => [])).filter((f) => !['instance.json', 'resourcepacks', 'shaderpacks'].includes(f))
      if (leftovers.length) {
        throw stageError('NotDisposable', `The new instance folder ${path} already has files: ${leftovers.slice(0, 5).join(', ')}`)
      }
      marker = { version: 1, name: options.name, source: source.path, createdAt: Date.now(), mods: {} }
      await writeMarker(path, marker)
      target = (await this.resolveInstance(path))!
      created = true
    } else {
      await this.assertNotRunning(target.path)
      marker = (await readMarker(target.path))!
      const runtimeChanged = JSON.stringify(target.runtime) !== JSON.stringify(source.runtime)
      if (runtimeChanged || target.version !== source.version) {
        await this.instanceService.editInstance({ instancePath: target.path, runtime: { ...source.runtime }, version: source.version })
      }
    }

    const allowedLinks = new Map(['libraries', 'versions'].map((name) => [resolve(target!.path, name), this.getPath(name)]))
    const files = await stageFiles({ ...input, targetPath: target.path, allowedLinks }, verified, marker)
    if (plan) await applyLocalMods(target.path, marker, plan)
    marker.source = source.path
    marker.stagedAt = Date.now()
    await writeMarker(target.path, marker)
    this.log(`Staged ${target.path} from ${source.path}: ${files.mods.total} mods (${files.mods.copied} copied)`)

    return {
      instancePath: target.path,
      name: options.name,
      created,
      sourcePath: source.path,
      lock: verified.lock,
      ...files,
      localMods,
      warnings,
      dryRun: false,
      durationMs: Date.now() - startedAt,
    }
  }
}
