import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommandExitError, CommandRegistry, defineCommand, parseCli } from '@xmcl/runtime-api'
import { BackendCommandHost } from './BackendCommandHost'
import { createCliServer, CliServer } from './cliServer'
import { CliConnection, connectToLauncher, runCliClient } from './cliClient'
import { FrameDecoder, createProof, getCliSocketPath, readCliToken, verifyProof, writeCliToken } from './cliProtocol'

const token = 'a'.repeat(64)
let waitStarted = false
let waitAborted = false

function makeRegistry() {
  const registry = new CommandRegistry()
  registry.register(defineCommand({
    id: 'test.echo',
    title: 'Echo',
    category: 'system',
    input: z.object({ text: z.string() }),
    cli: { name: 'echo', positionals: ['text'] },
    async handler(input, ctx) {
      ctx.out.log(`said ${input.text}`)
      ctx.out.json({ ok: true, command: 'test.echo', data: input.text })
      ctx.out.event?.('echoed', { text: input.text })
      await ctx.task('work', async (h) => { h.update(1, 2, 'half') })
      return { text: input.text, cwd: ctx.cwd }
    },
  }))
  registry.register(defineCommand({
    id: 'test.fail',
    title: 'Fail',
    category: 'system',
    input: z.object({}),
    cli: { name: 'fail' },
    async handler() {
      throw new CommandExitError(13, 'TestFailed', 'harness said no')
    },
  }))
  registry.register(defineCommand({
    id: 'test.wait',
    title: 'Wait',
    category: 'system',
    input: z.object({}),
    cli: { name: 'wait' },
    handler(_input, ctx) {
      waitStarted = true
      return new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          waitAborted = true
          resolve('aborted')
        })
      })
    },
  }))
  registry.register(defineCommand({
    id: 'test.count',
    title: 'Count',
    category: 'system',
    input: z.object({ n: z.number() }),
    cli: { name: 'count', flags: { n: { type: 'number' } } },
    async handler(input) { return input.n },
  }))
  return registry
}

function sink() {
  const chunks: string[] = []
  return { chunks, write: (t: string) => { chunks.push(t) }, text: () => chunks.join('') }
}

let dir: string
let socketPath: string
let tokenPath: string
let registry: CommandRegistry
let host: BackendCommandHost
let server: CliServer
const extraServers: CliServer[] = []

beforeEach(async () => {
  waitStarted = false
  waitAborted = false
  dir = await mkdtemp(join(tmpdir(), 'vcli-'))
  socketPath = join(dir, 'cli.sock')
  tokenPath = join(dir, 'cli-token')
  registry = makeRegistry()
  host = new BackendCommandHost({ app: { version: '9.9.9' } as any, registry, serviceLocator: () => undefined })
  server = createCliServer({ host, token, launcherVersion: '9.9.9' })
  await server.listen(socketPath)
})

afterEach(async () => {
  await server.close()
  for (const extra of extraServers.splice(0)) await extra.close()
  await rm(dir, { recursive: true, force: true })
})

describe('FrameDecoder', () => {
  test('joins frames split across chunks', () => {
    const frames: any[] = []
    const decoder = new FrameDecoder((f) => frames.push(f))
    decoder.push('{"type":"a"}\n{"ty')
    decoder.push('pe":"b"}\n')
    expect(frames).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  test('rejects lines that are not frames', () => {
    expect(() => new FrameDecoder(() => {}).push('not json\n')).toThrow()
    expect(() => new FrameDecoder(() => {}).push('[1]\n')).toThrow(/Malformed/)
  })

  test('rejects an unterminated frame over the limit', () => {
    expect(() => new FrameDecoder(() => {}, 10).push('x'.repeat(20))).toThrow(/size limit/)
  })
})

describe('socket path and proofs', () => {
  test('uses the launcher data folder when the path is short enough', () => {
    expect(getCliSocketPath('/Users/u/Library/Application Support/vardrynn', 'darwin'))
      .toBe('/Users/u/Library/Application Support/vardrynn/cli.sock')
  })

  test('falls back to the temp folder for long paths', () => {
    const path = getCliSocketPath(`/${'x'.repeat(120)}`, 'linux')
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(path.endsWith('.sock')).toBe(true)
  })

  test('uses a named pipe on Windows', () => {
    expect(getCliSocketPath('C:\\Users\\u\\AppData\\Roaming\\vardrynn', 'win32')).toMatch(/^\\\\\.\\pipe\\vardrynn-cli-[0-9a-f]{24}$/)
  })

  test('proofs bind the token, role and nonce', () => {
    const proof = createProof(token, 'client', 'n1')
    expect(verifyProof(token, 'client', 'n1', proof)).toBe(true)
    expect(verifyProof(token, 'server', 'n1', proof)).toBe(false)
    expect(verifyProof(token, 'client', 'n2', proof)).toBe(false)
    expect(verifyProof('b'.repeat(64), 'client', 'n1', proof)).toBe(false)
    expect(verifyProof(token, 'client', 'n1', 'zz')).toBe(false)
  })

  test('token files are private and round-trip', async () => {
    const written = await writeCliToken(tokenPath)
    expect(await readCliToken(tokenPath)).toBe(written)
    if (process.platform !== 'win32') {
      const { stat } = await import('fs/promises')
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('command connection', () => {
  test('streams output, progress and events, then the result', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    expect(connection.launcherVersion).toBe('9.9.9')
    const logs: string[] = []
    const json: unknown[] = []
    const events: Array<[string, unknown]> = []
    const progress: unknown[][] = []
    const result = await connection.run(['vardrynn', 'echo', 'hi'], '/work', {
      onLog: (m) => logs.push(m),
      onJson: (p) => json.push(p),
      onEvent: (e, d) => events.push([e, d]),
      onProgress: (...args) => progress.push(args),
    })
    expect(result).toMatchObject({ ok: true, exitCode: 0, command: 'test.echo', data: { text: 'hi', cwd: '/work' } })
    expect(logs).toContain('said hi')
    expect(json).toEqual([{ ok: true, command: 'test.echo', data: 'hi' }])
    expect(events).toEqual([['echoed', { text: 'hi' }]])
    expect(progress).toContainEqual(['work', 1, 2, 'half'])
    connection.close()
  })

  test('refuses a client without the token', async () => {
    await expect(CliConnection.connect(socketPath, 'b'.repeat(64))).rejects.toMatchObject({ code: 'Unauthorized' })
  })

  test('reports nothing listening as unavailable', async () => {
    await expect(CliConnection.connect(join(dir, 'missing.sock'), token)).rejects.toMatchObject({ code: 'Unavailable' })
  })

  test('returns the exit code a command chooses', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    const result = await connection.run(['vardrynn', 'fail'], '/')
    expect(result).toMatchObject({ ok: false, exitCode: 13, error: { code: 'TestFailed', message: 'harness said no' } })
    connection.close()
  })

  test('invalid input and unknown flags are usage errors', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    expect(await connection.call('test.count', { n: 'x' }, '/')).toMatchObject({ ok: false, exitCode: 2, error: { code: 'ValidationError' } })
    expect(await connection.run(['vardrynn', 'count', '--bogus'], '/')).toMatchObject({ ok: false, exitCode: 2, error: { code: 'UsageError' } })
    expect(await connection.call('test.nope', {}, '/')).toMatchObject({ ok: false, exitCode: 2, error: { code: 'CommandNotFoundError' } })
    connection.close()
  })

  test('runs several requests at once on one connection', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    const results = await Promise.all([
      connection.call('test.count', { n: 1 }, '/'),
      connection.call('test.count', { n: 2 }, '/'),
      connection.run(['vardrynn', 'echo', 'x'], '/'),
    ])
    expect(results.map((r) => r.ok && r.data)).toEqual([1, 2, { text: 'x', cwd: '/' }])
    connection.close()
  })

  test('cancelling a request aborts its command', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    const controller = new AbortController()
    const running = connection.call('test.wait', {}, '/', {}, controller.signal)
    await vi.waitFor(() => expect(waitStarted).toBe(true))
    controller.abort()
    expect(await running).toMatchObject({ ok: true, data: 'aborted' })
    connection.close()
  })

  test('closing the connection aborts what it started', async () => {
    const connection = await CliConnection.connect(socketPath, token)
    const running = connection.call('test.wait', {}, '/').catch((e) => e)
    await vi.waitFor(() => expect(waitStarted).toBe(true))
    connection.close()
    await vi.waitFor(() => expect(waitAborted).toBe(true))
    await running
  })
})

describe('connectToLauncher', () => {
  test('starts a launcher when none answers and connects once it listens', async () => {
    const lateSocket = join(dir, 'late.sock')
    const startLauncher = vi.fn(() => {
      setTimeout(async () => {
        await writeFile(tokenPath, token)
        const late = createCliServer({ host, token, launcherVersion: '9.9.9' })
        extraServers.push(late)
        await late.listen(lateSocket)
      }, 100)
      return { exited: new Promise<number | null>(() => {}) }
    })
    const connection = await connectToLauncher({ socketPath: lateSocket, tokenPath, startLauncher, startTimeoutMs: 5000 })
    expect(startLauncher).toHaveBeenCalledOnce()
    expect(await connection.run(['vardrynn', 'echo', 'late'], '/')).toMatchObject({ ok: true })
    connection.close()
  })

  test('does not start a launcher when one answers', async () => {
    await writeFile(tokenPath, token)
    const startLauncher = vi.fn()
    const connection = await connectToLauncher({ socketPath, tokenPath, startLauncher })
    expect(startLauncher).not.toHaveBeenCalled()
    connection.close()
  })

  test('gives up when nothing starts in time', async () => {
    await expect(connectToLauncher({
      socketPath: join(dir, 'never.sock'),
      tokenPath,
      startLauncher: () => ({ exited: new Promise(() => {}) }),
      startTimeoutMs: 400,
    })).rejects.toMatchObject({ code: 'Unavailable' })
  })
})

describe('runCliClient', () => {
  const run = async (argv: string[], extra: Partial<Parameters<typeof runCliClient>[0]> = {}) => {
    const stdout = sink()
    const stderr = sink()
    const startLauncher = vi.fn(() => ({ exited: Promise.resolve(0) }))
    const code = await runCliClient({
      argv,
      parsed: parseCli(argv, registry),
      registry,
      version: '9.9.9',
      cwd: '/',
      stdout,
      stderr,
      isTTY: false,
      signal: new AbortController().signal,
      socketPath,
      tokenPath,
      startLauncher,
      startTimeoutMs: 300,
      ...extra,
    })
    return { code, stdout: stdout.text(), stderr: stderr.text(), startLauncher }
  }

  test('answers --help without a launcher', async () => {
    const r = await run(['vardrynn', '--help'], { socketPath: join(dir, 'missing.sock') })
    expect(r.code).toBe(0)
    expect(r.startLauncher).not.toHaveBeenCalled()
    expect(r.stdout).toContain('Usage: vardrynn')
  })

  test('reports a usage error without a launcher', async () => {
    const r = await run(['vardrynn', 'count', '--bogus'], { socketPath: join(dir, 'missing.sock') })
    expect(r.code).toBe(2)
    expect(r.startLauncher).not.toHaveBeenCalled()
    expect(r.stderr).toContain('Unknown flag --bogus')
  })

  test('keeps stdout machine-readable in --json mode', async () => {
    await writeFile(tokenPath, token)
    const r = await run(['vardrynn', 'echo', 'hi', '--json'])
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines).toContainEqual({ ok: true, command: 'test.echo', data: 'hi' })
    expect(lines.find((l) => l.type === 'event')).toMatchObject({ event: 'echoed', data: { text: 'hi' } })
    expect(lines.find((l) => l.type === 'progress')).toMatchObject({ task: 'work', progress: 1, total: 2 })
    expect(r.stderr).toContain('said hi')
    expect(r.stdout).not.toContain('said hi')
  })

  test('returns the command exit code and a JSON error envelope', async () => {
    await writeFile(tokenPath, token)
    const r = await run(['vardrynn', 'fail', '--json'])
    expect(r.code).toBe(13)
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, command: 'test.fail', error: { code: 'TestFailed' } })
  })

  test('prints human output and errors in text mode', async () => {
    await writeFile(tokenPath, token)
    const ok = await run(['vardrynn', 'echo', 'hi'])
    expect(ok.stdout).toBe('said hi\n')
    const failed = await run(['vardrynn', 'fail'])
    expect(failed.stderr).toContain('TestFailed: harness said no')
  })

  test('runs a terminal-side command with the connection', async () => {
    await writeFile(tokenPath, token)
    const local = vi.fn(async ({ connection, cwd }: any) => {
      const r = await connection.call('test.count', { n: 7 }, cwd)
      return r.data
    })
    const r = await run(['vardrynn', 'echo', 'ignored'], { clientCommands: { 'test.echo': local } })
    expect(local).toHaveBeenCalledOnce()
    expect(r.code).toBe(7)
  })

  test('exits with the unavailable status when no launcher can be reached', async () => {
    const r = await run(['vardrynn', 'echo', 'hi'], { socketPath: join(dir, 'missing.sock'), startTimeoutMs: 300 })
    expect(r.code).toBe(69)
    expect(r.startLauncher).toHaveBeenCalledOnce()
  })
})
