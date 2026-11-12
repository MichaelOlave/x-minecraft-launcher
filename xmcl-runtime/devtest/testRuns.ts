import type { BeginTestRunOptions, TestRunRecord } from '@xmcl/runtime-api'
import { writeFile as writeAtomically } from 'atomically'
import { randomBytes } from 'crypto'
import { mkdir, readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,62}-\d{8}-\d{6}-[0-9a-f]{4}$/

export function createRunId(scenario: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${scenario}-${date}-${time}-${randomBytes(2).toString('hex')}`
}

export function isRunId(value: string) {
  return RUN_ID.test(value)
}

type RunUpdate = Partial<Omit<TestRunRecord, 'runId' | 'runDir' | 'createdAt'>>

/**
 * Test run records, one folder per run under the launcher's `test-runs`
 * folder. Runs are kept apart from launch history, so later launches never
 * overwrite their evidence; only the oldest runs beyond `maxRuns` are removed.
 */
export class TestRunStore {
  #queues = new Map<string, Promise<unknown>>()

  constructor(readonly root: string, private readonly maxRuns = 50) {}

  dir(runId: string) {
    if (!isRunId(runId)) throw Object.assign(new Error(`Invalid run ID: ${runId}`), { name: 'TestRunNotFound' })
    return join(this.root, runId)
  }

  #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.#queues.set(runId, next)
    const cleanup = () => { if (this.#queues.get(runId) === next) this.#queues.delete(runId) }
    void next.then(cleanup, cleanup)
    return next
  }

  async #write(record: TestRunRecord) {
    await writeAtomically(join(this.dir(record.runId), 'run.json'), JSON.stringify(record, undefined, 2))
  }

  async begin(options: BeginTestRunOptions & { launcherVersion: string }): Promise<TestRunRecord> {
    const runId = createRunId(options.scenario)
    const runDir = this.dir(runId)
    await mkdir(runDir, { recursive: true })
    const record: TestRunRecord = {
      runId,
      scenario: options.scenario,
      pack: options.pack,
      scenarioFile: options.scenarioFile,
      launcherVersion: options.launcherVersion,
      createdAt: Date.now(),
      outcome: 'running',
      phases: [],
      runDir,
    }
    await this.#write(record)
    await this.prune().catch(() => undefined)
    return record
  }

  update(runId: string, update: RunUpdate): Promise<TestRunRecord> {
    return this.#serialize(runId, async () => {
      const current = await this.get(runId)
      if (!current) throw Object.assign(new Error(`No test run ${runId}`), { name: 'TestRunNotFound' })
      const { runId: _id, runDir: _dir, createdAt: _created, ...allowed } = update as TestRunRecord
      const record: TestRunRecord = { ...current, ...allowed }
      await this.#write(record)
      return record
    })
  }

  async get(runId: string): Promise<TestRunRecord | undefined> {
    if (!isRunId(runId)) return undefined
    const raw = await readFile(join(this.dir(runId), 'run.json'), 'utf8').catch(() => '')
    if (!raw) return undefined
    try {
      const record = JSON.parse(raw) as TestRunRecord
      return record.runId === runId ? record : undefined
    } catch {
      return undefined
    }
  }

  async list(limit = 20): Promise<TestRunRecord[]> {
    const ids = (await readdir(this.root).catch(() => [] as string[])).filter(isRunId)
    const records = (await Promise.all(ids.map((id) => this.get(id)))).filter((r): r is TestRunRecord => !!r)
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  async prune() {
    const records = await this.list(Number.MAX_SAFE_INTEGER)
    await Promise.all(records.slice(this.maxRuns).map((r) => rm(this.dir(r.runId), { recursive: true, force: true })))
  }
}
