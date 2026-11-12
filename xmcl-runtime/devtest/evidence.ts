import { describeTestRun, type TestRunRecord } from '@xmcl/runtime-api'
import { createWriteStream, type WriteStream } from 'fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'fs/promises'
import { arch, cpus, freemem, homedir, platform, release, totalmem } from 'os'
import { dirname, join, relative, sep } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { format } from 'util'
import { ZipFile } from 'yazl'
import type { LogEmitter } from '~/app/LauncherApp'
import type { LaunchHistoryStore } from '~/launch/LaunchHistoryStore'
import { redactText } from '~/util/redactSecrets'
import { writeZipFile } from '~/util/zip'
import { readMarker } from './stage'

const MAX_CAPTURED_LOG = 32 * 1024 * 1024

/**
 * Copies the launcher's own log lines into a run folder while the run is
 * going, so the run keeps the launcher's side of the story even after the
 * launcher rotates its logs.
 */
export class LauncherLogCapture {
  #active = new Map<string, { stream: WriteStream; written: number; detach: () => void }>()

  constructor(private readonly emitter: LogEmitter) {}

  start(runId: string, file: string) {
    if (this.#active.has(runId)) return
    const stream = createWriteStream(file, { flags: 'a' })
    stream.on('error', () => this.stop(runId))
    const entry = { stream, written: 0, detach: () => {} }
    const write = (level: string, tag: string, text: string) => {
      if (entry.written > MAX_CAPTURED_LOG) return
      const line = `${new Date().toISOString()} [${level}] [${tag}] ${text}\n`
      entry.written += line.length
      stream.write(line)
    }
    const onInfo = (_d: string, tag: string, message: unknown, ...options: unknown[]) => write('INFO', tag, format(message, ...options))
    const onWarn = (_d: string, tag: string, message: unknown, ...options: unknown[]) => write('WARN', tag, format(message, ...options))
    const onFailure = (_d: string, tag: string, e: Error) => write('ERROR', tag, e?.stack ?? String(e))
    this.emitter.on('info', onInfo)
    this.emitter.on('warn', onWarn)
    this.emitter.on('failure', onFailure)
    entry.detach = () => {
      this.emitter.off('info', onInfo)
      this.emitter.off('warn', onWarn)
      this.emitter.off('failure', onFailure)
    }
    this.#active.set(runId, entry)
  }

  async stop(runId: string) {
    const entry = this.#active.get(runId)
    if (!entry) return
    this.#active.delete(runId)
    entry.detach()
    await new Promise<void>((resolve) => entry.stream.end(() => resolve()))
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  await walk(root)
  return out.sort()
}

const toRelative = (root: string, path: string) => relative(root, path).split(sep).join('/')

/**
 * Gather a finished run's evidence into its folder: the launch record and
 * settings, game and launcher logs, crash reports and JVM crash files
 * written during the run, the staged mod hashes and the machine details.
 * Copies are taken now, so later launches cannot overwrite them.
 */
export async function collectRunEvidence(record: TestRunRecord, launchHistory: LaunchHistoryStore, options: { waitForExitMs?: number } = {}): Promise<string[]> {
  const runDir = record.runDir
  const copy = async (from: string, rel: string) => {
    if (!(await lstat(from).catch(() => undefined))?.isFile()) return false
    await mkdir(dirname(join(runDir, rel)), { recursive: true })
    await copyFile(from, join(runDir, rel))
    return true
  }

  let settings: { java?: unknown } | undefined
  if (record.instance && record.launch?.launchId) {
    const instancePath = record.instance.path
    const { launchId } = record.launch
    // The launcher finishes its own record shortly after a stopped game exits.
    const deadline = Date.now() + (options.waitForExitMs ?? 20_000)
    while (Date.now() < deadline) {
      const launch = await launchHistory.get(instancePath, launchId).catch(() => undefined)
      if (!launch || launch.state === 'exited') break
      await delay(500)
    }
    const folder = launchHistory.getLaunchFolder(instancePath, launchId)
    await copy(join(folder, 'launch.json'), 'launch/launch.json')
    if (await copy(join(folder, 'launch-settings.json'), 'launch/launch-settings.json')) {
      settings = JSON.parse(await readFile(join(runDir, 'launch/launch-settings.json'), 'utf8').catch(() => '{}'))
    }
    let gameLog = false
    for (const name of ['game.log', 'debug.log', 'crash-report.txt', 'launcher-output.log']) {
      const copied = await copy(join(folder, name), `logs/${name}`)
      if (name === 'game.log') gameLog = copied
    }

    const from = record.launch.startedAt - 1000
    const until = (record.launch.endedAt ?? record.endedAt ?? Date.now()) + 60_000
    const within = async (path: string) => {
      const info = await stat(path).catch(() => undefined)
      return !!info && info.mtimeMs >= from && info.mtimeMs <= until
    }
    if (!gameLog && await within(join(instancePath, 'logs', 'latest.log'))) {
      await copy(join(instancePath, 'logs', 'latest.log'), 'logs/game.log')
    }
    for (const name of await readdir(join(instancePath, 'crash-reports')).catch(() => [] as string[])) {
      if (name.endsWith('.txt') && await within(join(instancePath, 'crash-reports', name))) {
        await copy(join(instancePath, 'crash-reports', name), `crash/${name}`)
      }
    }
    // JVM native crashes are written to the game folder as hs_err_pid<pid>.log.
    for (const name of await readdir(instancePath).catch(() => [] as string[])) {
      if (/^hs_err_pid\d+\.log$/.test(name) && (name === `hs_err_pid${record.launch.pid}.log` || await within(join(instancePath, name)))) {
        await copy(join(instancePath, name), `crash/${name}`)
      }
    }

    const marker = await readMarker(instancePath)
    if (marker) {
      await writeFile(join(runDir, 'mods.json'), JSON.stringify({
        pack: Object.fromEntries(Object.entries(marker.mods).map(([file, m]) => [file, m.sha256])),
        localBuilds: record.stage?.localMods ?? [],
        configChanges: record.stage?.overlays ?? [],
        copiedFromWorkingInstance: record.stage?.copied ?? [],
        lock: record.stage?.lock,
      }, undefined, 2))
    }
  }

  await writeFile(join(runDir, 'environment.json'), JSON.stringify({
    launcherVersion: record.launcherVersion,
    os: { platform: platform(), release: release(), arch: arch() },
    cpus: cpus().length,
    memoryMB: { total: Math.round(totalmem() / 1048576), free: Math.round(freemem() / 1048576) },
    java: settings?.java,
  }, undefined, 2))
  await writeFile(join(runDir, 'summary.txt'), `${describeTestRun(record).join('\n')}\n`)

  return (await listFiles(runDir)).map((f) => toRelative(runDir, f)).filter((f) => f !== 'run.json')
}

const TEXT_EXTENSIONS = /\.(log|txt|json|toml|cfg|conf|properties|md|csv|xml|yml|yaml|js|mcmeta|snbt)$/i

async function isText(path: string, size: number) {
  if (TEXT_EXTENSIONS.test(path)) return true
  if (size > 8 * 1024 * 1024) return false
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, 8192))
    await handle.read(buffer, 0, buffer.length, 0)
    return !buffer.includes(0)
  } finally {
    await handle.close()
  }
}

export interface RunExport {
  file: string
  entries: number
  redactions: number
}

/**
 * Zip a run folder for sharing. Every text file is passed through credential
 * redaction, and the home folder becomes `~`. Binary files such as
 * screenshots are included unchanged.
 */
export async function exportRunArchive(runDir: string, runId: string, outFile: string): Promise<RunExport> {
  const zip = new ZipFile()
  let redactions = 0
  const files = await listFiles(runDir)
  for (const file of files) {
    const info = await stat(file)
    const name = `${runId}/${toRelative(runDir, file)}`
    if (await isText(file, info.size)) {
      const result = redactText(await readFile(file, 'utf8'), { home: homedir() })
      redactions += result.count
      zip.addBuffer(Buffer.from(result.text, 'utf8'), name, { mtime: info.mtime })
    } else {
      zip.addFile(file, name)
    }
  }
  zip.end()
  await writeZipFile(zip, outFile)
  return { file: outFile, entries: files.length, redactions }
}
