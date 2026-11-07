import type { InstanceFile, InstanceManifest } from '@xmcl/instance'
import { describe, expect, it } from 'vitest'
import { buildPackManifest, MAX_PACK_FILE_BYTES, PACK_SLUG, previewPackFiles } from './packManifest'

const sha = (c: string) => c.repeat(40)
const files: InstanceFile[] = [
  { path: 'mods/sodium.jar', hashes: { sha1: sha('a') }, size: 10, modrinth: { projectId: 'AANobbMI', versionId: 'v1' }, curseforge: { projectId: 1, fileId: 2 }, downloads: ['https://cdn.modrinth.com/a.jar'] },
  { path: 'mods/jei.jar', hashes: { sha1: sha('b') }, size: 20, curseforge: { projectId: 238222, fileId: 3 }, downloads: ['https://edge.forgecdn.net/b.jar', 'http://insecure.example/b.jar'] },
  { path: 'mods/blocked.jar', hashes: { sha1: sha('c') }, size: 30, curseforge: { projectId: 9, fileId: 4 } },
  { path: 'mods/linked.jar', hashes: { sha1: sha('d') }, size: 40, downloads: ['https://github.com/x/linked.jar'] },
  { path: 'mods/private.jar', hashes: { sha1: sha('e') }, size: 50 },
  { path: 'config/a.toml', hashes: { sha1: sha('f') }, size: 60 },
]

describe('previewPackFiles', () => {
  it('prefers Modrinth, flags restricted CurseForge files and unlisted mods, and totals uploads', () => {
    const preview = previewPackFiles(files, new Set([4]))
    expect(preview.files).toEqual([
      { path: 'mods/sodium.jar', source: 'modrinth', size: 10 },
      { path: 'mods/jei.jar', source: 'curseforge', size: 20 },
      { path: 'mods/blocked.jar', source: 'curseforge', size: 30, warning: 'curseforge-restricted' },
      { path: 'mods/linked.jar', source: 'link', size: 40 },
      { path: 'mods/private.jar', source: 'upload', size: 50, warning: 'unlisted-mod' },
      { path: 'config/a.toml', source: 'upload', size: 60 },
    ])
    expect(preview.uploadBytes).toBe(110)
    expect(preview.blocked).toBe(false)
  })

  it('blocks publishing when an upload is over the service limit', () => {
    const preview = previewPackFiles([{ path: 'big.zip', hashes: { sha1: sha('a') }, size: MAX_PACK_FILE_BYTES + 1 }], new Set())
    expect(preview.files[0].warning).toBe('too-large')
    expect(preview.blocked).toBe(true)
  })
})

describe('buildPackManifest', () => {
  it('keeps site references and https links, points uploads at the service, and drops personal settings', () => {
    const source: InstanceManifest = {
      name: 'My instance', maxMemory: 8192, vmOptions: ['-Xss2m'], runtime: { minecraft: '1.21.1', fabricLoader: '0.16.0' } as any, files,
    }
    const preview = previewPackFiles(files, new Set())
    const manifest = buildPackManifest(source, files, preview, { title: 'Folded', summary: 'Mixed' }, (s) => `https://api.example.com/v1/packs/files/${s}`)
    expect(manifest).toMatchObject({ name: 'Folded', description: 'Mixed', runtime: source.runtime })
    expect(manifest).not.toHaveProperty('maxMemory')
    expect(manifest).not.toHaveProperty('vmOptions')
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]))
    expect(byPath['mods/sodium.jar']).toMatchObject({ modrinth: { projectId: 'AANobbMI' }, curseforge: { fileId: 2 } })
    expect(byPath['mods/jei.jar'].downloads).toEqual(['https://edge.forgecdn.net/b.jar'])
    expect(byPath['mods/blocked.jar']).not.toHaveProperty('downloads')
    expect(byPath['mods/linked.jar']).toEqual({ path: 'mods/linked.jar', hashes: { sha1: sha('d') }, size: 40, downloads: ['https://github.com/x/linked.jar'] })
    expect(byPath['config/a.toml']).toEqual({ path: 'config/a.toml', hashes: { sha1: sha('f') }, size: 60, downloads: [`https://api.example.com/v1/packs/files/${sha('f')}`] })
  })
})

describe('PACK_SLUG', () => {
  it('matches the service rules', () => {
    expect(PACK_SLUG.test('folded-multiverse')).toBe(true)
    for (const bad of ['files', '-a', 'a-', 'A', 'a_b', '']) expect(PACK_SLUG.test(bad), bad).toBe(false)
  })
})
