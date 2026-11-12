import { EventEmitter } from 'events'
import { describe, test, expect, vi } from 'vitest'
import { z } from 'zod'
import { applyRunOverrides, launchInstanceCommand, LaunchInstanceInputSchema } from './launch'
import type { CommandContext } from '../types'
import { AuthlibInjectorServiceKey } from '../../services/AuthlibInjectorService'
import { BaseServiceKey } from '../../services/BaseService'
import { VersionInstallServiceKey } from '../../services/InstallService'
import { InstanceServiceKey } from '../../services/InstanceService'
import { JavaServiceKey } from '../../services/JavaService'
import { LaunchServiceKey } from '../../services/LaunchService'
import { UserServiceKey } from '../../services/UserService'
import { VersionServiceKey } from '../../services/VersionService'

function makeInstance(overrides: Partial<any> = {}) {
  return {
    path: '/home/u/inst/foo',
    name: 'foo',
    runtime: { minecraft: '1.21.1', forge: '', fabricLoader: '', quiltLoader: '', neoForged: '', optifine: '', labyMod: '' },
    java: '',
    version: '',
    ...overrides,
  }
}

function makeUser(overrides: Partial<any> = {}) {
  return {
    id: 'u1',
    username: 'tester',
    authority: 'https://example.com',
    profiles: {},
    ...overrides,
  }
}

function makeSettings(overrides: Partial<any> = {}) {
  return {
    globalEnv: {},
    globalVmOptions: [],
    globalMcOptions: [],
    globalPrependCommand: '',
    globalAssignMemory: false,
    globalMinMemory: 0,
    globalMaxMemory: 0,
    globalHideLauncher: false,
    globalShowLog: false,
    globalFastLaunch: false,
    globalDisableAuthlibInjector: true, // skip authlib install in test
    globalDisableElyByAuthlib: false,
    globalPreExecuteCommand: '',
    ...overrides,
  }
}

function makeCtx(callImpl: (key: string, method: string, ...args: any[]) => any): CommandContext {
  const ctx: CommandContext = {
    mode: 'cli',
    signal: new AbortController().signal,
    call: vi.fn((key: any, method: any, ...args: any[]) => Promise.resolve(callImpl(String(key), String(method), ...args))) as any,
    state: vi.fn() as any,
    resolveInstance: vi.fn(async (ref: string) => makeInstance({ path: ref })) as any,
    resolveUser: vi.fn(async () => makeUser()) as any,
    pickInstance: vi.fn() as any,
    pickUser: vi.fn() as any,
    prompt: vi.fn() as any,
    confirm: vi.fn() as any,
    select: vi.fn() as any,
    task: ((_n: string, run: any) => run({ update: () => {}, child: () => ({} as any) })) as any,
    out: { log: vi.fn(), json: vi.fn(), table: vi.fn() },
  }
  return ctx
}

describe('LaunchInstanceInputSchema', () => {
  test('accepts minimal input and applies defaults', () => {
    const parsed = LaunchInstanceInputSchema.parse({ instance: '/p/i' })
    expect(parsed).toEqual({
      instance: '/p/i',
      side: 'client',
      modCount: 0,
      dry: false,
      vmOption: [],
      mcOption: [],
      env: [],
      wait: false,
      stopOnCancel: false,
    })
  })

  test('validates server shape', () => {
    expect(() => LaunchInstanceInputSchema.parse({
      instance: '/p/i',
      server: { host: 'mc.example.com', port: 25565 },
    })).not.toThrow()
    expect(() => LaunchInstanceInputSchema.parse({
      instance: '/p/i',
      server: { host: '', port: 25565 },
    })).toThrow()
  })

  test('rejects empty instance ref', () => {
    expect(() => LaunchInstanceInputSchema.parse({ instance: '' })).toThrow()
  })
})

describe('launchInstanceCommand', () => {
  test('orchestrates services through ctx.call and returns the launch pid', async () => {
    const launchSpy = vi.fn(async () => 4242)
    const ctx = makeCtx((key, method) => {
      if (key === UserServiceKey && method === 'refreshUser') return makeUser()
      if (key === VersionInstallServiceKey && method === 'installInstance') return { version: 'v1' }
      if (key === InstanceServiceKey && method === 'editInstance') return undefined
      if (key === VersionServiceKey && method === 'resolveLocalVersion') return { id: 'v1', minecraftVersion: '1.21.1', libraries: [], pathChain: ['/v'] }
      if (key === JavaServiceKey && method === 'getJavaState') return { all: [{ path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }] }
      if (key === JavaServiceKey && method === 'resolveJava') return { path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }
      if (key === BaseServiceKey && method === 'getSettings') return makeSettings()
      if (key === AuthlibInjectorServiceKey && method === 'getOrInstallAuthlibInjector') return '/authlib.jar'
      if (key === LaunchServiceKey && method === 'launch') return launchSpy()
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })

    const pid = await launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo', user: 'u1', modCount: 5 }),
      ctx,
    )

    expect(pid).toBe(4242)
    expect(launchSpy).toHaveBeenCalledOnce()
    expect(ctx.resolveInstance).toHaveBeenCalledWith('/inst/foo')
    expect(ctx.resolveUser).toHaveBeenCalledWith('u1')
    expect(ctx.call).toHaveBeenCalledWith(VersionInstallServiceKey, 'installInstance', expect.objectContaining({
      type: 'instance',
      instancePath: '/inst/foo',
      selectedVersion: '',
    }))
    expect(ctx.call).toHaveBeenCalledWith(InstanceServiceKey, 'editInstance', {
      instancePath: '/inst/foo',
      version: 'v1',
    })
  })

  test('installs a missing version before launching', async () => {
    const installSpy = vi.fn(() => ({ version: 'installed-v1' }))
    let launchedVersion: string | undefined
    const ctx = makeCtx((key, method, options) => {
      if (key === UserServiceKey && method === 'refreshUser') return makeUser()
      if (key === VersionInstallServiceKey && method === 'installInstance') return installSpy()
      if (key === InstanceServiceKey && method === 'editInstance') return undefined
      if (key === VersionServiceKey && method === 'resolveLocalVersion') return { id: 'installed-v1', minecraftVersion: '1.21.1', libraries: [], pathChain: ['/v'] }
      if (key === JavaServiceKey && method === 'getJavaState') return { all: [{ path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }] }
      if (key === JavaServiceKey && method === 'resolveJava') return { path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }
      if (key === BaseServiceKey && method === 'getSettings') return makeSettings()
      if (key === LaunchServiceKey && method === 'launch') {
        launchedVersion = options.version
        return 4242
      }
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })

    await expect(launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo' }),
      ctx,
    )).resolves.toBe(4242)
    expect(installSpy).toHaveBeenCalledOnce()
    expect(launchedVersion).toBe('installed-v1')
  })

  test('dry mode still throws when no version matches the instance', async () => {
    const ctx = makeCtx((key, method) => {
      if (key === VersionServiceKey && method === 'getLocalVersions') return { local: [] }
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })

    await expect(launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo', dry: true }),
      ctx,
    )).rejects.toThrow(/No local version matches/)
  })

  test('does not launch when the instance changes during installation', async () => {
    const launchSpy = vi.fn()
    const ctx = makeCtx((key, method) => {
      if (key === VersionInstallServiceKey && method === 'installInstance') return { version: 'v1' }
      if (key === LaunchServiceKey && method === 'launch') return launchSpy()
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })
    ;(ctx.resolveInstance as any)
      .mockResolvedValueOnce(makeInstance({ path: '/inst/foo', version: 'old' }))
      .mockResolvedValueOnce(makeInstance({ path: '/inst/foo', version: 'changed' }))

    await expect(launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo' }),
      ctx,
    )).rejects.toThrow(/changed while preparing launch/)
    expect(launchSpy).not.toHaveBeenCalled()
  })

  test('falls back to auto-detected Java when the pinned instance.java path is gone', async () => {
    // Bug #1 regression: when the user has pinned a Java path that no longer
    // resolves (uninstalled / moved), launch must NOT spawn with that broken
    // path. It should silently use the auto-detected Java instead.
    let spawnedJava: string | undefined
    const ctx = makeCtx((key, method, _arg) => {
      if (key === UserServiceKey && method === 'refreshUser') return makeUser()
      if (key === VersionInstallServiceKey && method === 'installInstance') return { version: 'v1' }
      if (key === InstanceServiceKey && method === 'editInstance') return undefined
      if (key === VersionServiceKey && method === 'resolveLocalVersion') return { id: 'v1', minecraftVersion: '1.21.1', libraries: [], pathChain: ['/v'] }
      if (key === JavaServiceKey && method === 'getJavaState') {
        return { all: [{ path: '/usr/local/jdk-21/bin/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }] }
      }
      if (key === JavaServiceKey && method === 'resolveJava') {
        // Pinned path no longer exists on disk.
        return undefined
      }
      if (key === BaseServiceKey && method === 'getSettings') return makeSettings()
      if (key === LaunchServiceKey && method === 'launch') {
        spawnedJava = (_arg as any)?.java
        return 9999
      }
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })

    // Pin a deleted path.
    ;(ctx.resolveInstance as any).mockImplementation(async (ref: string) => makeInstance({
      path: ref,
      java: '/deleted/old-jdk/bin/java',
    }))

    const pid = await launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo' }),
      ctx,
    )

    expect(pid).toBe(9999)
    expect(spawnedJava).toBe('/usr/local/jdk-21/bin/java')
  })

  test('dry mode skips LaunchService.launch', async () => {
    const launchSpy = vi.fn()
    const ctx = makeCtx((key, method) => {
      if (key === UserServiceKey && method === 'refreshUser') return makeUser()
      if (key === VersionServiceKey && method === 'getLocalVersions') return { local: [{ id: 'v1', minecraft: '1.21.1' }] }
      if (key === VersionServiceKey && method === 'resolveLocalVersion') return { id: 'v1', minecraftVersion: '1.21.1', libraries: [], pathChain: ['/v'] }
      if (key === JavaServiceKey && method === 'getJavaState') return { all: [{ path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }] }
      if (key === JavaServiceKey && method === 'resolveJava') return { path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }
      if (key === BaseServiceKey && method === 'getSettings') return makeSettings()
      if (key === LaunchServiceKey && method === 'launch') { launchSpy(); return 0 }
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })

    const result = await launchInstanceCommand.handler(
      LaunchInstanceInputSchema.parse({ instance: '/inst/foo', dry: true }),
      ctx,
    )
    expect(result).toBeUndefined()
    expect(launchSpy).not.toHaveBeenCalled()
  })
})

describe('applyRunOverrides', () => {
  test('appends per-launch options without dropping the instance ones', () => {
    const options: any = { vmOptions: ['-Da=1'], mcOptions: ['--x'], env: { KEEP: '1' }, resolution: { fullscreen: false } }
    applyRunOverrides(options, LaunchInstanceInputSchema.parse({
      instance: '/i',
      world: 'Veil Development',
      vmOption: ['-Dveil.debug=true'],
      mcOption: ['--demo'],
      env: ['FOO=bar=baz'],
      minMemory: 512,
      maxMemory: 16384,
      resolution: '1280x720',
    }))
    expect(options).toEqual({
      world: 'Veil Development',
      vmOptions: ['-Da=1', '-Dveil.debug=true'],
      mcOptions: ['--x', '--demo'],
      env: { KEEP: '1', FOO: 'bar=baz' },
      minMemory: 512,
      maxMemory: 16384,
      resolution: { fullscreen: false, width: 1280, height: 720 },
    })
  })

  test('leaves options untouched when nothing is given', () => {
    const options: any = { vmOptions: ['-Da=1'] }
    applyRunOverrides(options, LaunchInstanceInputSchema.parse({ instance: '/i' }))
    expect(options).toEqual({ vmOptions: ['-Da=1'] })
  })

  test('rejects a minimum above the maximum', () => {
    expect(() => applyRunOverrides({} as any, LaunchInstanceInputSchema.parse({ instance: '/i', minMemory: 4096, maxMemory: 1024 })))
      .toThrow(/above the maximum/)
  })

  test('validates env and resolution shapes', () => {
    expect(() => LaunchInstanceInputSchema.parse({ instance: '/i', env: ['no-equals'] })).toThrow()
    expect(() => LaunchInstanceInputSchema.parse({ instance: '/i', resolution: '1280' })).toThrow()
  })
})

describe('launchInstanceCommand --wait', () => {
  function makeWaitCtx(opts: { onLaunch?: (options: any, bus: EventEmitter) => number | undefined; launchError?: Error } = {}) {
    const bus = new EventEmitter()
    const kill = vi.fn()
    const events: Array<[string, any]> = []
    const controller = new AbortController()
    let launched: any
    const ctx = makeCtx((key, method, arg) => {
      if (key === UserServiceKey && method === 'refreshUser') return makeUser()
      if (key === VersionInstallServiceKey && method === 'installInstance') return { version: 'v1' }
      if (key === InstanceServiceKey && method === 'editInstance') return undefined
      if (key === VersionServiceKey && method === 'resolveLocalVersion') return { id: 'v1', minecraftVersion: '1.21.1', libraries: [], pathChain: ['/v'] }
      if (key === JavaServiceKey && method === 'getJavaState') return { all: [{ path: '/java', valid: true, version: '21', majorVersion: 21, arch: 'x64' }] }
      if (key === JavaServiceKey && method === 'resolveJava') return undefined
      if (key === BaseServiceKey && method === 'getSettings') return makeSettings()
      if (key === LaunchServiceKey && method === 'launch') {
        if (opts.launchError) throw opts.launchError
        launched = arg
        const pid = opts.onLaunch ? opts.onLaunch(arg, bus) : 4242
        return pid
      }
      if (key === LaunchServiceKey && method === 'kill') return kill(arg)
      throw new Error(`Unexpected ctx.call(${key}, ${method})`)
    })
    ;(ctx as any).signal = controller.signal
    ;(ctx as any).subscribe = async (_key: unknown, event: string, listener: (e: any) => void) => {
      bus.on(event, listener)
      return () => bus.off(event, listener)
    }
    ;(ctx.out as any).event = (name: string, data: any) => events.push([name, data])
    return { ctx, bus, kill, events, controller, launched: () => launched }
  }

  const startEvent = (options: any, bus: EventEmitter, pid = 4242) => {
    bus.emit('minecraft-start', { pid, launchId: 'launch-1', operationId: options.operationId, startTime: Date.now() })
    return pid
  }

  test('reports start, ready and a clean exit', async () => {
    const { ctx, bus, events } = makeWaitCtx({ onLaunch: (o, b) => startEvent(o, b) })
    const running = launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true }), ctx)
    await vi.waitFor(() => expect(events.map(e => e[0])).toContain('started'))
    bus.emit('minecraft-window-ready', { pid: 4242, launchId: 'other-launch' })
    bus.emit('minecraft-window-ready', { pid: 4242, launchId: 'launch-1' })
    bus.emit('minecraft-exit', { pid: 4242, launchId: 'launch-1', code: 0 })
    const result: any = await running
    expect(result).toMatchObject({ pid: 4242, launchId: 'launch-1', exitCode: 0, crashed: false })
    expect(result.readyAt).toBeTypeOf('number')
    expect(events.map(e => e[0])).toEqual(['started', 'ready', 'exited'])
    expect(bus.listenerCount('minecraft-exit')).toBe(0)
  })

  test('fails with the unclean-exit status when Minecraft crashes', async () => {
    const { ctx, bus } = makeWaitCtx({ onLaunch: (o, b) => startEvent(o, b) })
    const running = launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true }), ctx)
    await vi.waitFor(() => expect(bus.listenerCount('minecraft-window-ready')).toBe(1))
    await Promise.resolve()
    bus.emit('minecraft-window-ready', { pid: 4242, launchId: 'launch-1' })
    bus.emit('minecraft-exit', { pid: 4242, launchId: 'launch-1', code: 1, crashReportLocation: '/inst/foo/crash-reports/c.txt' })
    await expect(running).rejects.toMatchObject({ exitCode: 14, name: 'UncleanExit' })
  })

  test('gives up when the window never appears and stops the game if asked', async () => {
    const { ctx, kill } = makeWaitCtx({ onLaunch: (o, b) => startEvent(o, b) })
    const running = launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true, readyTimeout: 0.05, stopOnCancel: true }), ctx)
    await expect(running).rejects.toMatchObject({ exitCode: 12, name: 'NotReady' })
    expect(kill).toHaveBeenCalledWith(4242)
  })

  test('cancelling leaves the game running unless asked to stop it', async () => {
    const { ctx, kill, controller, events } = makeWaitCtx({ onLaunch: (o, b) => startEvent(o, b) })
    const running = launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true }), ctx)
    await vi.waitFor(() => expect(events.map(e => e[0])).toContain('started'))
    controller.abort()
    await expect(running).rejects.toMatchObject({ exitCode: 130, name: 'Cancelled' })
    expect(kill).not.toHaveBeenCalled()
  })

  test('reports a launch that never starts as a start failure', async () => {
    const { ctx } = makeWaitCtx({ launchError: new Error('spawn java ENOENT') })
    await expect(launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true }), ctx))
      .rejects.toMatchObject({ exitCode: 11, name: 'StartFailed' })
  })

  test('passes the per-launch world and options to the launcher', async () => {
    const { ctx, bus, launched } = makeWaitCtx({ onLaunch: (o, b) => startEvent(o, b) })
    const running = launchInstanceCommand.handler(LaunchInstanceInputSchema.parse({ instance: '/inst/foo', wait: true, world: 'W', vmOption: ['-Dx=1'] }), ctx)
    await vi.waitFor(() => expect(launched()).toBeDefined())
    bus.emit('minecraft-exit', { pid: 4242, launchId: 'launch-1', code: 0 })
    await running
    expect(launched()).toMatchObject({ world: 'W', vmOptions: ['-Dx=1'] })
  })
})
