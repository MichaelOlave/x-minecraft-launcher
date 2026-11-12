import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestScenarioFileSchema, parseCli, commands, registerBuiltinCommands, type TestRunRecord } from '@xmcl/runtime-api'
import type { CliResultFrame } from '../commands/cliProtocol'
import { createTerminalRenderer, type CliRequestHandlers } from '../commands/cliClient'
import { findScenarioFile, readHarnessResult, runTestScenario, startProcess, substitute } from './testRunner'
import { TestRunStore, createRunId, isRunId } from './testRuns'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vtest-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const node = process.execPath

describe('scenario file', () => {
  test('fills defaults and rejects unknown keys', () => {
    const parsed = TestScenarioFileSchema.parse({
      version: 1,
      scenarios: { 'client-startup': { stage: { source: 'Pack', name: 'Pack Test' } } },
    })
    const scenario = parsed.scenarios['client-startup']
    expect(scenario.timeouts).toEqual({ ready: 600, exit: 180 })
    expect(scenario.launch).toEqual({})
    expect(scenario.prepare).toEqual([])
    expect(scenario.afterHarness).toBe('wait-for-exit')
    expect(TestScenarioFileSchema.safeParse({ version: 1, scenarios: { x: { stage: { source: 'a', name: 'b' }, typo: 1 } } }).success).toBe(false)
    expect(TestScenarioFileSchema.safeParse({ version: 1, scenarios: { 'Bad Name': { stage: { source: 'a', name: 'b' } } } }).success).toBe(false)
  })

  test('is found in the pack folder or a parent of the terminal folder', async () => {
    await mkdir(join(root, 'pack', 'veil-dev'), { recursive: true })
    await writeFile(join(root, 'pack', 'vardrynn.tests.json'), '{}')
    expect(await findScenarioFile(join(root, 'pack', 'veil-dev'))).toBe(join(root, 'pack', 'vardrynn.tests.json'))
    expect(await findScenarioFile(root, 'pack')).toBe(join(root, 'pack', 'vardrynn.tests.json'))
    await expect(findScenarioFile(root, '.')).rejects.toMatchObject({ exitCode: 2 })
  })

  test('substitutes run variables in command arguments', () => {
    expect(substitute(['x', '--client', '${VARDRYNN_INSTANCE}', '${HOME}'], { VARDRYNN_INSTANCE: '/i' })).toEqual(['x', '--client', '/i', '${HOME}'])
  })
})

describe('startProcess', () => {
  test('echoes output lines and reports the exit status', async () => {
    const lines: string[] = []
    const outcome = await startProcess([node, '-e', 'console.log("one\\ntwo"); console.error("err"); process.exit(3)'], {
      cwd: root, env: process.env, echo: (l) => lines.push(l), signal: new AbortController().signal,
    }).done
    expect(outcome).toMatchObject({ exitCode: 3, timedOut: false, cancelled: false })
    expect(lines.sort()).toEqual(['err', 'one', 'two'])
  })

  test('stops a command and what it started when it times out', async () => {
    const pidFile = join(root, 'grandchild.pid')
    const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`
    const outcome = await startProcess([node, '-e', script], { cwd: root, env: process.env, echo: () => {}, signal: new AbortController().signal, timeoutMs: 500 }).done
    expect(outcome.timedOut).toBe(true)
    const grandchild = Number(await readFile(pidFile, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow(), { timeout: 3000 })
  })

  test('cancelling stops the command', async () => {
    const controller = new AbortController()
    const running = startProcess([node, '-e', 'setInterval(() => {}, 1000)'], { cwd: root, env: process.env, echo: () => {}, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(await running.done).toMatchObject({ cancelled: true })
  })

  test('a missing command fails without throwing', async () => {
    const outcome = await startProcess(['./no-such-tool'], { cwd: root, env: process.env, echo: () => {}, signal: new AbortController().signal }).done
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.error).toBeTruthy()
  })
})

describe('readHarnessResult', () => {
  const ok = { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 5 }

  test('uses the result file', async () => {
    const file = join(root, 'result.json')
    await writeFile(file, JSON.stringify({ result: 'PASS', checks: [{ name: 'reload', result: 'PASS' }], summary: 'all good' }))
    expect(await readHarnessResult(file, ok)).toMatchObject({ result: 'PASS', source: 'result-file', checks: [{ name: 'reload', result: 'PASS' }], summary: 'all good' })
  })

  test('a failed check, or a failed harness process, fails a PASS file', async () => {
    const file = join(root, 'result.json')
    await writeFile(file, JSON.stringify({ result: 'PASS', checks: [{ name: 'a', result: 'FAIL' }] }))
    expect((await readHarnessResult(file, ok)).result).toBe('FAIL')
    await writeFile(file, JSON.stringify({ result: 'PASS' }))
    expect((await readHarnessResult(file, { ...ok, exitCode: 1 })).result).toBe('FAIL')
  })

  test('falls back to the exit status, and fails on timeout', async () => {
    const missing = join(root, 'missing.json')
    expect(await readHarnessResult(missing, ok)).toMatchObject({ result: 'PASS', source: 'exit-code' })
    expect(await readHarnessResult(missing, { ...ok, exitCode: 2 })).toMatchObject({ result: 'FAIL', source: 'exit-code' })
    expect(await readHarnessResult(missing, { ...ok, timedOut: true })).toMatchObject({ result: 'FAIL', source: 'timeout' })
  })
})

describe('TestRunStore', () => {
  test('creates, updates and lists runs, keeping only the newest', async () => {
    const store = new TestRunStore(join(root, 'runs'), 2)
    const a = await store.begin({ scenario: 'veil-reload', pack: '/p', scenarioFile: '/p/f', launcherVersion: '1' })
    expect(isRunId(a.runId)).toBe(true)
    expect(a.runDir).toBe(join(root, 'runs', a.runId))
    const updated = await store.update(a.runId, { outcome: 'passed', runId: 'evil', runDir: '/tmp' } as any)
    expect(updated).toMatchObject({ runId: a.runId, runDir: a.runDir, outcome: 'passed' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.begin({ scenario: 'veil-reload', pack: '/p', scenarioFile: '/p/f', launcherVersion: '1' })
    await new Promise((r) => setTimeout(r, 5))
    const c = await store.begin({ scenario: 'client-startup', pack: '/p', scenarioFile: '/p/f', launcherVersion: '1' })
    expect((await store.list()).map((r) => r.runId)).toEqual([c.runId, b.runId])
    expect(await store.get(a.runId)).toBeUndefined()
  })

  test('rejects run IDs that could leave the runs folder', async () => {
    const store = new TestRunStore(join(root, 'runs'))
    expect(await store.get('../etc')).toBeUndefined()
    expect(() => store.dir('../x-20260101-000000-abcd')).toThrow()
    expect(isRunId(createRunId('veil-reload', new Date(2026, 10, 12, 1, 2, 3)))).toBe(true)
  })
})

describe('runTestScenario', () => {
  registerBuiltinCommands()

  interface FakeLaunch {
    /** What the fake launcher does once the launch starts. */
    behaviour: 'pass' | 'crash-after-test' | 'start-fails' | 'not-ready' | 'never-exits'
  }

  async function setupPack(scenario: Record<string, unknown>) {
    const pack = join(root, 'pack')
    await mkdir(pack, { recursive: true })
    await writeFile(join(pack, 'vardrynn.tests.json'), JSON.stringify({ version: 1, scenarios: { 'veil-reload': { stage: { source: 'Working', name: 'Working Test' }, ...scenario } } }))
    return pack
  }

  function fakeConnection(pack: string, launch: FakeLaunch) {
    const calls: Array<{ command: string; input: any }> = []
    let record: TestRunRecord | undefined
    const runDir = join(root, 'runs', 'veil-reload-20261112-000000-abcd')
    let pending = 0
    const ok = (data?: unknown): CliResultFrame => ({ type: 'result', id: 1, ok: true, exitCode: 0, data })
    const fail = (exitCode: number, code: string, message: string): CliResultFrame => ({ type: 'result', id: 1, ok: false, exitCode, error: { code, message } })
    const connection = {
      get activeRequests() { return pending },
      async call(command: string, input: any, _cwd: string, handlers: CliRequestHandlers = {}, signal?: AbortSignal): Promise<CliResultFrame> {
        calls.push({ command, input })
        switch (command) {
          case 'test.begin':
            record = { runId: 'veil-reload-20261112-000000-abcd', scenario: input.scenario, pack, scenarioFile: input.scenarioFile, launcherVersion: '9', createdAt: Date.now(), outcome: 'running', phases: [], runDir }
            await mkdir(runDir, { recursive: true })
            return ok(record)
          case 'test.record':
          case 'test.finish':
            record = { ...record!, ...input.update }
            return ok(record)
          case 'test.stage':
            return ok({ instancePath: join(root, 'Working Test'), name: 'Working Test', created: false, sourcePath: '/w', mods: { total: 3, copied: 0, removed: [], excluded: [] }, copied: [], overlays: [], localMods: [], warnings: [], dryRun: false, durationMs: 1 })
          case 'test.launch-record':
            return ok(join(root, 'launch.json'))
          case 'instance.launch': {
            pending++
            try {
              if (launch.behaviour === 'start-fails') return fail(11, 'StartFailed', 'Minecraft did not start: spawn java ENOENT')
              handlers.onEvent?.('started', { pid: 4242, launchId: 'L1', startedAt: Date.now() })
              if (launch.behaviour === 'not-ready') return fail(12, 'NotReady', 'Minecraft did not open its window within 1 s; it was stopped')
              handlers.onEvent?.('ready', { readyAt: Date.now(), startupMs: 1500 })
              const resultFile = join(runDir, 'harness', 'result.json')
              const deadline = Date.now() + 10_000
              while (Date.now() < deadline) {
                if (signal?.aborted) return fail(130, 'Cancelled', 'Cancelled; Minecraft was stopped')
                if (launch.behaviour !== 'never-exits' && await stat(resultFile).catch(() => undefined)) break
                await new Promise((r) => setTimeout(r, 20))
              }
              if (launch.behaviour === 'crash-after-test') {
                handlers.onEvent?.('exited', { endedAt: Date.now(), exitCode: 1, crashed: true })
                return fail(14, 'UncleanExit', 'Minecraft exited with status 1')
              }
              handlers.onEvent?.('exited', { endedAt: Date.now(), exitCode: 0, crashed: false })
              return ok({ pid: 4242, launchId: 'L1', exitCode: 0 })
            } finally {
              pending--
            }
          }
        }
        throw new Error(`unexpected ${command}`)
      },
    }
    return { connection, calls, record: () => record!, runDir }
  }

  async function run(pack: string, launch: FakeLaunch, argv: string[] = [], signal = new AbortController().signal) {
    const fake = fakeConnection(pack, launch)
    const out: string[] = []
    const parsed = parseCli(['vardrynn', 'test', 'run', 'veil-reload', ...argv], commands)
    if (parsed.kind !== 'command') throw new Error(parsed.kind)
    const sink = { write: (t: string) => { out.push(t) } }
    const code = await runTestScenario({
      connection: fake.connection as any,
      parsed,
      cwd: pack,
      renderer: createTerminalRenderer({ json: false, command: 'test.run', stdout: sink, stderr: sink, isTTY: false }),
      stdout: sink,
      stderr: sink,
      signal,
    })
    return { code, text: out.join(''), ...fake }
  }

  const writeResult = (result: string) => [node, '-e', `require('fs').writeFileSync(process.env.VARDRYNN_RESULT, JSON.stringify({ result: '${result}', checks: [{ name: 'preview on', result: '${result}' }] })); console.log('pid', process.env.VARDRYNN_PID)`]

  test('passes when the harness passes and the game exits cleanly', async () => {
    const pack = await setupPack({ harness: { command: writeResult('PASS') }, launch: { world: 'Veil Development', vmOptions: ['-Dveil.debug=true'] } })
    const r = await run(pack, { behaviour: 'pass' })
    expect(r.code).toBe(0)
    expect(r.record()).toMatchObject({ outcome: 'passed', exitCode: 0, harness: { result: 'PASS', source: 'result-file' }, launch: { launchId: 'L1', pid: 4242, startupMs: 1500 } })
    expect(r.record().phases.map((p) => [p.name, p.status])).toEqual([['setup', 'passed'], ['start', 'passed'], ['ready', 'passed'], ['test', 'passed'], ['exit', 'passed']])
    const launchCall = r.calls.find((c) => c.command === 'instance.launch')!.input
    expect(launchCall).toMatchObject({ world: 'Veil Development', vmOption: ['-Dveil.debug=true'], wait: true, stopOnCancel: true, readyTimeout: 600 })
    expect(r.text).toContain('[harness] pid 4242')
    expect(r.text).toContain('PASSED')
    expect(await readFile(join(r.runDir, 'harness.log'), 'utf8')).toContain('pid 4242')
  })

  test('a failing harness fails the test', async () => {
    const pack = await setupPack({ harness: { command: writeResult('FAIL') } })
    const r = await run(pack, { behaviour: 'pass' })
    expect(r.code).toBe(13)
    expect(r.record().outcome).toBe('test-failed')
  })

  test('a crash after a passing test is an unclean exit', async () => {
    const pack = await setupPack({ harness: { command: writeResult('PASS') } })
    const r = await run(pack, { behaviour: 'crash-after-test' })
    expect(r.code).toBe(14)
    expect(r.record().launch).toMatchObject({ crashed: true, exitCode: 1 })
  })

  test('a game that never starts or never becomes ready has its own status', async () => {
    const pack = await setupPack({ harness: { command: writeResult('PASS') } })
    expect((await run(pack, { behaviour: 'start-fails' })).code).toBe(11)
    const notReady = await run(pack, { behaviour: 'not-ready' })
    expect(notReady.code).toBe(12)
    expect(notReady.record().phases.find((p) => p.name === 'ready')).toMatchObject({ status: 'failed' })
  })

  test('a failed build step stops before launching', async () => {
    const pack = await setupPack({ prepare: [[node, '-e', 'process.exit(4)']], harness: { command: writeResult('PASS') } })
    const r = await run(pack, { behaviour: 'pass' })
    expect(r.code).toBe(10)
    expect(r.calls.map((c) => c.command)).not.toContain('instance.launch')
    expect(r.record().error?.message).toContain('exited with status 4')
  })

  test('stops a game that does not exit after the test', async () => {
    const pack = await setupPack({ harness: { command: writeResult('PASS') }, timeouts: { exit: 0.2 } })
    const r = await run(pack, { behaviour: 'never-exits' })
    expect(r.code).toBe(14)
    expect(r.record().launch?.stopped).toBe(true)
  })

  test('a startup smoke test passes once ready when the scenario stops the game', async () => {
    const pack = await setupPack({ afterHarness: 'stop-game' })
    const r = await run(pack, { behaviour: 'never-exits' })
    expect(r.code).toBe(0)
    expect(r.record().phases.find((p) => p.name === 'test')).toMatchObject({ status: 'skipped' })
  })

  test('extra builds from the command line are added to the scenario', async () => {
    const pack = await setupPack({ stage: { source: 'Working', name: 'Working Test', mods: [{ path: 'veil-dev/build/libs/x.jar', add: true }] }, afterHarness: 'stop-game' })
    const r = await run(pack, { behaviour: 'never-exits' }, ['--mod', 'pockets.jar'])
    const options = r.calls.find((c) => c.command === 'test.stage')!.input.options
    expect(options.mods).toEqual([{ path: 'veil-dev/build/libs/x.jar', add: true }, { path: join(pack, 'pockets.jar') }])
    expect(options.cwd).toBe(pack)
  })

  test('an unknown scenario is a usage error', async () => {
    const pack = await setupPack({})
    await writeFile(join(pack, 'vardrynn.tests.json'), JSON.stringify({ version: 1, scenarios: {} }))
    expect((await run(pack, { behaviour: 'pass' })).code).toBe(2)
  })

  test('Ctrl+C cancels the run and stops the game', async () => {
    const pack = await setupPack({ harness: { command: [node, '-e', 'setInterval(() => {}, 1000)'] } })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const r = await run(pack, { behaviour: 'pass' }, [], controller.signal)
    expect(r.code).toBe(130)
    expect(r.record().outcome).toBe('cancelled')
    expect(await readdir(r.runDir)).toContain('harness.log')
  })
})
