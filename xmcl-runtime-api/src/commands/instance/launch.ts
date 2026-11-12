import { z } from 'zod'
import { AuthlibInjectorServiceKey } from '../../services/AuthlibInjectorService'
import { BaseServiceKey } from '../../services/BaseService'
import { VersionInstallServiceKey } from '../../services/InstallService'
import { InstanceServiceKey } from '../../services/InstanceService'
import { JavaServiceKey } from '../../services/JavaService'
import { LaunchServiceKey } from '../../services/LaunchService'
import { UserServiceKey } from '../../services/UserService'
import { VersionServiceKey } from '../../services/VersionService'
import { findMatchedVersion } from '../../entities/version'
import { generateLaunchOptionsWithGlobal } from '../../util/launch'
import { getAutoOrManuallJava, getAutoSelectedJava } from '../../util/java'
import { defineCommand } from '../registry'
import { CliExitCode, CommandExitError } from '../exitCodes'
import type { CommandContext } from '../types'
import type { LaunchOptions } from '../../services/LaunchService'

function createOperationId() {
  const crypto = globalThis.crypto as Crypto | undefined
  if (crypto?.randomUUID) {
    return crypto.randomUUID()
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Input schema for `instance.launch`. Mirrors the surface that both the
 * CLI direct-launch and the renderer launch composable need today.
 *
 * `modCount` is intentionally part of the input rather than computed inside
 * the handler: counting mod files requires file-system access, which would
 * pull a non-portable dependency into the otherwise pure command. Hosts
 * (backend / renderer) already have this number on hand and pass it in.
 */
export const LaunchInstanceInputSchema = z.object({
  /** Instance path or display name. Resolved by `ctx.resolveInstance`. */
  instance: z.string().min(1),
  /** User id or username. If omitted, falls back to `ctx.resolveUser()`. */
  user: z.string().optional(),
  /** Optional override for the side. Defaults to `'client'`. */
  side: z.enum(['client', 'server']).default('client'),
  /** Address of a server to auto-join after launch (client only). */
  server: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  /** Number of mods present in the instance. Used by auto-memory assignment. */
  modCount: z.number().int().nonnegative().default(0),
  /** Skip launching, just produce the resolved options (debugging). */
  dry: z.boolean().default(false),
  /** Operation id for telemetry/log correlation. Defaults to a fresh uuid. */
  operationId: z.string().optional(),
  /**
   * Open this singleplayer world (a folder name under `saves`) on start.
   * Applies to this launch only; the instance settings are not changed.
   */
  world: z.string().min(1).optional(),
  /** Extra JVM options for this launch, appended after the instance's own. */
  vmOption: z.array(z.string().min(1)).default([]),
  /**
   * Use only `vmOption` for this launch, dropping the instance's and the
   * global JVM options (for example a garbage collector choice).
   */
  replaceVmOptions: z.boolean().default(false),
  /** Extra Minecraft arguments for this launch, appended after the instance's own. */
  mcOption: z.array(z.string().min(1)).default([]),
  /** Extra environment variables for this launch, as `NAME=value`. */
  env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=/, 'Expected NAME=value')).default([]),
  /** Minimum heap in MB for this launch. */
  minMemory: z.number().int().positive().optional(),
  /** Maximum heap in MB for this launch. */
  maxMemory: z.number().int().positive().optional(),
  /** Window size for this launch, as `WIDTHxHEIGHT`. */
  resolution: z.string().regex(/^\d+x\d+$/, 'Expected WIDTHxHEIGHT').optional(),
  /**
   * Stay until Minecraft exits, reporting when the process starts, when the
   * game window is ready and how it exited. The exit status then reflects the
   * game: 12 if it never became ready, 14 if it crashed or exited non-zero.
   */
  wait: z.boolean().default(false),
  /** With `wait`, seconds to wait for the game window before giving up. */
  readyTimeout: z.number().positive().optional(),
  /** With `wait`, stop Minecraft if the command is cancelled or the window never appears. */
  stopOnCancel: z.boolean().default(false),
})

export type LaunchInstanceInput = z.infer<typeof LaunchInstanceInputSchema>

/**
 * Result of `instance.launch`. The number is the spawned process id, or
 * `undefined` when `dry` is set or the launch was a no-op.
 */
export type LaunchInstanceResult = number | undefined | LaunchWaitResult

/** Result of `instance.launch` with `wait`. */
export interface LaunchWaitResult {
  pid: number
  launchId: string
  startedAt: number
  /** When the game window became ready, if it did. */
  readyAt?: number
  endedAt: number
  exitCode?: number
  signal?: string
  crashed: boolean
  crashReportLocation?: string
}

/**
 * Hybrid launch command. Produced launch options are computed via
 * `generateLaunchOptionsWithGlobal` so backend and renderer stay in lockstep.
 *
 * The handler does NOT touch the file system — every side effect goes
 * through the {@link CommandContext}.
 */
export const launchInstanceCommand = defineCommand({
  id: 'instance.launch',
  title: 'Launch Instance',
  description: 'Launch a Minecraft instance with the selected user.',
  category: 'instance',
  input: LaunchInstanceInputSchema,
  cli: {
    name: 'launch',
    positionals: ['instance'],
    flags: {
      user: { alias: 'u', description: 'User id or username' },
      side: { description: 'Launch side (client | server)' },
      dry: { type: 'boolean', description: 'Resolve options without launching' },
      modCount: { type: 'number', description: 'Override mod count for auto-memory assignment' },
      world: { description: 'Open this singleplayer world on start' },
      vmOption: { multiple: true, description: 'Extra JVM option for this launch' },
      replaceVmOptions: { type: 'boolean', description: 'Use only the --vm-option values, not the instance\'s JVM options' },
      mcOption: { multiple: true, description: 'Extra Minecraft argument for this launch' },
      env: { multiple: true, description: 'Extra environment variable NAME=value' },
      minMemory: { type: 'number', description: 'Minimum heap in MB' },
      maxMemory: { type: 'number', description: 'Maximum heap in MB' },
      resolution: { description: 'Window size WIDTHxHEIGHT' },
      wait: { type: 'boolean', description: 'Wait for Minecraft to exit and report its status' },
      readyTimeout: { type: 'number', description: 'Seconds to wait for the game window (with --wait)' },
      stopOnCancel: { type: 'boolean', description: 'Stop Minecraft on Ctrl+C or ready timeout (with --wait)' },
    },
  },
  ui: {
    icon: 'play_arrow',
  },
  async handler(input, ctx): Promise<LaunchInstanceResult> {
    const operationId = input.operationId ?? createOperationId()

    let instance = await ctx.resolveInstance(input.instance)
    const user = await ctx.resolveUser(input.user)

    let versionId: string
    if (input.dry) {
      const localVersions = await ctx.call(VersionServiceKey, 'getLocalVersions')
      const versionHeader = findMatchedVersion(
        localVersions.local,
        instance.version,
        { ...instance.runtime },
      )
      if (!versionHeader) {
        throw new Error(`No local version matches instance '${instance.path}'`)
      }
      versionId = versionHeader.id
    } else {
      const requestedVersion = instance.version
      const requestedRuntime = { ...instance.runtime }
      const installed = await ctx.call(VersionInstallServiceKey, 'installInstance', {
        type: 'instance',
        instancePath: instance.path,
        runtime: requestedRuntime,
        selectedVersion: requestedVersion,
      })
      versionId = installed.version

      const latest = await ctx.resolveInstance(instance.path)
      const runtimeUnchanged = Object.entries(requestedRuntime).every(
        ([key, value]) => latest.runtime[key as keyof typeof latest.runtime] === value,
      )
      if (latest.version !== requestedVersion || !runtimeUnchanged) {
        throw new Error(`Instance '${instance.path}' changed while preparing launch`)
      }
      if (latest.version !== versionId) {
        await ctx.call(InstanceServiceKey, 'editInstance', {
          instancePath: latest.path,
          version: versionId,
        })
      }
      instance = { ...latest, version: versionId }
    }
    const resolvedVersion = await ctx.call(VersionServiceKey, 'resolveLocalVersion', versionId)
    const refreshedUser = await ctx.call(UserServiceKey, 'refreshUser', user.id)

    // Pull global settings (resolved once, read-only).
    const settings = await ctx.call(BaseServiceKey, 'getSettings')

    // Resolve Java — auto-select then optionally override with the instance's pinned path.
    const javaState = await ctx.call(JavaServiceKey, 'getJavaState')
    const detected = getAutoSelectedJava(
      javaState.all,
      instance.runtime.minecraft,
      instance.runtime.forge,
      resolvedVersion,
      settings.globalJava,
    )
    const javaResult = await getAutoOrManuallJava(
      detected,
      (path) => ctx.call(JavaServiceKey, 'resolveJava', path),
      instance.java,
    )
    // Prefer the user-pinned Java only when it actually resolves. Otherwise
    // fall back to the auto-detected one — otherwise a stale pin (deleted /
    // moved JDK) would crash spawn with ENOENT instead of launching cleanly.
    const java = (javaResult.java?.valid ? javaResult.java : undefined) || javaResult.auto.java

    // Build the side-specific overrides.
    const overrides = input.server
      ? { server: { host: input.server.host, port: input.server.port } }
      : undefined

    const launchOptions = await generateLaunchOptionsWithGlobal(
      instance,
      refreshedUser,
      versionId,
      {
        token: '',
        operationId,
        side: input.side,
        overrides,
        dry: input.dry,
        javaPath: java?.path,
        globalEnv: settings.globalEnv,
        globalVmOptions: settings.globalVmOptions,
        globalMcOptions: settings.globalMcOptions,
        globalPrependCommand: settings.globalPrependCommand,
        globalAssignMemory: settings.globalAssignMemory,
        globalMinMemory: settings.globalMinMemory,
        globalMaxMemory: settings.globalMaxMemory,
        globalHideLauncher: settings.globalHideLauncher,
        globalShowLog: settings.globalShowLog,
        globalFastLaunch: settings.globalFastLaunch,
        globalDisableAuthlibInjector: settings.globalDisableAuthlibInjector,
        globalDisableElyByAuthlib: settings.globalDisableElyByAuthlib,
        globalPreExecuteCommand: settings.globalPreExecuteCommand,
        globalResolution: undefined,
        modCount: input.modCount,
        track: async (_, operation) => operation(),
        getOrInstallAuthlibInjector: () =>
          ctx.call(AuthlibInjectorServiceKey, 'getOrInstallAuthlibInjector'),
      },
    )

    applyRunOverrides(launchOptions, input)

    if (input.dry) {
      ctx.out.json({ ok: true, command: 'instance.launch', data: { dry: true, options: launchOptions } })
      return undefined
    }

    if (input.wait) {
      const result = await launchAndWait(ctx, launchOptions, operationId, input)
      ctx.out.json({ ok: true, command: 'instance.launch', data: result })
      return result
    }

    const pid = await ctx.call(LaunchServiceKey, 'launch', launchOptions)
    const launchId = pid === undefined
      ? undefined
      : await Promise.resolve().then(() => ctx.call(LaunchServiceKey, 'getGameProcess', pid)).then((p) => p?.launchId, () => undefined)
    ctx.out.json({ ok: true, command: 'instance.launch', data: { pid, launchId } })
    return pid
  },
})

/**
 * Apply the per-launch settings on top of the instance's resolved options.
 * Nothing here is written back to the instance.
 */
export function applyRunOverrides(options: LaunchOptions, input: Pick<LaunchInstanceInput, 'world' | 'vmOption' | 'replaceVmOptions' | 'mcOption' | 'env' | 'minMemory' | 'maxMemory' | 'resolution'>) {
  if (input.world) options.world = input.world
  if (input.replaceVmOptions) options.vmOptions = [...input.vmOption]
  else if (input.vmOption.length) options.vmOptions = [...(options.vmOptions ?? []), ...input.vmOption]
  if (input.mcOption.length) options.mcOptions = [...(options.mcOptions ?? []), ...input.mcOption]
  if (input.env.length) {
    const env = { ...options.env }
    for (const entry of input.env) {
      const index = entry.indexOf('=')
      env[entry.slice(0, index)] = entry.slice(index + 1)
    }
    options.env = env
  }
  if (input.minMemory !== undefined) options.minMemory = input.minMemory
  if (input.maxMemory !== undefined) options.maxMemory = input.maxMemory
  if (input.minMemory !== undefined && input.maxMemory !== undefined && input.minMemory > input.maxMemory) {
    throw new Error(`Minimum memory ${input.minMemory} MB is above the maximum ${input.maxMemory} MB`)
  }
  if (input.resolution) {
    const [width, height] = input.resolution.split('x').map(Number)
    options.resolution = { ...options.resolution, width, height }
  }
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * Launch, then follow that one game process until it exits. Progress is
 * reported as `started`, `ready` and `exited` events (and log lines), so a
 * terminal script can act on readiness while this command keeps waiting.
 */
async function launchAndWait(ctx: CommandContext, options: LaunchOptions, operationId: string, input: LaunchInstanceInput): Promise<LaunchWaitResult> {
  if (!ctx.subscribe) {
    throw new CommandExitError(CliExitCode.Usage, 'WaitUnsupported', 'This launcher cannot follow a launch to its exit')
  }
  options.operationId = operationId

  let launchId: string | undefined
  let pid: number | undefined
  let startedAt = Date.now()
  let readyAt: number | undefined
  let onReady!: () => void
  const ready = new Promise<void>((resolve) => { onReady = resolve })
  let onExit!: (e: { code?: number; signal?: string; crashReport?: string; crashReportLocation?: string }) => void
  const exited = new Promise<{ code?: number; signal?: string; crashReport?: string; crashReportLocation?: string }>((resolve) => { onExit = resolve })

  const stops = await Promise.all([
    ctx.subscribe(LaunchServiceKey, 'minecraft-start', (e: { operationId?: string; launchId: string; pid: number; startTime?: number }) => {
      if (e.operationId !== operationId || launchId) return
      launchId = e.launchId
      pid = e.pid
      startedAt = e.startTime ?? Date.now()
      ctx.out.event?.('started', { pid, launchId, instance: options.gameDirectory, startedAt })
      ctx.out.log(`Minecraft started (pid ${pid}, launch ${launchId})`)
    }),
    ctx.subscribe(LaunchServiceKey, 'minecraft-window-ready', (e: { launchId: string }) => {
      if (!launchId || e.launchId !== launchId || readyAt) return
      readyAt = Date.now()
      ctx.out.event?.('ready', { pid, launchId, readyAt, startupMs: readyAt - startedAt })
      ctx.out.log(`Minecraft window is ready after ${formatSeconds(readyAt - startedAt)}`)
      onReady()
    }),
    ctx.subscribe(LaunchServiceKey, 'minecraft-exit', (e: { launchId?: string; operationId?: string; code?: number; signal?: string; crashReport?: string; crashReportLocation?: string }) => {
      if (e.operationId !== operationId && (!launchId || e.launchId !== launchId)) return
      onExit(e)
    }),
  ])

  const stop = async () => {
    if (input.stopOnCancel && pid !== undefined) {
      await ctx.call(LaunchServiceKey, 'kill', pid, false).catch(() => undefined)
    }
  }

  let cancelled!: () => void
  const cancellation = new Promise<'cancelled'>((resolve) => { cancelled = () => resolve('cancelled') })
  if (ctx.signal.aborted) cancelled()
  ctx.signal.addEventListener('abort', cancelled, { once: true })

  try {
    try {
      pid = await ctx.call(LaunchServiceKey, 'launch', options)
    } catch (e) {
      throw new CommandExitError(CliExitCode.StartFailed, 'StartFailed', `Minecraft did not start: ${(e as Error)?.message ?? e}`)
    }
    if (pid === undefined) {
      throw new CommandExitError(CliExitCode.StartFailed, 'StartFailed', 'Minecraft did not start')
    }
    if (!launchId) {
      // The start event is emitted before launch() returns; this only covers hosts that emit it late.
      launchId = (await ctx.call(LaunchServiceKey, 'getGameProcess', pid))?.launchId
    }

    const timeout = input.readyTimeout
    let timer: ReturnType<typeof setTimeout> | undefined
    const readyOutcome = await Promise.race([
      ready.then(() => 'ready' as const),
      exited.then(() => 'exited' as const),
      cancellation,
      ...(timeout ? [new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeout * 1000) })] : []),
    ]).finally(() => clearTimeout(timer))
    if (readyOutcome === 'cancelled') {
      await stop()
      throw new CommandExitError(CliExitCode.Cancelled, 'Cancelled', input.stopOnCancel ? 'Cancelled; Minecraft was stopped' : 'Cancelled; Minecraft keeps running')
    }
    if (readyOutcome === 'timeout') {
      ctx.out.event?.('not-ready', { pid, launchId, timeoutSeconds: timeout })
      await stop()
      throw new CommandExitError(CliExitCode.NotReady, 'NotReady', `Minecraft did not open its window within ${timeout} s${input.stopOnCancel ? '; it was stopped' : ''}`, { pid, launchId })
    }

    const exitOutcome = await Promise.race([exited, cancellation])
    if (exitOutcome === 'cancelled') {
      await stop()
      throw new CommandExitError(CliExitCode.Cancelled, 'Cancelled', input.stopOnCancel ? 'Cancelled; Minecraft was stopped' : 'Cancelled; Minecraft keeps running')
    }
    const endedAt = Date.now()
    const crashed = exitOutcome.code !== 0 || !!exitOutcome.crashReport || !!exitOutcome.crashReportLocation
    const result: LaunchWaitResult = {
      pid,
      launchId: launchId ?? '',
      startedAt,
      readyAt,
      endedAt,
      exitCode: exitOutcome.code,
      signal: exitOutcome.signal ?? undefined,
      crashed,
      crashReportLocation: exitOutcome.crashReportLocation || undefined,
    }
    ctx.out.event?.('exited', result)
    if (crashed) {
      const why = exitOutcome.crashReportLocation
        ? `crashed (report: ${exitOutcome.crashReportLocation})`
        : `exited with status ${exitOutcome.code ?? exitOutcome.signal}`
      throw new CommandExitError(CliExitCode.UncleanExit, readyAt ? 'UncleanExit' : 'ExitedBeforeReady', `Minecraft ${why}`, result)
    }
    ctx.out.log(`Minecraft exited cleanly after ${formatSeconds(endedAt - startedAt)}`)
    return result
  } finally {
    ctx.signal.removeEventListener('abort', cancelled)
    for (const unsubscribe of stops) unsubscribe()
  }
}
