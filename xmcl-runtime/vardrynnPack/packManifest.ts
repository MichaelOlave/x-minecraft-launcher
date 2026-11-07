import type { InstanceFile, InstanceManifest } from '@xmcl/instance'
import type { VardrynnPackFilePreview, VardrynnPackPreview } from '@xmcl/runtime-api'

/** The service's upload limit (`MAX_FILE_BYTES` in vardrynn-service/packs.js). */
export const MAX_PACK_FILE_BYTES = 50 * 1024 * 1024

export const PACK_SLUG = /^(?!files$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export const PACK_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/

const httpsLinks = (file: InstanceFile) => (file.downloads ?? []).filter((url) => url.startsWith('https://'))

/**
 * Decides where players will get each file. Modrinth is preferred when a file is on both sites,
 * since CurseForge authors can block downloads by other apps.
 */
export function previewPackFiles(files: InstanceFile[], restrictedCurseforgeFiles: Set<number>): VardrynnPackPreview {
  const previews = files.map((file): VardrynnPackFilePreview => {
    const size = file.size ?? 0
    if (file.modrinth) return { path: file.path, source: 'modrinth', size }
    if (file.curseforge) {
      return restrictedCurseforgeFiles.has(file.curseforge.fileId)
        ? { path: file.path, source: 'curseforge', size, warning: 'curseforge-restricted' }
        : { path: file.path, source: 'curseforge', size }
    }
    if (httpsLinks(file).length) return { path: file.path, source: 'link', size }
    if (size > MAX_PACK_FILE_BYTES) return { path: file.path, source: 'upload', size, warning: 'too-large' }
    if (/^mods\/.*\.jar$/i.test(file.path)) return { path: file.path, source: 'upload', size, warning: 'unlisted-mod' }
    return { path: file.path, source: 'upload', size }
  })
  return {
    files: previews,
    uploadBytes: previews.filter((f) => f.source === 'upload').reduce((sum, f) => sum + f.size, 0),
    blocked: previews.some((f) => f.warning === 'too-large'),
  }
}

/**
 * Builds the manifest a pack version publishes. Only the pack's own name and description travel
 * with it; memory and JVM options stay with the publisher's instance.
 */
export function buildPackManifest(
  source: InstanceManifest,
  files: InstanceFile[],
  preview: VardrynnPackPreview,
  meta: { title: string; summary: string },
  fileUrl: (sha1: string) => string,
): InstanceManifest {
  const sources = new Map(preview.files.map((f) => [f.path, f.source]))
  return {
    name: meta.title,
    description: meta.summary,
    runtime: source.runtime,
    files: files.map((file): InstanceFile => {
      const base: InstanceFile = { path: file.path, hashes: { ...file.hashes } }
      if (file.size !== undefined) base.size = file.size
      const links = httpsLinks(file)
      switch (sources.get(file.path)) {
        case 'modrinth':
        case 'curseforge':
          return {
            ...base,
            ...(file.modrinth ? { modrinth: file.modrinth } : {}),
            ...(file.curseforge ? { curseforge: file.curseforge } : {}),
            ...(links.length ? { downloads: links } : {}),
          }
        case 'link':
          return { ...base, downloads: links }
        default:
          return { ...base, downloads: [fileUrl(file.hashes.sha1)] }
      }
    }),
  }
}
