import { CliExitCode, CommandExitError } from '../exitCodes'
import type { CommandContext } from '../types'
import { DevTestServiceKey } from '../../services/DevTestService'

/** Parse `FROM=TO`; the last `=` separates them, since instance paths rarely contain one. */
export function parseMapping(value: string) {
  const index = value.lastIndexOf('=')
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`Expected FROM=TO, got '${value}'`)
  }
  return { from: value.slice(0, index), to: value.slice(index + 1) }
}

/** Forward the dev service's progress for one instance to the command output. */
export async function forwardDevProgress(ctx: CommandContext, name: string) {
  if (!ctx.subscribe || !ctx.out.progress) return () => {}
  return ctx.subscribe(DevTestServiceKey, 'dev-progress', (e: { name: string; task: string; progress: number; total?: number; message?: string }) => {
    if (e.name === name) ctx.out.progress?.(e.task, e.progress, e.total, e.message)
  })
}

/** Service failures while preparing a test are setup failures. */
export function asSetupFailure(e: unknown): CommandExitError {
  if (e instanceof CommandExitError) return e
  const error = e as { name?: string; message?: string }
  return new CommandExitError(CliExitCode.SetupFailed, error?.name && error.name !== 'Error' ? error.name : 'SetupFailed', error?.message ?? String(e))
}

export function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`
}
