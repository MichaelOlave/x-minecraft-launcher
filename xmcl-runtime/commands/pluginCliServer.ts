import { unlink } from 'fs/promises'
import { LauncherAppPlugin } from '../app'
import { getCliSocketPath, getCliTokenPath, writeCliToken } from './cliProtocol'
import { createCliServer } from './cliServer'
import { kCommandHost } from './kCommandHost'
import { enrichInput } from './pluginCli'

/**
 * Lets commands typed in a terminal run inside this launcher while it is
 * open, with their output and exit status returned to that terminal.
 *
 * Only the primary instance serves. It writes a fresh private token on every
 * start, so a terminal must be able to read this user's launcher data to
 * connect.
 */
export const pluginCliServer: LauncherAppPlugin = (app) => {
  const logger = app.getLogger('CliServer')

  Promise.all([app.primaryInstance, app.waitEngineReady()]).then(async ([primary]) => {
    if (!primary || app.disposed) return
    const host = await app.registry.get(kCommandHost)
    const socketPath = getCliSocketPath(app.appDataPath)
    const token = await writeCliToken(getCliTokenPath(app.appDataPath))
    const server = createCliServer({
      host,
      token,
      launcherVersion: app.version,
      logger,
      enrichInput,
    })
    await server.listen(socketPath)
    app.registryDisposer(async () => {
      await server.close()
      if (process.platform !== 'win32') await unlink(socketPath).catch(() => undefined)
    })
    logger.log(`Accepting terminal commands on ${socketPath}`)
  }).catch((e) => {
    logger.warn('Terminal commands are unavailable: the command server failed to start')
    logger.error(e as Error)
  })
}
