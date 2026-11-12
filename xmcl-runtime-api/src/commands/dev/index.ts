import { commands } from '../registry'
import { stageDevInstanceCommand } from './stage'

export * from './shared'
export * from './stage'

/** Developer commands for pack authors. Idempotent. */
export function registerDevCommands() {
  for (const cmd of [stageDevInstanceCommand]) {
    if (!commands.has(cmd.id)) commands.register(cmd)
  }
}
