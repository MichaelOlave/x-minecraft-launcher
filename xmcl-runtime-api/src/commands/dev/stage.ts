import { z } from 'zod'
import { DevTestServiceKey, type StageDevInstanceOptions, type StageDevInstanceResult } from '../../services/DevTestService'
import { defineCommand } from '../registry'
import { asSetupFailure, formatDuration, forwardDevProgress, parseMapping } from './shared'

export const StageDevInstanceInputSchema = z.object({
  /** Working instance to copy, by path or name. */
  source: z.string().min(1),
  /** Name of the disposable instance. */
  name: z.string().min(1),
  lock: z.string().min(1).optional(),
  lockExtra: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
  copyOnce: z.array(z.string().min(1)).optional(),
  fresh: z.boolean().default(false),
  overlay: z.array(z.string().min(1)).default([]),
  replaceOverlay: z.array(z.string().min(1)).default([]),
  world: z.string().min(1).optional(),
  worldName: z.string().min(1).optional(),
  keepWorld: z.boolean().default(false),
})

export type StageDevInstanceInput = z.infer<typeof StageDevInstanceInputSchema>

export function toStageOptions(input: StageDevInstanceInput, cwd?: string): StageDevInstanceOptions {
  return {
    source: input.source,
    name: input.name,
    lock: input.lock ? { file: input.lock, extra: input.lockExtra } : undefined,
    exclude: input.exclude,
    copyOnce: input.copyOnce,
    fresh: input.fresh,
    overlays: [
      ...input.overlay.map((v) => ({ ...parseMapping(v), mode: 'merge' as const })),
      ...input.replaceOverlay.map((v) => ({ ...parseMapping(v), mode: 'replace' as const })),
    ],
    world: input.world ? { from: input.world, name: input.worldName, reset: !input.keepWorld } : undefined,
    cwd,
  }
}

export function describeStage(result: StageDevInstanceResult): string[] {
  const lines = [`Staged "${result.name}" from ${result.sourcePath} in ${formatDuration(result.durationMs)}${result.created ? ' (new instance)' : ''}`]
  if (result.lock) {
    lines.push(`  Lock: ${result.lock.file} matches (${result.lock.mods} mods${result.lock.extra.length ? `, including ${result.lock.extra.join(', ')}` : ''})`)
  }
  const m = result.mods
  lines.push(`  Mods: ${m.total} staged, ${m.copied} copied, ${m.removed.length} removed${m.excluded.length ? `, left out ${m.excluded.join(', ')}` : ''}`)
  if (result.copied.length) lines.push(`  Copied from the working instance: ${result.copied.join(', ')}`)
  if (result.overlays.length) lines.push(`  Overlays: ${result.overlays.length} file(s) changed`)
  if (result.world) lines.push(`  World: ${result.world.name} (${result.world.copied ? 'fresh copy' : 'kept'})`)
  lines.push(`  Path: ${result.instancePath}`)
  return lines
}

export const stageDevInstanceCommand = defineCommand({
  id: 'dev.stage',
  title: 'Stage Disposable Instance',
  description: 'Create or refresh a disposable test instance from a working instance, checked against the pack lock. Saves and settings stay separate from the working instance.',
  category: 'dev',
  input: StageDevInstanceInputSchema,
  cli: {
    name: 'dev stage',
    positionals: ['source', 'name'],
    flags: {
      lock: { description: 'Pack lock file (pack-lock.json) the working instance must match' },
      lockExtra: { multiple: true, description: 'Mod file newer than the lock that the working instance contains' },
      exclude: { multiple: true, description: 'Mod file name pattern to leave out (* and ? wildcards)' },
      copyOnce: { multiple: true, description: 'File or folder copied from the working instance when missing' },
      fresh: { type: 'boolean', description: 'Copy settings from the working instance again' },
      overlay: { multiple: true, description: 'FROM=TO: copy a file or folder into the instance' },
      replaceOverlay: { multiple: true, description: 'FROM=TO: replace a folder in the instance' },
      world: { description: 'Saved world folder to copy into saves/' },
      worldName: { description: 'Folder name for the copied world' },
      keepWorld: { type: 'boolean', description: 'Keep the world from the last stage instead of a fresh copy' },
    },
  },
  async handler(input, ctx): Promise<StageDevInstanceResult> {
    const stop = await forwardDevProgress(ctx, input.name)
    let result: StageDevInstanceResult
    try {
      result = await ctx.call(DevTestServiceKey, 'stageDevInstance', toStageOptions(input, ctx.cwd))
    } catch (e) {
      throw asSetupFailure(e)
    } finally {
      stop()
    }
    for (const line of describeStage(result)) ctx.out.log(line)
    ctx.out.json({ ok: true, command: 'dev.stage', data: result })
    return result
  },
})
