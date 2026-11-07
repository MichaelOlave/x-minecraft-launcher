import { describe, expect, it } from 'vitest'
import type { VardrynnPackListItem } from '@xmcl/runtime-api'
import { filterVardrynnPacks, getVardrynnLoaderNames, getVardrynnPackMods } from './vardrynnPack'

const pack = (slug: string, minecraft: string, loaders: string[]): VardrynnPackListItem => ({
  slug, title: slug, summary: '', createdAt: '', updatedAt: '',
  latestVersion: { id: slug, version: '1.0.0', changelog: '', minecraft, loaders, publishedAt: '' },
})

describe('Vardrynn store helpers', () => {
  const packs = [pack('fabric', '1.20.1', ['fabricLoader']), pack('neo', '1.21.1', ['neoForged']), pack('vanilla', '1.21.1', [])]

  it('filters by Minecraft version and loader name', () => {
    expect(filterVardrynnPacks(packs, '', []).map((p) => p.slug)).toEqual(['fabric', 'neo', 'vanilla'])
    expect(filterVardrynnPacks(packs, '1.21.1', []).map((p) => p.slug)).toEqual(['neo', 'vanilla'])
    expect(filterVardrynnPacks(packs, '', ['fabric', 'quilt']).map((p) => p.slug)).toEqual(['fabric'])
    expect(filterVardrynnPacks(packs, '1.20.1', ['neoforge'])).toEqual([])
  })

  it('names loaders as the store does', () => {
    expect(getVardrynnLoaderNames(['fabricLoader', 'quiltLoader', 'forge', 'neoForged', 'other'])).toEqual(['fabric', 'quilt', 'forge', 'neoforge', 'other'])
  })

  it('lists mods with where they come from', () => {
    const sha1 = 'a'.repeat(40)
    expect(getVardrynnPackMods([
      { path: 'mods/sodium.jar', hashes: { sha1 }, modrinth: { projectId: 'AANobbMI', versionId: 'v' }, curseforge: { projectId: 1, fileId: 2 } },
      { path: 'mods/jei.jar', hashes: { sha1 }, curseforge: { projectId: 238222, fileId: 3 } },
      { path: 'mods/private.jar', hashes: { sha1 }, downloads: ['https://api.example.com/v1/packs/files/x'] },
      { path: 'config/a.toml', hashes: { sha1 }, downloads: ['https://api.example.com/v1/packs/files/y'] },
    ])).toEqual([
      { name: 'sodium.jar', source: 'modrinth', href: 'https://modrinth.com/project/AANobbMI' },
      { name: 'jei.jar', source: 'curseforge', href: 'https://www.curseforge.com/projects/238222' },
      { name: 'private.jar', source: 'vardrynn', href: '' },
    ])
  })
})
