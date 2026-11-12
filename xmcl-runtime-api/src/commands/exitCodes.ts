/**
 * Process exit codes returned by the `vardrynn` command line. Scripts can
 * branch on them, so existing values must never change meaning.
 */
export const CliExitCode = {
  /** The command succeeded. A test run passed. */
  Ok: 0,
  /** The command failed. */
  Failure: 1,
  /** Unknown command, unknown flag or invalid input. */
  Usage: 2,
  /** A test run could not prepare its instance, mods or build. */
  SetupFailed: 10,
  /** Minecraft could not be installed or its process did not start. */
  StartFailed: 11,
  /** Minecraft started but never reached its window within the time limit. */
  NotReady: 12,
  /** The pack's test harness reported a failure, or did not report at all. */
  TestFailed: 13,
  /** Minecraft crashed or exited with a non-zero status. */
  UncleanExit: 14,
  /** No running Vardrynn answered and one could not be started. */
  LauncherUnavailable: 69,
  /** The command was cancelled from the terminal (Ctrl+C). */
  Cancelled: 130,
} as const

export type CliExitCodeValue = typeof CliExitCode[keyof typeof CliExitCode]

/**
 * Thrown by a command handler to fail with a specific exit code and error
 * code, instead of the generic failure status.
 */
export class CommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = code
  }
}
