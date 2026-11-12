import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { redactArguments, redactEnv } from '../util/redactSecrets'

/** The settings a game process actually started with, as recorded in launch history. Credentials are redacted. */
export interface LaunchSettingsEvidence {
  side: 'client' | 'server'
  version: string
  minecraft?: string
  java: { path: string; version?: string; vendor?: string }
  memory: { minMB?: number; maxMB?: number }
  vmOptions: string[]
  mcOptions: string[]
  prependCommand?: string[]
  /** Only the variables the instance or launch added, not the launcher's whole environment. */
  env: Record<string, string>
  resolution?: { width?: number; height?: number; fullscreen?: boolean }
  world?: string
  server?: string
  /** The full command line, when it could be computed. */
  commandLine?: string[]
}

/** Read `JAVA_VERSION` and `IMPLEMENTOR` from the `release` file next to a JDK's `bin` folder. */
export async function readJavaRelease(javaPath: string): Promise<{ version?: string; vendor?: string }> {
  const release = await readFile(join(dirname(dirname(javaPath)), 'release'), 'utf8').catch(() => '')
  const value = (key: string) => release.match(new RegExp(`^${key}="?([^"\\n]*)"?`, 'm'))?.[1]
  return { version: value('JAVA_VERSION'), vendor: value('IMPLEMENTOR') }
}

export async function describeLaunchSettings(input: {
  side: 'client' | 'server'
  version: string
  minecraft?: string
  javaPath: string
  minMemory?: number
  maxMemory?: number
  vmOptions?: string[]
  mcOptions?: string[]
  prependCommand?: string[]
  env?: Record<string, string>
  resolution?: LaunchSettingsEvidence['resolution']
  world?: string
  server?: { host: string; port?: number }
  commandLine?: string[]
}): Promise<LaunchSettingsEvidence> {
  return {
    side: input.side,
    version: input.version,
    minecraft: input.minecraft,
    java: { path: input.javaPath, ...await readJavaRelease(input.javaPath) },
    memory: { minMB: input.minMemory, maxMB: input.maxMemory },
    vmOptions: redactArguments(input.vmOptions ?? []),
    mcOptions: redactArguments(input.mcOptions ?? []),
    prependCommand: input.prependCommand?.length ? redactArguments(input.prependCommand) : undefined,
    env: redactEnv(input.env ?? {}),
    resolution: input.resolution,
    world: input.world,
    server: input.server ? `${input.server.host}${input.server.port ? `:${input.server.port}` : ''}` : undefined,
    commandLine: input.commandLine ? redactArguments(input.commandLine) : undefined,
  }
}
