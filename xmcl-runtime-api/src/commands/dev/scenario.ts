import { z } from 'zod'

/** The file a pack repository keeps its test scenarios in, at its root. */
export const TEST_SCENARIO_FILE = 'vardrynn.tests.json'

/** A command and its arguments, run without a shell. `${VARDRYNN_*}` in an argument is replaced by that variable. */
const CommandLineSchema = z.array(z.string().min(1)).min(1)

const LocalModSchema = z.object({
  path: z.string().min(1),
  add: z.boolean().optional(),
  modId: z.string().min(1).optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  sha512: z.string().regex(/^[0-9a-fA-F]{128}$/).optional(),
}).strict()

/** Paths in a scenario are relative to the pack repository unless absolute. */
export const TestScenarioSchema = z.object({
  description: z.string().optional(),
  /** How to build the disposable instance. Same fields as `dev stage`. */
  stage: z.object({
    source: z.string().min(1),
    name: z.string().min(1),
    lock: z.object({ file: z.string().min(1), extra: z.array(z.string().min(1)).optional() }).strict().optional(),
    exclude: z.array(z.string().min(1)).optional(),
    copyOnce: z.array(z.string().min(1)).optional(),
    fresh: z.boolean().optional(),
    overlays: z.array(z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      mode: z.enum(['merge', 'replace']).optional(),
    }).strict()).optional(),
    world: z.object({
      from: z.string().min(1),
      name: z.string().min(1).optional(),
      reset: z.boolean().optional(),
    }).strict().optional(),
    mods: z.array(LocalModSchema).optional(),
  }).strict(),
  /** Commands run in the pack folder before staging, such as a Gradle build. */
  prepare: z.array(CommandLineSchema).default([]),
  /** Commands run after staging, with `VARDRYNN_INSTANCE` set to the staged instance. */
  afterStage: z.array(CommandLineSchema).default([]),
  /** Settings for this launch only. */
  launch: z.object({
    user: z.string().min(1).optional(),
    world: z.string().min(1).optional(),
    vmOptions: z.array(z.string().min(1)).optional(),
    /** Use only `vmOptions`, not the instance's own JVM options. */
    replaceVmOptions: z.boolean().optional(),
    mcOptions: z.array(z.string().min(1)).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
    minMemory: z.number().int().positive().optional(),
    maxMemory: z.number().int().positive().optional(),
    resolution: z.string().regex(/^\d+x\d+$/).optional(),
  }).strict().prefault({}),
  /**
   * The pack's test harness, started once the game window is ready. It
   * reports by writing `{"result": "PASS" | "FAIL", "checks": [...]}` to the
   * file in `VARDRYNN_RESULT`; without that file its exit status decides.
   * Without a harness, a run passes when the game reaches its window and
   * exits cleanly.
   */
  harness: z.object({
    command: CommandLineSchema,
    /** Seconds the harness may run. */
    timeout: z.number().positive().default(1200),
  }).strict().optional(),
  /** After the harness finishes: wait for the game to exit on its own, or stop it. */
  afterHarness: z.enum(['wait-for-exit', 'stop-game']).default('wait-for-exit'),
  timeouts: z.object({
    /** Seconds from process start to the game window. */
    ready: z.number().positive().default(600),
    /** Seconds to wait for the game to exit once the test is done. */
    exit: z.number().positive().default(180),
  }).strict().prefault({}),
}).strict()

export const TestScenarioFileSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  scenarios: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Scenario names use lowercase letters, digits and dashes'), TestScenarioSchema),
}).strict()

export type TestScenario = z.infer<typeof TestScenarioSchema>
export type TestScenarioFile = z.infer<typeof TestScenarioFileSchema>
