import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'

export async function hashFile(path: string, algorithm: 'sha256' | 'sha512' = 'sha256'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * SHA-256 of files, remembered by path, size and modification time. A pack
 * has hundreds of mod files and a restage only needs to hash what changed.
 */
export class HashCache {
  #entries = new Map<string, { size: number; mtimeMs: number; sha256: string }>()

  async sha256(path: string): Promise<string> {
    const info = await stat(path)
    const cached = this.#entries.get(path)
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha256
    const sha256 = await hashFile(path)
    this.#entries.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 })
    return sha256
  }
}
