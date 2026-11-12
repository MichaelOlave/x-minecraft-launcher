import { CliExitCode, ParsedCli, commands, parseCli, registerBuiltinCommands } from '@xmcl/runtime-api'
import { ClientCommand, getCliSocketPath, getCliTokenPath, runCliClient } from '@xmcl/runtime/commands'
import { LAUNCHER_NAME } from '@xmcl/runtime/constant'
import { spawn } from 'child_process'
import { app } from 'electron'
import { join } from 'path'

/**
 * Returns the parsed command line when this process was started as a
 * terminal command (`Vardrynn launch ...`, `Vardrynn --help`), or `undefined`
 * for a normal launcher start.
 */
export function detectCliInvocation(argv: string[]): ParsedCli | undefined {
  registerBuiltinCommands()
  const parsed = parseCli(argv, commands)
  return parsed.kind === 'none' ? undefined : parsed
}

/**
 * Start the launcher itself in the background, detached from this terminal.
 * In development `electron` needs the bundle path; a packaged app does not.
 */
function startLauncher(noWindow: boolean) {
  const executable = process.env.APPIMAGE || process.execPath
  const args = process.defaultApp ? [__filename] : []
  if (noWindow) args.push('--no-window')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env, windowsHide: false })
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', () => resolve(null))
  })
  child.unref()
  return { exited }
}

/**
 * Run a terminal command against the launcher that is already open (starting
 * one in the background if needed), print its output and exit with its status.
 * This process never becomes the launcher.
 */
export async function runCliEntry(parsed: ParsedCli, clientCommands: Record<string, ClientCommand> = {}): Promise<never> {
  app.dock?.hide()
  const appDataPath = join(app.getPath('appData'), LAUNCHER_NAME)
  const controller = new AbortController()
  let interrupts = 0
  const interrupt = () => {
    interrupts++
    if (interrupts > 1) app.exit(CliExitCode.Cancelled)
    controller.abort()
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)

  let code: number
  try {
    code = await runCliClient({
      argv: process.argv,
      parsed,
      registry: commands,
      version: app.getVersion(),
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: !!process.stderr.isTTY,
      signal: controller.signal,
      socketPath: getCliSocketPath(appDataPath),
      tokenPath: getCliTokenPath(appDataPath),
      startLauncher: () => startLauncher(parsed.globals.noWindow),
      clientCommands,
    })
  } catch (e) {
    process.stderr.write(`${(e as Error)?.stack ?? e}\n`)
    code = CliExitCode.Failure
  }
  // Let buffered output reach a pipe before the process ends.
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ])
  app.exit(code)
  return new Promise<never>(() => {})
}
