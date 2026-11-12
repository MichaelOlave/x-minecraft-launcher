import { z } from 'zod'
import { DevTestServiceKey, type StageDevInstanceOptions, type StageDevInstanceResult, type TestRunOutcome, type TestRunRecord } from '../../services/DevTestService'
import { CliExitCode, CommandExitError } from '../exitCodes'
import { defineCommand } from '../registry'
import { asSetupFailure, formatDuration, forwardDevProgress } from './shared'
import { describeStage } from './stage'

/** Exit status for each way a run can end. */
export const TEST_OUTCOME_EXIT_CODES: Record<TestRunOutcome, number> = {
  'running': CliExitCode.Failure,
  'passed': CliExitCode.Ok,
  'setup-failed': CliExitCode.SetupFailed,
  'start-failed': CliExitCode.StartFailed,
  'not-ready': CliExitCode.NotReady,
  'test-failed': CliExitCode.TestFailed,
  'unclean-exit': CliExitCode.UncleanExit,
  'cancelled': CliExitCode.Cancelled,
}

const OUTCOME_LABELS: Record<TestRunOutcome, string> = {
  'running': 'RUNNING',
  'passed': 'PASSED',
  'setup-failed': 'SETUP FAILED',
  'start-failed': 'MINECRAFT DID NOT START',
  'not-ready': 'MINECRAFT NEVER BECAME READY',
  'test-failed': 'TEST FAILED',
  'unclean-exit': 'MINECRAFT EXITED UNCLEANLY',
  'cancelled': 'CANCELLED',
}

/** Human summary of a run. */
export function describeTestRun(record: TestRunRecord): string[] {
  const took = record.endedAt ? ` in ${formatDuration(record.endedAt - record.createdAt)}` : ''
  const lines = [`Run ${record.runId} (${record.scenario}): ${OUTCOME_LABELS[record.outcome]}${took}`]
  if (record.error) lines.push(`  ${record.error.code}: ${record.error.message}`)
  for (const phase of record.phases) {
    const time = phase.startedAt && phase.endedAt ? ` ${formatDuration(phase.endedAt - phase.startedAt)}` : ''
    lines.push(`  ${phase.name.padEnd(6)} ${phase.status}${time}${phase.detail ? ` — ${phase.detail}` : ''}`)
  }
  for (const mod of record.stage?.localMods ?? []) {
    lines.push(`  local build ${mod.file} [${mod.modIds.join(', ')}]${mod.replaced.length ? ` replaced ${mod.replaced.map((r) => r.file).join(', ')}` : ' added'}`)
  }
  for (const check of record.harness?.checks ?? []) {
    lines.push(`  ${check.result.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
  }
  if (record.launch) lines.push(`  Launch ${record.launch.launchId} (pid ${record.launch.pid})`)
  lines.push(`  Evidence: ${record.runDir}${record.evidence ? ` (${record.evidence.length} files)` : ''}`)
  if (record.outcome !== 'running') lines.push(`  Share it: vardrynn test export ${record.runId}`)
  return lines
}

const UpdateSchema = z.record(z.string(), z.unknown())

export const beginTestRunCommand = defineCommand({
  id: 'test.begin',
  title: 'Begin Test Run',
  description: 'Internal: allocate a run ID for a terminal-driven test run.',
  category: 'dev',
  input: z.object({ scenario: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), pack: z.string().min(1), scenarioFile: z.string().min(1) }),
  async handler(input, ctx) {
    return ctx.call(DevTestServiceKey, 'beginTestRun', input)
  },
})

export const recordTestRunCommand = defineCommand({
  id: 'test.record',
  title: 'Record Test Run',
  description: 'Internal: save the progress of a test run.',
  category: 'dev',
  input: z.object({ runId: z.string().min(1), update: UpdateSchema }),
  async handler(input, ctx) {
    return ctx.call(DevTestServiceKey, 'recordTestRun', input.runId, input.update as Partial<TestRunRecord>)
  },
})

export const finishTestRunCommand = defineCommand({
  id: 'test.finish',
  title: 'Finish Test Run',
  description: 'Internal: save the final record of a test run and collect its evidence.',
  category: 'dev',
  input: z.object({ runId: z.string().min(1), update: UpdateSchema }),
  async handler(input, ctx) {
    return ctx.call(DevTestServiceKey, 'finishTestRun', input.runId, input.update as Partial<TestRunRecord>)
  },
})

export const stageForTestCommand = defineCommand({
  id: 'test.stage',
  title: 'Stage For Test Run',
  description: 'Internal: stage a disposable instance from a scenario\'s structured options.',
  category: 'dev',
  input: z.object({ options: z.record(z.string(), z.unknown()) }),
  async handler(input, ctx): Promise<StageDevInstanceResult> {
    const options = input.options as unknown as StageDevInstanceOptions
    const stop = await forwardDevProgress(ctx, options.name)
    let result: StageDevInstanceResult
    try {
      result = await ctx.call(DevTestServiceKey, 'stageDevInstance', { ...options, cwd: options.cwd ?? ctx.cwd })
    } catch (e) {
      throw asSetupFailure(e)
    } finally {
      stop()
    }
    for (const line of describeStage(result)) ctx.out.log(line)
    return result
  },
})

export const launchRecordPathCommand = defineCommand({
  id: 'test.launch-record',
  title: 'Launch Record Path',
  description: 'Internal: path of the launcher record of a launch.',
  category: 'dev',
  input: z.object({ instancePath: z.string().min(1), launchId: z.string().min(1) }),
  async handler(input, ctx) {
    return ctx.call(DevTestServiceKey, 'getLaunchRecordPath', input.instancePath, input.launchId)
  },
})

export const listTestRunsCommand = defineCommand({
  id: 'test.runs',
  title: 'List Test Runs',
  description: 'List recent test runs, newest first.',
  category: 'dev',
  input: z.object({ limit: z.number().int().positive().default(20) }),
  cli: {
    name: 'test runs',
    flags: { limit: { type: 'number', description: 'How many runs to list' } },
  },
  async handler(input, ctx) {
    const runs = await ctx.call(DevTestServiceKey, 'listTestRuns', input.limit)
    ctx.out.table(runs.map((r) => ({
      run: r.runId,
      scenario: r.scenario,
      outcome: r.outcome,
      started: new Date(r.createdAt).toISOString(),
      duration: r.endedAt ? formatDuration(r.endedAt - r.createdAt) : '',
    })))
    ctx.out.json({ ok: true, command: 'test.runs', data: runs })
    return runs
  },
})

export const showTestRunCommand = defineCommand({
  id: 'test.show',
  title: 'Show Test Run',
  description: 'Show the record of a test run.',
  category: 'dev',
  input: z.object({ runId: z.string().min(1) }),
  cli: { name: 'test show', positionals: ['runId'] },
  async handler(input, ctx) {
    const record = await ctx.call(DevTestServiceKey, 'getTestRun', input.runId)
    if (!record) throw new CommandExitError(CliExitCode.Failure, 'TestRunNotFound', `No test run ${input.runId}`)
    for (const line of describeTestRun(record)) ctx.out.log(line)
    ctx.out.json({ ok: true, command: 'test.show', data: record })
    return record
  },
})

export const exportTestRunCommand = defineCommand({
  id: 'test.export',
  title: 'Export Test Run',
  description: 'Zip a test run\'s evidence for sharing. Credentials are redacted from every text file and the home folder is shown as ~.',
  category: 'dev',
  input: z.object({ runId: z.string().min(1), out: z.string().min(1).optional() }),
  cli: {
    name: 'test export',
    positionals: ['runId'],
    flags: { out: { alias: 'o', description: 'Zip file to write (default: <run>.zip here)' } },
  },
  async handler(input, ctx) {
    let result
    try {
      result = await ctx.call(DevTestServiceKey, 'exportTestRun', input.runId, { out: input.out, cwd: ctx.cwd })
    } catch (e) {
      throw new CommandExitError(CliExitCode.Failure, (e as Error).name || 'ExportFailed', (e as Error).message)
    }
    ctx.out.log(`Wrote ${result.file} (${result.entries} files, ${result.redactions} credential value(s) redacted)`)
    ctx.out.json({ ok: true, command: 'test.export', data: result })
    return result
  },
})

export const RunTestScenarioInputSchema = z.object({
  /** Scenario name from the pack's vardrynn.tests.json. */
  scenario: z.string().min(1),
  /** Pack repository folder. Defaults to the nearest folder up from here with a vardrynn.tests.json. */
  pack: z.string().min(1).optional(),
  /** Extra local builds that replace instance mods with the same mod ID. */
  mod: z.array(z.string().min(1)).default([]),
  /** Extra local builds to install even if the pack lacks their mod ID. */
  addMod: z.array(z.string().min(1)).default([]),
  /** Launcher account to play with. */
  user: z.string().min(1).optional(),
  /** Keep the world from the last run instead of a fresh copy. */
  keepWorld: z.boolean().default(false),
})

export type RunTestScenarioInput = z.infer<typeof RunTestScenarioInputSchema>

/**
 * `test run` executes in the terminal process, which builds, runs the pack's
 * harness and calls the launcher for the rest. The launcher never runs
 * commands from a pack file.
 */
export const runTestScenarioCommand = defineCommand({
  id: 'test.run',
  title: 'Run Test Scenario',
  description: 'Build, stage, launch and test a scenario from the pack\'s vardrynn.tests.json, then report a run ID with its evidence. Exit status: 0 passed, 10 setup failed, 11 Minecraft did not start, 12 never became ready, 13 test failed, 14 unclean exit, 130 cancelled.',
  category: 'dev',
  input: RunTestScenarioInputSchema,
  cli: {
    name: 'test run',
    positionals: ['scenario'],
    flags: {
      pack: { description: 'Pack repository folder with vardrynn.tests.json' },
      mod: { multiple: true, description: 'Local build that replaces the mod with the same mod ID' },
      addMod: { multiple: true, description: 'Local build to install even if the pack lacks it' },
      user: { alias: 'u', description: 'Launcher account ID or name' },
      keepWorld: { type: 'boolean', description: 'Keep the world from the last run' },
    },
  },
  async handler() {
    throw new CommandExitError(CliExitCode.Usage, 'TerminalOnly', 'Test runs start from a terminal: Vardrynn test run <scenario>')
  },
})
