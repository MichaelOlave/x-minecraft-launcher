import type { InstanceManifest } from '@xmcl/instance'
import { ServiceKey } from './Service'

/** A pack version as the Vardrynn service lists it (`/v1/packs` routes). */
export interface VardrynnPackVersion {
  id: string
  version: string
  changelog: string
  minecraft: string
  /** Runtime keys of the loaders in use, such as `fabricLoader` or `neoForged`. */
  loaders: string[]
  publishedAt: string
}

export interface VardrynnPackSummary {
  slug: string
  title: string
  summary: string
  iconUrl?: string
  createdAt: string
  updatedAt: string
}

export interface VardrynnPackListItem extends VardrynnPackSummary {
  latestVersion: VardrynnPackVersion
}

export interface VardrynnPack extends VardrynnPackSummary {
  description: string
  versions: VardrynnPackVersion[]
}

export interface VardrynnPackVersionDetail extends VardrynnPackVersion {
  manifest: InstanceManifest
}

/**
 * How a player's launcher will get a file:
 * - `modrinth`, `curseforge`: from that site
 * - `link`: from another https download link already known for the file
 * - `upload`: uploaded to the Vardrynn service when publishing
 */
export type VardrynnPackFileSource = 'modrinth' | 'curseforge' | 'link' | 'upload'

/**
 * - `curseforge-restricted`: the CurseForge author blocks downloads by other apps
 * - `unlisted-mod`: a mod on neither site; upload it only if its license allows that
 * - `too-large`: over the service's 50 MB upload limit, so the pack cannot be published
 */
export type VardrynnPackFileWarning = 'curseforge-restricted' | 'unlisted-mod' | 'too-large'

export interface VardrynnPackFilePreview {
  path: string
  source: VardrynnPackFileSource
  size: number
  warning?: VardrynnPackFileWarning
}

export interface VardrynnPackPreview {
  files: VardrynnPackFilePreview[]
  /** Total size of the files that will be uploaded. */
  uploadBytes: number
  /** True when a file cannot be published at all (see `too-large`). */
  blocked: boolean
}

export interface PublishVardrynnPackOptions {
  instancePath: string
  /** Instance-relative paths to include, as selected for export. */
  files: string[]
  slug: string
  title: string
  summary: string
  description: string
  version: string
  changelog: string
}

export interface PublishVardrynnPackResult {
  slug: string
  versionId: string
  /** Number of files that were uploaded (files already on the service are skipped). */
  uploaded: number
}

export interface VardrynnPackService {
  /** Shows where each selected file will come from, before publishing. */
  previewVardrynnPack(instancePath: string, files: string[]): Promise<VardrynnPackPreview>
  /**
   * Uploads the files on neither site, creates or updates the pack and publishes a new version.
   * Needs a Vardrynn session whose account may publish.
   */
  publishVardrynnPack(options: PublishVardrynnPackOptions): Promise<PublishVardrynnPackResult>
  /** Reads a published pack, or `undefined` when it does not exist or has no version yet. */
  getVardrynnPack(slug: string): Promise<VardrynnPack | undefined>
}

export const VardrynnPackServiceKey: ServiceKey<VardrynnPackService> = 'VardrynnPackService'
