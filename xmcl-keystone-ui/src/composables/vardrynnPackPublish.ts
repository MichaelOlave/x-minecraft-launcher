import type { DialogKey } from './dialog'

export interface VardrynnPackPublishDialogOptions {
  instancePath: string
  /** Instance-relative paths selected for export. */
  files: string[]
  name: string
  description: string
  currentVersion: string
}

export const VardrynnPackPublishDialogKey: DialogKey<VardrynnPackPublishDialogOptions> = 'vardrynn-pack-publish'

/** Turns an instance name into a pack slug the service accepts, or '' when nothing is left. */
export function toPackSlug(name: string) {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return slug === 'files' ? 'files-pack' : slug
}

const slugKey = (instancePath: string) => `vardrynnPackSlug:${instancePath}`

/** The slug last published from this instance on this computer. */
export function getRememberedPackSlug(instancePath: string) {
  try {
    return localStorage.getItem(slugKey(instancePath)) ?? undefined
  } catch {
    return undefined
  }
}

export function rememberPackSlug(instancePath: string, slug: string) {
  try {
    localStorage.setItem(slugKey(instancePath), slug)
  } catch {
    // Remembering the slug is a convenience only.
  }
}
