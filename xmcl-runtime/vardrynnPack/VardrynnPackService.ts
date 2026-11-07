import { CurseforgeV1Client } from '@xmcl/curseforge'
import type { InstanceFile } from '@xmcl/instance'
import {
  VardrynnPackServiceKey,
  type PublishVardrynnPackOptions,
  type PublishVardrynnPackResult,
  type VardrynnPack,
  type VardrynnPackListItem,
  type VardrynnPackVersionDetail,
  type VardrynnPackPreview,
  type VardrynnPackService as IVardrynnPackService,
} from '@xmcl/runtime-api'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { Inject, LauncherAppKey } from '~/app'
import { LauncherApp } from '~/app/LauncherApp'
import { requireVardrynnApiOrigin } from '~/app/vardrynnApiOrigin'
import { kFlights } from '~/infra'
import { InstanceService } from '~/instance'
import { getMediaIconPath } from '~/instance/instanceIcon'
import { InstanceManifestService } from '~/instanceIO'
import { AbstractService, ExposeServiceKey } from '~/service'
import { kXmclSessionAuthorization, XmclAccountService } from '~/xmclAccount'
import { buildPackManifest, PACK_SLUG, PACK_VERSION, previewPackFiles } from './packManifest'

const UPLOAD_CONCURRENCY = 4

/** Publishes the selected files of an instance as a Vardrynn pack. See VARDRYNN_SERVICE_API.md. */
@ExposeServiceKey(VardrynnPackServiceKey)
export class VardrynnPackService extends AbstractService implements IVardrynnPackService {
  constructor(@Inject(LauncherAppKey) app: LauncherApp) {
    super(app)
  }

  async previewVardrynnPack(instancePath: string, files: string[]): Promise<VardrynnPackPreview> {
    return (await this.collect(instancePath, files)).preview
  }

  async getVardrynnPack(slug: string): Promise<VardrynnPack | undefined> {
    if (!PACK_SLUG.test(slug)) return undefined
    const response = await this.request('GET', `/v1/packs/${slug}`)
    if (response.status === 404) return undefined
    return (await this.parse(response)).pack
  }

  async searchVardrynnPacks(query?: string): Promise<VardrynnPackListItem[]> {
    const q = query?.trim()
    const response = await this.request('GET', q ? `/v1/packs?${new URLSearchParams({ q })}` : '/v1/packs')
    return (await this.parse(response)).packs
  }

  async getVardrynnPackVersion(slug: string, versionId: string): Promise<VardrynnPackVersionDetail | undefined> {
    if (!PACK_SLUG.test(slug)) return undefined
    const response = await this.request('GET', `/v1/packs/${slug}/versions/${encodeURIComponent(versionId)}`)
    if (response.status === 404) return undefined
    return (await this.parse(response)).version
  }

  async publishVardrynnPack(options: PublishVardrynnPackOptions): Promise<PublishVardrynnPackResult> {
    if (!PACK_SLUG.test(options.slug)) throw new Error('vardrynn_pack_invalid_slug')
    if (!PACK_VERSION.test(options.version)) throw new Error('vardrynn_pack_invalid_version')
    const { manifest, files, preview } = await this.collect(options.instancePath, options.files)
    if (preview.blocked) throw new Error('vardrynn_pack_file_too_large')
    const origin = await this.origin()
    const fileUrl = (sha1: string) => `${origin}/v1/packs/files/${sha1}`

    const toUpload = files.filter((f) => preview.files.find((p) => p.path === f.path)?.source === 'upload')
    let uploaded = 0
    const queue = [...toUpload]
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        if (await this.uploadFile(file.hashes.sha1, () => readFile(join(options.instancePath, file!.path)))) uploaded++
      }
    }))
    const iconSha1 = await this.uploadIcon(options.instancePath)

    await this.parse(await this.request('PUT', `/v1/packs/${options.slug}`, {
      title: options.title, summary: options.summary, description: options.description, iconSha1,
    }))
    const packManifest = buildPackManifest(manifest, files, preview, options, fileUrl)
    const published = await this.parse(await this.request('POST', `/v1/packs/${options.slug}/versions`, {
      version: options.version, changelog: options.changelog, manifest: packManifest,
    }))
    this.log(`Published Vardrynn pack ${options.slug} ${options.version} (${files.length} files, ${uploaded} uploaded)`)
    return { slug: options.slug, versionId: published.version.id, uploaded }
  }

  private async collect(instancePath: string, paths: string[]) {
    const manifestService = await this.app.registry.get(InstanceManifestService)
    const manifest = await manifestService.getInstanceManifest({ path: instancePath, hashes: ['sha1'] })
    const selected = new Set(paths)
    // modpack-metadata.json holds the publisher's own export settings.
    const files = manifest.files.filter((f) => selected.has(f.path) && f.hashes.sha1 && f.path !== 'modpack-metadata.json')
    const preview = previewPackFiles(files, await this.restrictedCurseforgeFiles(files))
    return { manifest, files, preview }
  }

  // CurseForge returns no download URL for files whose author blocks other apps.
  private async restrictedCurseforgeFiles(files: InstanceFile[]) {
    const ids = files.filter((f) => f.curseforge && !f.modrinth).map((f) => f.curseforge!.fileId)
    const restricted = new Set<number>()
    if (!ids.length) return restricted
    const client = await this.app.registry.get(CurseforgeV1Client)
    for (let i = 0; i < ids.length; i += 128) {
      const result = await client.getFiles(ids.slice(i, i + 128)).catch((e) => {
        this.warn(new Error('Could not check CurseForge download permissions', { cause: e }))
        return []
      })
      for (const file of result) if (!file.downloadUrl) restricted.add(file.id)
    }
    return restricted
  }

  /** Uploads unless the service already has the file. Returns whether it uploaded. */
  private async uploadFile(sha1: string, read: () => Promise<Uint8Array>) {
    const existing = await this.request('HEAD', `/v1/packs/files/${sha1}`, undefined, false)
    if (existing.ok) return false
    await this.parse(await this.request('PUT', `/v1/packs/files/${sha1}`, await read()))
    return true
  }

  // The icon is stored like any other file. Remote icons and missing files are skipped.
  private async uploadIcon(instancePath: string): Promise<string | undefined> {
    const instanceService = await this.app.registry.get(InstanceService)
    const icon = instanceService.state.all[instancePath]?.icon
    const iconPath = icon ? getMediaIconPath(icon) : undefined
    if (!iconPath) return undefined
    const bytes = await readFile(iconPath).catch(() => undefined)
    if (!bytes) return undefined
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    await this.uploadFile(sha1, async () => bytes)
    return sha1
  }

  private async origin() {
    return requireVardrynnApiOrigin(await this.app.registry.get(kFlights))
  }

  private async request(method: string, path: string, body?: unknown, authenticate = method !== 'GET') {
    const url = new URL(path, await this.origin())
    const headers: Record<string, string> = {}
    if (authenticate) {
      const account = await this.app.registry.get(XmclAccountService)
      const authorization = await account[kXmclSessionAuthorization]({ method, url })
      if (!authorization) throw new Error('xmcl_account_session_missing')
      headers.authorization = `${authorization.tokenType === 'DPoP' ? 'DPoP' : 'Bearer'} ${authorization.accessToken}`
      if (authorization.dpopProof) headers.dpop = authorization.dpopProof
    }
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array) {
      payload = body as unknown as BodyInit // Node accepts any Uint8Array body
      headers['content-type'] = 'application/octet-stream'
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    return this.app.fetch(url, { method, headers, body: payload, redirect: 'error' })
  }

  // Service errors are `{ error, detail? }`; the message keeps both for the publish dialog.
  private async parse(response: Response): Promise<any> {
    const body = await response.json().catch(() => undefined)
    if (response.ok && body?.apiVersion === 'v1') return body
    const code = typeof body?.error === 'string' ? body.error : `vardrynn_pack_http_${response.status}`
    throw new Error(typeof body?.detail === 'string' ? `${code}: ${body.detail}` : code)
  }
}
