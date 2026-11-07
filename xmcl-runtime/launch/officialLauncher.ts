import { createHash } from 'crypto'
import { posix, win32 } from 'path'

/**
 * Hands an instance to Mojang's official launcher, like the old CurseForge app did:
 * write a profile into launcher_profiles.json in Vardrynn's game folder, then start the
 * launcher with `--workDir` pointing there so it uses the versions and libraries Vardrynn installed.
 *
 * Only the classic launcher accepts `--workDir`. The Microsoft Store / Xbox app build ignores
 * command-line options, so it is never a candidate.
 */

/** Where the classic launcher installs, most likely first. */
export function officialLauncherCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter((v): v is string => !!v)
    return [
      ...roots.map(root => win32.join(root, 'Minecraft Launcher', 'MinecraftLauncher.exe')),
      // CurseForge keeps its own copy of the classic launcher.
      win32.join(home, 'curseforge', 'minecraft', 'Install', 'minecraft.exe'),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Minecraft.app/Contents/MacOS/launcher',
      posix.join(home, 'Applications', 'Minecraft.app', 'Contents', 'MacOS', 'launcher'),
      posix.join(home, 'Documents', 'curseforge', 'minecraft', 'Install', 'Minecraft.app', 'Contents', 'MacOS', 'launcher'),
    ]
  }
  if (platform === 'linux') {
    return [
      '/usr/bin/minecraft-launcher',
      '/usr/local/bin/minecraft-launcher',
      '/opt/minecraft-launcher/minecraft-launcher',
      posix.join(home, '.local', 'bin', 'minecraft-launcher'),
    ]
  }
  return []
}

export async function findOfficialLauncher(candidates: string[], exists: (path: string) => Promise<boolean>) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/** Stable profile key, so relaunching an instance updates its profile instead of adding another. */
export function officialProfileKey(instancePath: string) {
  return `vardrynn-${createHash('sha1').update(instancePath).digest('hex').slice(0, 16)}`
}

/**
 * Memory flags for the profile. Only -Xmx is set: the launcher's default max heap is 2 GB,
 * so passing Vardrynn's automatic -Xms alone could exceed it and stop the JVM from starting.
 */
export function officialJavaArgs(minMemory?: number, maxMemory?: number, vmOptions: string[] = []) {
  const args: string[] = []
  const xmx = maxMemory || (minMemory ? Math.max(minMemory, 2048) : undefined)
  if (xmx) args.push(`-Xmx${xmx}M`)
  args.push(...vmOptions.filter(v => !!v && !/^-Xm[sx]/.test(v)))
  return args.length ? args.join(' ') : undefined
}

export interface OfficialProfileInput {
  instancePath: string
  name: string
  versionId: string
  icon?: string
  javaArgs?: string
  resolution?: { width?: number; height?: number }
  now: Date
}

/** Adds or updates the instance's profile, keeping everything else the launcher stored in the file. */
export function upsertOfficialProfile(existing: unknown, input: OfficialProfileInput) {
  const file: Record<string, any> = isObject(existing) ? { ...existing } : {}
  const profiles: Record<string, any> = isObject(file.profiles) ? { ...file.profiles } : {}
  const key = officialProfileKey(input.instancePath)
  const previous: Record<string, any> = isObject(profiles[key]) ? profiles[key] : {}
  const now = input.now.toISOString()

  const profile: Record<string, unknown> = {
    ...previous,
    name: input.name,
    type: 'custom',
    created: typeof previous.created === 'string' ? previous.created : now,
    // The launcher opens on the most recently used profile, so this selects the pack.
    lastUsed: now,
    lastVersionId: input.versionId,
    gameDir: input.instancePath,
    icon: input.icon || (typeof previous.icon === 'string' ? previous.icon : 'Furnace'),
  }
  if (input.javaArgs) profile.javaArgs = input.javaArgs
  else delete profile.javaArgs
  if (input.resolution?.width && input.resolution?.height) {
    profile.resolution = { width: input.resolution.width, height: input.resolution.height }
  } else {
    delete profile.resolution
  }

  profiles[key] = profile
  file.profiles = profiles
  if (!isObject(file.settings)) file.settings = {}
  if (typeof file.version !== 'number') file.version = 3
  return file
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
