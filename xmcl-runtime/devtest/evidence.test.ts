import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { openFileSystem } from '@xmcl/system'
import type { TestRunRecord } from '@xmcl/runtime-api'
import { LaunchHistoryStore } from '../launch/LaunchHistoryStore'
import { describeLaunchSettings, readJavaRelease } from '../launch/launchSettings'
import { REDACTED, redactArguments, redactEnv, redactText } from '../util/redactSecrets'
import { LauncherLogCapture, collectRunEvidence, exportRunArchive } from './evidence'
import { writeMarker } from './stage'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vevidence-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ4dWlkIjoiMjUzNTQwNTI0MjkzMjk5NCJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU'

describe('redaction', () => {
  test('redacts credential arguments but keeps the command line shape', () => {
    expect(redactArguments(['-Xmx4G', '--username', 'Steve', '--accessToken', 'abc', '--xuid', '123', '-Dmy.api.token=xyz', '--width', '1280']))
      .toEqual(['-Xmx4G', '--username', 'Steve', '--accessToken', REDACTED, '--xuid', REDACTED, `-Dmy.api.token=${REDACTED}`, '--width', '1280'])
  })

  test('redacts sensitive environment variables', () => {
    expect(redactEnv({ JAVA_HOME: '/jdk', GITHUB_TOKEN: 'x', DB_PASSWORD: 'y', MY_SECRET: 'z' }))
      .toEqual({ JAVA_HOME: '/jdk', GITHUB_TOKEN: REDACTED, DB_PASSWORD: REDACTED, MY_SECRET: REDACTED })
  })

  test('redacts tokens in logs and replaces the home folder', () => {
    const text = [
      `java -cp x net.minecraft.client.main.Main --accessToken ${jwt} --version 1.21.1`,
      `{"accessToken": "plain-token-value", "name": "Steve"}`,
      'Authorization: Bearer abc.def.ghi',
      'Session ID is token:secretvalue:uuid',
      'GITHUB_TOKEN=ghp_abcdef PATH=/usr/bin',
      `Loading ${homedir()}/.vardrynn/instances/x`,
      'exact-secret-12345 appears here',
    ].join('\n')
    const result = redactText(text, { home: homedir(), secrets: ['exact-secret-12345'] })
    expect(result.text).not.toContain(jwt)
    expect(result.text).not.toContain('plain-token-value')
    expect(result.text).not.toContain('abc.def.ghi')
    expect(result.text).not.toContain('secretvalue')
    expect(result.text).not.toContain('ghp_abcdef')
    expect(result.text).not.toContain('exact-secret-12345')
    expect(result.text).not.toContain(homedir())
    expect(result.text).toContain('~/.vardrynn/instances/x')
    expect(result.text).toContain('--version 1.21.1')
    expect(result.text).toContain('PATH=/usr/bin')
    expect(result.count).toBeGreaterThanOrEqual(6)
  })

  test('leaves ordinary text alone', () => {
    const text = '[Render thread/INFO]: Loaded 466 mods\nResource reload complete.'
    expect(redactText(text)).toEqual({ text, count: 0 })
  })
})

describe('launch settings', () => {
  test('reads the JDK release file and redacts the command line', async () => {
    const java = join(root, 'jdk', 'bin', 'java')
    await mkdir(join(root, 'jdk', 'bin'), { recursive: true })
    await writeFile(join(root, 'jdk', 'release'), 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.5"\n')
    expect(await readJavaRelease(java)).toEqual({ version: '21.0.5', vendor: 'Eclipse Adoptium' })
    const settings = await describeLaunchSettings({
      side: 'client',
      version: 'neoforge-21.1.265',
      javaPath: java,
      minMemory: 512,
      maxMemory: 16384,
      vmOptions: ['-Dveil.debug=true'],
      env: { SECRET_TOKEN: 'x', LANG: 'en' },
      world: 'Veil Development',
      commandLine: [java, '-Xmx16384M', '--accessToken', 'tok'],
    })
    expect(settings).toMatchObject({
      java: { path: java, version: '21.0.5' },
      memory: { minMB: 512, maxMB: 16384 },
      vmOptions: ['-Dveil.debug=true'],
      env: { SECRET_TOKEN: REDACTED, LANG: 'en' },
      world: 'Veil Development',
      commandLine: [java, '-Xmx16384M', '--accessToken', REDACTED],
    })
  })

  test('are stored with the launch record', async () => {
    const store = new LaunchHistoryStore(join(root, 'history'))
    const launchId = '11111111-1111-4111-8111-111111111111'
    await store.begin('/inst', { launchId, operationId: 'op', pid: 1, side: 'client', version: 'v', minecraft: '1.21.1', startedAt: Date.now() })
    await store.writeSettings('/inst', launchId, { memory: { maxMB: 4096 } })
    expect(await store.readSettings('/inst', launchId)).toEqual({ memory: { maxMB: 4096 } })
    expect(store.getRecordPath('/inst', launchId)).toBe(join(store.getLaunchFolder('/inst', launchId), 'launch.json'))
  })
})

describe('collectRunEvidence', () => {
  test('keeps copies of the run logs, crash files and mod hashes', async () => {
    const instance = join(root, 'Instance')
    const runDir = join(root, 'runs', 'veil-reload-20261112-000000-abcd')
    await mkdir(join(instance, 'crash-reports'), { recursive: true })
    await mkdir(join(instance, 'logs'), { recursive: true })
    await mkdir(runDir, { recursive: true })
    const startedAt = Date.now() - 5000
    const launchId = '22222222-2222-4222-8222-222222222222'
    const store = new LaunchHistoryStore(join(root, 'history'))
    await store.begin(instance, { launchId, operationId: 'op', pid: 4242, side: 'client', version: 'v', minecraft: '1.21.1', startedAt })
    await store.writeSettings(instance, launchId, { java: { version: '21.0.5' } })
    await writeFile(join(instance, 'logs', 'latest.log'), 'game log')
    await writeFile(join(instance, 'crash-reports', 'crash-new.txt'), 'new crash')
    await writeFile(join(instance, 'crash-reports', 'crash-old.txt'), 'old crash')
    const old = new Date(startedAt - 3_600_000)
    await utimes(join(instance, 'crash-reports', 'crash-old.txt'), old, old)
    await writeFile(join(instance, 'hs_err_pid4242.log'), 'SIGSEGV')
    await store.complete(instance, launchId, { endedAt: Date.now(), exitCode: 1, crashed: true, gameLogPath: join(instance, 'logs', 'latest.log'), launcherOutput: 'out', gameLogAmbiguous: false })
    await writeMarker(instance, { version: 1, name: 'Instance', source: '/w', createdAt: 0, mods: { 'a.jar': { sha256: 'a'.repeat(64), size: 1, mtimeMs: 1 } } })
    await writeFile(join(runDir, 'harness.log'), 'PASS preview on')

    const record: TestRunRecord = {
      runId: 'veil-reload-20261112-000000-abcd', scenario: 'veil-reload', pack: '/p', scenarioFile: '/p/f', launcherVersion: '1.3.1',
      createdAt: startedAt - 1000, endedAt: Date.now(), outcome: 'unclean-exit', phases: [], runDir,
      instance: { name: 'Instance', path: instance },
      launch: { launchId, pid: 4242, startedAt, endedAt: Date.now() },
    }
    const evidence = await collectRunEvidence(record, store, { waitForExitMs: 0 })
    expect(evidence).toEqual(expect.arrayContaining([
      'launch/launch.json', 'launch/launch-settings.json', 'logs/game.log', 'logs/launcher-output.log',
      'crash/crash-new.txt', 'crash/hs_err_pid4242.log', 'mods.json', 'environment.json', 'summary.txt', 'harness.log',
    ]))
    expect(evidence).not.toContain('crash/crash-old.txt')
    expect(JSON.parse(await readFile(join(runDir, 'mods.json'), 'utf8')).pack).toEqual({ 'a.jar': 'a'.repeat(64) })
    expect(JSON.parse(await readFile(join(runDir, 'environment.json'), 'utf8')).java).toEqual({ version: '21.0.5' })
    expect(await readFile(join(runDir, 'summary.txt'), 'utf8')).toContain('MINECRAFT EXITED UNCLEANLY')
  })
})

describe('exportRunArchive', () => {
  test('zips the run with credentials redacted and binaries intact', async () => {
    const runDir = join(root, 'run')
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await writeFile(join(runDir, 'logs', 'launcher-output.log'), `--accessToken ${jwt} --version 1`)
    await writeFile(join(runDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    const out = join(root, 'out', 'run.zip')
    const result = await exportRunArchive(runDir, 'veil-reload-x', out)
    expect(result).toMatchObject({ file: out, entries: 2 })
    expect(result.redactions).toBeGreaterThan(0)
    const zip = await openFileSystem(out)
    try {
      const log = await zip.readFile('veil-reload-x/logs/launcher-output.log', 'utf-8')
      expect(log).not.toContain(jwt)
      expect(log).toContain(REDACTED)
      expect([...await zip.readFile('veil-reload-x/shot.png')]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    } finally {
      zip.close()
    }
  })
})

describe('LauncherLogCapture', () => {
  test('records launcher log lines while a run is open', async () => {
    const emitter = new EventEmitter() as any
    const capture = new LauncherLogCapture(emitter)
    const file = join(root, 'launcher.log')
    capture.start('run', file)
    emitter.emit('info', 'main', 'LaunchService', 'Minecraft exit: %d', 0)
    emitter.emit('warn', 'main', 'DevTestService', 'careful')
    emitter.emit('failure', 'main', 'App', new Error('boom'))
    await capture.stop('run')
    emitter.emit('info', 'main', 'App', 'after the run')
    const text = await readFile(file, 'utf8')
    expect(text).toMatch(/\[INFO\] \[LaunchService\] Minecraft exit: 0/)
    expect(text).toMatch(/\[WARN\] \[DevTestService\] careful/)
    expect(text).toContain('Error: boom')
    expect(text).not.toContain('after the run')
    expect(emitter.listenerCount('info')).toBe(0)
  })
})
