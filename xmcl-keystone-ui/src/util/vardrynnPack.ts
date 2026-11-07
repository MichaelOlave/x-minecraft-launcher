import type { InstanceFile } from '@xmcl/instance'
import type { VardrynnPackListItem } from '@xmcl/runtime-api'

/** Runtime keys used by the service (`loaders`) and the loader names the store filters use. */
const LOADER_NAMES: Record<string, string> = {
  fabricLoader: 'fabric',
  quiltLoader: 'quilt',
  forge: 'forge',
  neoForged: 'neoforge',
}

export function getVardrynnLoaderNames(loaders: string[]) {
  return loaders.map((loader) => LOADER_NAMES[loader] ?? loader)
}

/** Keeps packs whose newest version matches the store's Minecraft version and loader filters. */
export function filterVardrynnPacks(packs: VardrynnPackListItem[], gameVersion: string, modLoaders: string[]) {
  return packs.filter((pack) => {
    if (gameVersion && pack.latestVersion.minecraft !== gameVersion) return false
    if (!modLoaders.length) return true
    const loaders = getVardrynnLoaderNames(pack.latestVersion.loaders)
    return modLoaders.some((loader) => loaders.includes(loader))
  })
}

/** The files a pack lists under `mods/`, with the site each one comes from. */
export function getVardrynnPackMods(files: InstanceFile[]) {
  return files
    .filter((file) => file.path.startsWith('mods/'))
    .map((file) => ({
      name: file.path.slice('mods/'.length),
      href: file.modrinth
        ? `https://modrinth.com/project/${file.modrinth.projectId}`
        : file.curseforge
          ? `https://www.curseforge.com/projects/${file.curseforge.projectId}`
          : '',
      source: file.modrinth ? 'modrinth' : file.curseforge ? 'curseforge' : 'vardrynn',
    }))
}
