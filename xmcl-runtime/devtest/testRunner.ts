import {
  CommandExitError,
  CliExitCode,
  RunTestScenarioInputSchema,
  TEST_OUTCOME_EXIT_CODES,
  TEST_SCENARIO_FILE,
  TestScenarioFileSchema,
  describeTestRun,
  type StageDevInstanceOptions,
  type StageDevInstanceResult,
  type TestHarnessResult,
  type TestRunLaunch,
  type TestRunOutcome,
  type TestRunPhase,
  type TestRunPhaseName,
  type TestRunRecord,
  type TestScenario,
} from '@xmcl/runtime-api'
import { spawn } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, readFile, rm, stat } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import type { CliErrorPayload, CliResultFrame } from '../commands/cliProtocol'
import { unwrapResult, type ClientCommand, type ClientCommandContext } from '../commands/cliClient'

/** Find the scenario file: in `--pack`, or the nearest folder up from the terminal's folder. */
export async function findScenarioFile(cwd: string, pack?: string): Promise<string> {
  const exists = async (path: string) => !!(await stat(path).catch(() => undefined))?.isFile()
  if (pack) {
    const file = join(resolve(cwd, pack), TEST_SCENARIO_FILE)
    if (await exists(file)) return file
    throw new CommandExitError(CliExitCode.Usage, 'ScenarioFileNotFound', `No ${TEST_SCENARIO_FILE} in ${resolve(cwd, pack)}`)
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (await exists(join(dir, TEST_SCENARIO_FILE))) return join(dir, TEST_SCENARIO_FILE)
    if (dirname(dir) === dir) break
  }
  throw new CommandExitError(CliExitCode.Usage, 'ScenarioFileNotFound', `No ${TEST_SCENARIO_FILE} here or in any parent folder. Run from the pack repository or pass --pack.`)
}

export async function loadScenarios(file: string) {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    throw new CommandExitError(CliExitCode.Usage, 'InvalidScenarioFile', `${file}: ${(e as Error).message}`)
  }
  const parsed = TestScenarioFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CommandExitError(CliExitCode.Usage, 'InvalidScenarioFile', `${file}: ${issues}`)
  }
  return parsed.data
}

/** Replace `${VARDRYNN_*}` in a command's arguments. */
export function substitute(argv: string[], env: Record<string, string | undefined>) {
  return argv.map((arg) => arg.replace(/\$\{(VARDRYNN_[A-Z_]+)\}/g, (match, name: string) => env[name] ?? match))
}

export interface ProcessOutcome {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  error?: string
  durationMs: number
}

export interface RunningProcess {
  done: Promise<ProcessOutcome>
  /** Stop the process and everything it started. */
  kill(): void
}

/**
 * Run a command without a shell, in its own process group so it can be
 * stopped with everything it started. Each output line goes to `echo` and
 * to the log file.
 */
export function startProcess(argv: string[], opts: {
  cwd: string
  env: NodeJS.ProcessEnv
  log?: WriteStream
  echo: (line: string) => void
  signal: AbortSignal
  timeoutMs?: number
}): RunningProcess {
  const startedAt = Date.now()
  const [command, ...args] = argv
  const executable = !isAbsolute(command) && /[\\/]/.test(command) ? resolve(opts.cwd, command) : command
  const isWindows = process.platform === 'win32'
  const child = spawn(executable, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
    shell: isWindows && /\.(bat|cmd)$/i.test(executable),
    windowsHide: true,
  })
  let timedOut = false
  let cancelled = false
  let killTimer: NodeJS.Timeout | undefined
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
    }, 5000)
    killTimer.unref()
  }
  const forward = (stream: NodeJS.ReadableStream | null) => {
    let buffer = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      opts.log?.write(chunk)
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        opts.echo(buffer.slice(0, index).replace(/\r$/, ''))
        buffer = buffer.slice(index + 1)
      }
    })
    stream?.on('end', () => { if (buffer) opts.echo(buffer) })
  }
  forward(child.stdout)
  forward(child.stderr)
  const onAbort = () => { cancelled = true; kill() }
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const timeout = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill() }, opts.timeoutMs) : undefined
  const done = new Promise<ProcessOutcome>((resolveDone) => {
    let error: string | undefined
    child.once('error', (e) => { error = e.message })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      opts.signal.removeEventListener('abort', onAbort)
      resolveDone({ exitCode, signal, timedOut, cancelled, error, durationMs: Date.now() - startedAt })
    })
  })
  if (opts.signal.aborted) onAbort()
  return { done, kill }
}

/** Read the harness's result file; fall back to its exit status. */
export async function readHarnessResult(file: string, outcome: ProcessOutcome): Promise<TestHarnessResult> {
  const base = { exitCode: outcome.exitCode, durationMs: outcome.durationMs }
  if (outcome.timedOut) {
    return { ...base, result: 'FAIL', checks: [], summary: 'The harness ran past its time limit and was stopped', source: 'timeout' }
  }
  const raw = await readFile(file, 'utf8').catch(() => '')
  if (raw) {
    try {
      const data = JSON.parse(raw) as { result?: unknown; checks?: unknown; summary?: unknown }
      const result = String(data.result).toUpperCase()
      if (result === 'PASS' || result === 'FAIL') {
        const checks = Array.isArray(data.checks)
          ? data.checks
            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
            .map((c) => ({
              name: String(c.name ?? ''),
              result: (['PASS', 'FAIL', 'SKIP'].includes(String(c.result).toUpperCase()) ? String(c.result).toUpperCase() : 'FAIL') as 'PASS' | 'FAIL' | 'SKIP',
              detail: c.detail === undefined ? undefined : String(c.detail),
            }))
          : []
        // A result file cannot pass a run whose harness failed or whose checks failed.
        const passed = result === 'PASS' && outcome.exitCode === 0 && !checks.some((c) => c.result === 'FAIL')
        return { ...base, result: passed ? 'PASS' : 'FAIL', checks, summary: typeof data.summary === 'string' ? data.summary : undefined, source: 'result-file' }
      }
    } catch { /* treat as missing */ }
  }
  const passed = outcome.exitCode === 0
  return {
    ...base,
    result: passed ? 'PASS' : 'FAIL',
    checks: [],
    summary: outcome.error
      ? `The harness could not start: ${outcome.error}`
      : passed ? 'The harness exited cleanly without writing a result file' : `The harness exited with status ${outcome.exitCode ?? outcome.signal}`,
    source: 'exit-code',
  }
}

/** The stage options for a scenario, with extra builds from the command line. */
export function toStageOptions(scenario: TestScenario, pack: string, extra: { mod: string[]; addMod: string[]; keepWorld: boolean; cwd: string }): StageDevInstanceOptions {
  const { stage } = scenario
  return {
    ...stage,
    world: stage.world ? { ...stage.world, reset: extra.keepWorld ? false : stage.world.reset } : undefined,
    mods: [
      ...(stage.mods ?? []),
      ...extra.mod.map((path) => ({ path: resolve(extra.cwd, path) })),
      ...extra.addMod.map((path) => ({ path: resolve(extra.cwd, path), add: true })),
    ],
    cwd: pack,
  }
}

class Phases {
  readonly list: TestRunPhase[] = []

  start(name: TestRunPhaseName) {
    const phase: TestRunPhase = { name, status: 'running', startedAt: Date.now() }
    this.list.push(phase)
    return {
      pass: (detail?: string) => Object.assign(phase, { status: 'passed', endedAt: Date.now(), detail }),
      fail: (detail?: string) => Object.assign(phase, { status: 'failed', endedAt: Date.now(), detail }),
      skip: (detail?: string) => Object.assign(phase, { status: 'skipped', endedAt: Date.now(), detail }),
    }
  }

  /** Mark a phase that never started as skipped. */
  skip(name: TestRunPhaseName, detail?: string) {
    this.list.push({ name, status: 'skipped', detail })
  }
}

function asError(e: unknown): { code: string; message: string } {
  const error = e as { name?: string; code?: string; message?: string }
  return { code: (typeof error?.code === 'string' && error.code) || error?.name || 'Error', message: error?.message ?? String(e) }
}

function errorOf(frame: CliResultFrame): CliErrorPayload | undefined {
  return frame.ok ? undefined : frame.error
}

/**
 * `vardrynn test run <scenario>`: build, stage, launch and test a scenario
 * from the pack's vardrynn.tests.json, then report the run ID, outcome and
 * evidence folder. Runs in the terminal; the launcher does the staging and
 * launching. Never throws for a failed run: the exit status says what failed.
 */
export const runTestScenario: ClientCommand = async (ctx: ClientCommandContext) => {
  const { connection, renderer, signal } = ctx
  const say = (line: string) => renderer.onLog?.(line)
  const event = (name: string, data?: unknown) => renderer.onEvent?.(name, data)

  const parsedInput = RunTestScenarioInputSchema.safeParse(ctx.parsed.input)
  if (!parsedInput.success) {
    renderer.error('test.run', { code: 'ValidationError', issues: parsedInput.error.issues })
    return CliExitCode.Usage
  }
  const input = parsedInput.data

  let file: string
  let scenario: TestScenario
  try {
    file = await findScenarioFile(ctx.cwd, input.pack)
    const scenarios = await loadScenarios(file)
    const found = scenarios.scenarios[input.scenario]
    if (!found) {
      throw new CommandExitError(CliExitCode.Usage, 'ScenarioNotFound', `No scenario "${input.scenario}" in ${file}. Scenarios: ${Object.keys(scenarios.scenarios).join(', ') || 'none'}`)
    }
    scenario = found
  } catch (e) {
    renderer.error('test.run', { code: (e as Error).name, message: (e as Error).message })
    return (e as CommandExitError).exitCode ?? CliExitCode.Usage
  }
  const pack = dirname(file)

  let record = unwrapResult<TestRunRecord>(await connection.call('test.begin', { scenario: input.scenario, pack, scenarioFile: file }, ctx.cwd))
  const { runId, runDir } = record
  say(`Run ${runId}${scenario.description ? `: ${scenario.description}` : ''}`)
  event('run', { runId, runDir })

  const phases = new Phases()
  const update: Partial<TestRunRecord> = {}
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VARDRYNN_RUN_ID: runId,
    VARDRYNN_RUN_DIR: runDir,
    VARDRYNN_SCENARIO: input.scenario,
    VARDRYNN_PACK: pack,
  }
  const save = () => connection.call('test.record', { runId, update: { ...update, phases: phases.list } }, ctx.cwd).catch(() => undefined)

  const finish = async (outcome: TestRunOutcome, error?: { code: string; message: string }) => {
    const exitCode = TEST_OUTCOME_EXIT_CODES[outcome]
    const final = { ...update, outcome, exitCode, error, phases: phases.list, endedAt: Date.now() }
    try {
      record = unwrapResult<TestRunRecord>(await connection.call('test.finish', { runId, update: final }, ctx.cwd))
    } catch (e) {
      say(`Could not save the run record: ${(e as Error).message}`)
      record = { ...record, ...final }
    }
    renderer.flush()
    for (const line of describeTestRun(record)) say(line)
    event('finished', { runId, outcome, exitCode, runDir })
    renderer.onJson?.({ ok: outcome === 'passed', command: 'test.run', data: record })
    return exitCode
  }

  await mkdir(runDir, { recursive: true })
  const prepareLog = createWriteStream(join(runDir, 'prepare.log'), { flags: 'a' })
  const harnessLog = createWriteStream(join(runDir, 'harness.log'), { flags: 'a' })
  try {
    // Setup: build, stage, adjust the staged instance.
    const setup = phases.start('setup')
    let stage: StageDevInstanceResult
    try {
      const runSteps = async (label: string, commands: string[][]) => {
        for (const command of commands) {
          const argv = substitute(command, env)
          say(`[${label}] ${argv.join(' ')}`)
          prepareLog.write(`$ ${argv.join(' ')}\n`)
          const outcome = await startProcess(argv, { cwd: pack, env, log: prepareLog, echo: (line) => say(`[${label}] ${line}`), signal }).done
          if (outcome.cancelled) throw new CommandExitError(CliExitCode.Cancelled, 'Cancelled', 'Cancelled')
          if (outcome.exitCode !== 0) {
            throw new CommandExitError(CliExitCode.SetupFailed, 'PrepareFailed', `${argv.join(' ')} ${outcome.error ? `could not start: ${outcome.error}` : `exited with status ${outcome.exitCode ?? outcome.signal}`}`)
          }
        }
      }
      await runSteps('prepare', scenario.prepare)
      const options = toStageOptions(scenario, pack, { ...input, cwd: ctx.cwd })
      stage = unwrapResult<StageDevInstanceResult>(await connection.call('test.stage', { options }, pack, { onLog: say, onProgress: renderer.onProgress }, signal))
      update.stage = stage
      update.instance = { name: stage.name, path: stage.instancePath }
      Object.assign(env, { VARDRYNN_INSTANCE: stage.instancePath, VARDRYNN_INSTANCE_NAME: stage.name, VARDRYNN_WORLD: scenario.launch.world ?? '' })
      await runSteps('after-stage', scenario.afterStage)
      setup.pass(`${stage.mods.total} pack mods, ${stage.localMods.length} local build(s)`)
    } catch (e) {
      setup.fail((e as Error).message)
      for (const name of ['start', 'ready', 'test', 'exit'] as const) phases.skip(name)
      return await finish(signal.aborted ? 'cancelled' : 'setup-failed', asError(e))
    }
    void save()

    // Start: launch with this run's settings and follow the game until it exits.
    const start = phases.start('start')
    let ready: ReturnType<Phases['start']> | undefined
    let launch: TestRunLaunch | undefined
    let launchRecordPath: Promise<string | undefined> = Promise.resolve(undefined)
    let onReady!: () => void
    const readySignal = new Promise<void>((r) => { onReady = r })
    const launchAbort = new AbortController()
    const onCancel = () => launchAbort.abort()
    signal.addEventListener('abort', onCancel, { once: true })
    const { launch: settings } = scenario
    const launchCall = connection.call('instance.launch', {
      instance: stage.instancePath,
      user: input.user ?? settings.user,
      world: settings.world,
      vmOption: settings.vmOptions ?? [],
      replaceVmOptions: settings.replaceVmOptions ?? false,
      mcOption: settings.mcOptions ?? [],
      env: Object.entries(settings.env ?? {}).map(([k, v]) => `${k}=${v}`),
      minMemory: settings.minMemory,
      maxMemory: settings.maxMemory,
      resolution: settings.resolution,
      wait: true,
      readyTimeout: scenario.timeouts.ready,
      stopOnCancel: true,
    }, pack, {
      onLog: say,
      onProgress: renderer.onProgress,
      onEvent: (name, data) => {
        event(name, data)
        const e = data as Record<string, any>
        if (name === 'started') {
          launch = { launchId: e.launchId, pid: e.pid, startedAt: e.startedAt }
          update.launch = launch
          start.pass(`pid ${e.pid}`)
          ready = phases.start('ready')
          Object.assign(env, { VARDRYNN_LAUNCH_ID: e.launchId, VARDRYNN_PID: String(e.pid) })
          launchRecordPath = connection.call('test.launch-record', { instancePath: stage.instancePath, launchId: e.launchId }, pack)
            .then((f) => unwrapResult<string>(f), () => undefined)
          void save()
        } else if (name === 'ready' && launch) {
          Object.assign(launch, { readyAt: e.readyAt, startupMs: e.startupMs })
          ready?.pass(`window after ${(e.startupMs / 1000).toFixed(1)} s`)
          onReady()
        } else if (name === 'exited' && launch) {
          Object.assign(launch, { endedAt: e.endedAt, exitCode: e.exitCode, signal: e.signal, crashed: e.crashed, crashReportLocation: e.crashReportLocation })
        }
      },
    }, launchAbort.signal)
    const launchSettled = launchCall.then(
      (frame) => frame,
      (e): CliResultFrame => ({ type: 'result', id: 0, ok: false, exitCode: CliExitCode.Failure, error: { code: 'Disconnected', message: (e as Error).message } }),
    )

    try {
      const first = await Promise.race([readySignal.then(() => undefined), launchSettled])
      if (first) {
        // The game ended, or never started, before its window appeared.
        const error = errorOf(first)
        if (signal.aborted || error?.code === 'Cancelled') {
          return await finish('cancelled')
        }
        if (!launch) {
          start.fail(error?.message ?? 'Minecraft did not start')
          for (const name of ['ready', 'test', 'exit'] as const) phases.skip(name)
          return await finish('start-failed', error ? { code: error.code, message: error.message ?? '' } : undefined)
        }
        const detail = error?.code === 'NotReady'
          ? error.message
          : `Minecraft exited before its window appeared${launch.exitCode !== undefined ? ` (status ${launch.exitCode})` : ''}`
        if (error?.code === 'NotReady') launch.stopped = true
        ready?.fail(detail)
        phases.skip('test')
        phases.skip('exit')
        return await finish('not-ready', { code: error?.code ?? 'NotReady', message: detail ?? '' })
      }

      // Test: the pack's harness decides pass or fail.
      let harness: TestHarnessResult | undefined
      if (!scenario.harness) {
        phases.skip('test', 'no harness; readiness and a clean exit decide')
      } else {
        const test = phases.start('test')
        const evidenceDir = join(runDir, 'harness')
        const resultFile = join(evidenceDir, 'result.json')
        await mkdir(evidenceDir, { recursive: true })
        await rm(resultFile, { force: true })
        const harnessEnv = {
          ...env,
          VARDRYNN_LAUNCH_RECORD: (await launchRecordPath) ?? '',
          VARDRYNN_RESULT: resultFile,
          VARDRYNN_EVIDENCE_DIR: evidenceDir,
        }
        const argv = substitute(scenario.harness.command, harnessEnv)
        say(`[harness] ${argv.join(' ')}`)
        const running = startProcess(argv, {
          cwd: pack,
          env: harnessEnv,
          log: harnessLog,
          echo: (line) => say(`[harness] ${line}`),
          signal,
          timeoutMs: scenario.harness.timeout * 1000,
        })
        const second = await Promise.race([running.done.then(() => undefined), launchSettled])
        if (second) {
          // The game ended while the harness was still going. Let it notice and report.
          const finished = await Promise.race([running.done.then(() => true), delay(60_000).then(() => false)])
          if (!finished) running.kill()
        }
        const outcome = await running.done
        if (signal.aborted) return await finish('cancelled')
        harness = await readHarnessResult(resultFile, outcome)
        update.harness = harness
        const failedChecks = harness.checks.filter((c) => c.result === 'FAIL').length
        const detail = harness.summary ?? `${harness.checks.length - failedChecks} of ${harness.checks.length} checks passed`
        if (harness.result === 'PASS') test.pass(detail)
        else test.fail(detail)
      }

      // Exit: the game should close cleanly on its own unless the scenario stops it.
      const exit = phases.start('exit')
      // With no harness, `stop-game` makes a startup smoke test: ready, then stopped.
      const stopExpected = scenario.afterHarness === 'stop-game' && (!harness || harness.result === 'PASS')
      let final: CliResultFrame | undefined
      if (harness?.result === 'FAIL' || stopExpected) {
        final = await Promise.race([launchSettled, delay(stopExpected ? 0 : 15_000).then(() => undefined)])
      } else {
        final = await Promise.race([launchSettled, delay(scenario.timeouts.exit * 1000).then(() => undefined)])
      }
      if (!final) {
        launchAbort.abort()
        if (launch) launch.stopped = true
        final = await launchSettled
      }
      if (signal.aborted) return await finish('cancelled')
      const error = errorOf(final)
      let exitClean: boolean
      if (launch?.stopped) {
        exitClean = stopExpected
        if (stopExpected) exit.pass('stopped after the test, as the scenario asks')
        else exit.fail(`Minecraft did not exit within ${harness?.result === 'FAIL' ? 15 : scenario.timeouts.exit} s and was stopped`)
      } else if (error) {
        exitClean = false
        exit.fail(error.message ?? error.code)
      } else {
        exitClean = true
        exit.pass('clean exit')
      }

      if (harness && harness.result !== 'PASS') return await finish('test-failed', { code: 'TestFailed', message: harness.summary ?? 'The harness reported a failure' })
      if (!exitClean) return await finish('unclean-exit', { code: error?.code ?? 'UncleanExit', message: error?.message ?? 'Minecraft did not exit cleanly' })
      return await finish('passed')
    } finally {
      signal.removeEventListener('abort', onCancel)
      if (!launchAbort.signal.aborted && connection.activeRequests > 0) {
        // Never leave a test game running behind a failed or interrupted run.
        launchAbort.abort()
        await Promise.race([launchSettled, delay(10_000)])
      }
    }
  } catch (e) {
    if (signal.aborted) return await finish('cancelled')
    return await finish('start-failed', asError(e))
  } finally {
    prepareLog.end()
    harnessLog.end()
  }
}
