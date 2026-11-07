import { Client } from 'undici'
import { LauncherAppPlugin } from '~/app'
import { GFW, kGFW } from '../gfw'

/** Resolves whether the origin answered at all; never rejects. */
export type NetworkProbe = (origin: string) => Promise<boolean>

const MIRROR_ORIGIN = 'https://registry.npmmirror.com'
const GOOGLE_ORIGIN = 'https://www.google.com'

/**
 * Mainland China blocks Google while the npm mirror answers there. Anywhere else Google
 * answers, so a fast mirror must never decide the result: the mirror is served worldwide
 * and often responds first. If neither answers the launcher is offline and keeps the
 * official sources.
 */
export async function detectNetworkEnv(probe: NetworkProbe): Promise<'cn' | 'global'> {
  const mirror = probe(MIRROR_ORIGIN)
  if (await probe(GOOGLE_ORIGIN)) return 'global'
  return (await mirror) ? 'cn' : 'global'
}

const headProbe: NetworkProbe = async (origin) => {
  const client = new Client(origin)
  try {
    const response = await client.request({
      method: 'HEAD',
      path: '/',
      connectTimeout: 5000,
      headersTimeout: 5000,
    })
    await response.body.dump()
    return true
  } catch {
    return false
  } finally {
    client.close().catch(() => {})
  }
}

export const pluginGFW: LauncherAppPlugin = (app) => {
  const logger = app.getLogger('GFW')
  const env = detectNetworkEnv(headProbe).then((networkEnv) => {
    logger.log(networkEnv === 'cn'
      ? 'Detected current in Chinese Mainland.'
      : 'Detected current NOT in Chinese Mainland.')
    return networkEnv
  })
  app.registry.register(kGFW, new GFW(env))
}
