import { describe, expect, it } from 'vitest'
import { findOfficialLauncher, officialJavaArgs, officialLauncherCandidates, officialProfileKey, upsertOfficialProfile } from './officialLauncher'

const now = new Date('2026-11-07T12:00:00.000Z')
const input = { instancePath: '/data/instances/Pack', name: 'Pack', versionId: 'neoforge-21.1.77', now }

describe('officialLauncherCandidates', () => {
  it('lists the classic Windows installs and CurseForge copy', () => {
    const paths = officialLauncherCandidates('win32', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' }, 'C:\\Users\\me')
    expect(paths).toEqual([
      'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
      'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe',
      'C:\\Users\\me\\curseforge\\minecraft\\Install\\minecraft.exe',
    ])
  })

  it('lists the macOS app bundles', () => {
    expect(officialLauncherCandidates('darwin', {}, '/Users/me')).toContain('/Applications/Minecraft.app/Contents/MacOS/launcher')
  })

  it('has nothing for unsupported platforms', () => {
    expect(officialLauncherCandidates('aix', {}, '/home/me')).toEqual([])
  })
})

describe('findOfficialLauncher', () => {
  it('returns the first path that exists', async () => {
    const found = await findOfficialLauncher(['/a', '/b', '/c'], async p => p !== '/a')
    expect(found).toBe('/b')
  })

  it('returns undefined when none exist', async () => {
    expect(await findOfficialLauncher(['/a'], async () => false)).toBeUndefined()
  })
})

describe('officialJavaArgs', () => {
  it('uses the max memory', () => {
    expect(officialJavaArgs(1024, 6144)).toBe('-Xmx6144M')
  })

  it('raises an automatic minimum to at least the launcher default heap', () => {
    expect(officialJavaArgs(1024, undefined)).toBe('-Xmx2048M')
    expect(officialJavaArgs(4096, undefined)).toBe('-Xmx4096M')
  })

  it('keeps extra JVM options but drops conflicting heap flags', () => {
    expect(officialJavaArgs(undefined, 4096, ['-Xms8G', '-XX:+UseG1GC', ''])).toBe('-Xmx4096M -XX:+UseG1GC')
  })

  it('leaves the launcher defaults alone when nothing is set', () => {
    expect(officialJavaArgs(undefined, undefined, [])).toBeUndefined()
  })
})

describe('upsertOfficialProfile', () => {
  it('creates a selected custom profile for a missing file', () => {
    const file = upsertOfficialProfile(undefined, { ...input, javaArgs: '-Xmx4096M', resolution: { width: 1280, height: 720 } })
    expect(file.profiles[officialProfileKey(input.instancePath)]).toEqual({
      name: 'Pack',
      type: 'custom',
      created: now.toISOString(),
      lastUsed: now.toISOString(),
      lastVersionId: 'neoforge-21.1.77',
      gameDir: '/data/instances/Pack',
      icon: 'Furnace',
      javaArgs: '-Xmx4096M',
      resolution: { width: 1280, height: 720 },
    })
    expect(file.settings).toEqual({})
    expect(file.version).toBe(3)
  })

  it('keeps other profiles, settings and the original created time', () => {
    const key = officialProfileKey(input.instancePath)
    const existing = {
      profiles: {
        vanilla: { name: 'vanilla', type: 'latest-release' },
        [key]: { name: 'Old', created: '2020-01-01T00:00:00.000Z', javaArgs: '-Xmx1G', icon: 'Grass', javaDir: '/java' },
      },
      settings: { keepLauncherOpen: true },
      version: 6,
    }
    const file = upsertOfficialProfile(existing, input)
    expect(file.profiles.vanilla).toEqual(existing.profiles.vanilla)
    expect(file.profiles[key]).toMatchObject({ name: 'Pack', created: '2020-01-01T00:00:00.000Z', icon: 'Grass', javaDir: '/java' })
    expect(file.profiles[key].javaArgs).toBeUndefined()
    expect(file.settings).toEqual({ keepLauncherOpen: true })
    expect(file.version).toBe(6)
    expect(existing.profiles[key].name).toBe('Old')
  })

  it('replaces an unreadable file', () => {
    const file = upsertOfficialProfile('not json', input)
    expect(Object.keys(file.profiles)).toEqual([officialProfileKey(input.instancePath)])
  })

  it('gives each instance its own profile', () => {
    expect(officialProfileKey('/a')).not.toBe(officialProfileKey('/b'))
    expect(officialProfileKey('/a')).toBe(officialProfileKey('/a'))
  })
})
