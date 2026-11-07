import type { RuntimeVersions } from '@xmcl/instance'
import {
  InstanceInstallServiceKey,
  InstanceServiceKey,
  VardrynnPackServiceKey,
  type CreateInstanceOption,
  type VardrynnPack,
  type VardrynnPackVersionDetail,
} from '@xmcl/runtime-api'
import { injection } from '@/util/inject'
import { generateDistinctName } from '@/util/instanceName'
import { kInstanceVersion } from './instanceVersion'
import { kInstanceVersionInstall } from './instanceVersionInstall'
import { kInstances } from './instances'
import { kJavaContext } from './java'
import { useDialog } from './dialog'
import { InstanceInstallDialog } from './instanceUpdate'
import { useService } from './service'

/** Creates an instance from a pack version and installs its files and runtime. */
export function useVardrynnPackInstall() {
  const { createInstance } = useService(InstanceServiceKey)
  const { installInstanceFiles } = useService(InstanceInstallServiceKey)
  const { instances, selectedInstance } = injection(kInstances)
  const { getVersionHeader, getResolvedVersion } = injection(kInstanceVersion)
  const { getInstallInstruction, handleInstallInstruction, getInstanceLock } = injection(kInstanceVersionInstall)
  const { all: javas } = injection(kJavaContext)
  const { currentRoute, push } = useRouter()

  async function installPack(pack: VardrynnPack, version: VardrynnPackVersionDetail) {
    const runtime = version.manifest.runtime as RuntimeVersions
    const options: CreateInstanceOption = {
      name: generateDistinctName(pack.title, instances.value.map((i) => i.name)),
      description: pack.summary,
      runtime,
      upstream: { type: 'vardrynn-pack', slug: pack.slug, versionId: version.id },
      icon: pack.iconUrl,
    }
    const existed = getVersionHeader(runtime, '')
    if (existed) options.version = existed.id

    const path = await createInstance(options)
    selectedInstance.value = path
    if (currentRoute.value.path !== '/') push('/')

    const filesInstall = installInstanceFiles({
      path,
      upstream: { type: 'vardrynn-pack', slug: pack.slug, versionId: version.id },
      files: version.manifest.files,
    })
    const lock = getInstanceLock(path)
    const runtimeInstall = lock.runExclusive(async () => {
      const resolved = existed ? await getResolvedVersion(existed) : undefined
      const instruction = await getInstallInstruction(path, runtime, options.version || '', resolved, javas.value)
      await handleInstallInstruction(instruction)
    })
    // Keep progress and errors attached to the initiating install action.
    await Promise.all([filesInstall, runtimeInstall])
  }

  return { installPack }
}

/** Opens the install dialog to move the current instance between two versions of a pack. */
export function useVardrynnPackUpdate() {
  const { getVardrynnPackVersion } = useService(VardrynnPackServiceKey)
  const { show } = useDialog(InstanceInstallDialog)
  const { t } = useI18n()

  async function updatePack(slug: string, fromVersionId: string, toVersionId: string) {
    const [oldVersion, newVersion] = await Promise.all([
      getVardrynnPackVersion(slug, fromVersionId),
      getVardrynnPackVersion(slug, toVersionId),
    ])
    if (!newVersion) throw new Error(t('vardrynnPack.versionMissing'))
    show({
      type: 'manifest',
      // A deleted old version compares against nothing, so every file is offered as new.
      oldManifest: markRaw(oldVersion?.manifest ?? { runtime: newVersion.manifest.runtime, files: [] }),
      newManifest: markRaw(newVersion.manifest),
      upstream: { type: 'vardrynn-pack', slug, versionId: toVersionId },
    })
  }

  return { updatePack }
}
