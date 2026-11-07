<script lang="ts" setup>
import StoreProject, { StoreProject as IStoreProject } from '@/components/StoreProject.vue'
import { StoreProjectVersion } from '@/components/StoreProjectInstallVersionDialog.vue'
import { useService } from '@/composables'
import { kInstances } from '@/composables/instances'
import { useMarkdown } from '@/composables/markdown'
import { useNotifier } from '@/composables/notifier'
import { useVardrynnPackInstall } from '@/composables/vardrynnPack'
import { getVardrynnLoaderNames, getVardrynnPackMods } from '@/util/vardrynnPack'
import { injection } from '@/util/inject'
import { VardrynnPackServiceKey } from '@xmcl/runtime-api'
import useSWRV from 'swrv'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const { render: renderHtml } = useMarkdown()
// Pack text comes from the service. Escaping `<` and `&` keeps Markdown but lets no HTML through,
// since the store page inserts the result as HTML.
const render = (markdown: string) => renderHtml(markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
const { getVardrynnPack, getVardrynnPackVersion } = useService(VardrynnPackServiceKey)
const { data: pack, isValidating, error } = useSWRV(computed(() => `vardrynn-pack:${props.slug}`), () => getVardrynnPack(props.slug))

const project = computed(() => {
  const p = pack.value
  if (!p) return undefined
  const latest = p.versions[0]
  const result: IStoreProject = {
    id: p.slug,
    title: p.title,
    iconUrl: p.iconUrl,
    url: '',
    description: p.summary,
    categories: [],
    downloads: 0,
    follows: 0,
    createDate: p.createdAt,
    updateDate: p.updatedAt,
    links: [],
    info: latest
      ? [
          { name: t('vardrynnPack.latestVersion'), value: latest.version, icon: 'tag' },
          { name: 'Minecraft', value: latest.minecraft, icon: 'sports_esports' },
          { name: t('vardrynnPack.loaders'), value: getVardrynnLoaderNames(latest.loaders).join(', ') || '-', icon: 'extension' },
        ]
      : [],
    htmlDescription: render(p.description || p.summary),
    gallery: [],
  }
  return result
})

const versions = computed(() => pack.value?.versions.map((v): StoreProjectVersion => ({
  id: v.id,
  name: v.version,
  version_type: 'release',
  game_versions: [v.minecraft],
  loaders: getVardrynnLoaderNames(v.loaders),
})) ?? [])

const sourceNames: Record<string, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', vardrynn: 'Vardrynn' }
async function getVersionDetail(version: StoreProjectVersion) {
  const detail = await getVardrynnPackVersion(props.slug, version.id)
  return {
    version,
    changelog: detail?.changelog ? render(detail.changelog) : '',
    dependencies: getVardrynnPackMods(detail?.manifest.files ?? []).map((mod) => ({
      title: mod.name,
      description: sourceNames[mod.source],
      icon: '',
      href: mod.href,
      dependencyType: 'embedded',
    })),
  }
}

const installing = ref(false)
const { notify } = useNotifier()
const { installPack } = useVardrynnPackInstall()
async function onInstall(v: StoreProjectVersion) {
  const p = pack.value
  if (!p || installing.value) return
  installing.value = true
  try {
    const detail = await getVardrynnPackVersion(p.slug, v.id)
    if (!detail) throw new Error(t('vardrynnPack.versionMissing'))
    await installPack(p, detail)
  } catch (e) {
    notify({ level: 'error', title: (e as Error).message })
  } finally {
    installing.value = false
  }
}

const { instances, selectedInstance } = injection(kInstances)
const existed = computed(() => instances.value.find((i) => i.upstream?.type === 'vardrynn-pack' && i.upstream.slug === props.slug))
const { push } = useRouter()
function onOpen() {
  const i = existed.value
  if (!i) return
  selectedInstance.value = i.path
  push('/')
}
</script>

<template>
  <StoreProject
    :project="project"
    :versions="versions"
    :error="error"
    :refreshing="isValidating"
    :members="[]"
    :installing="installing"
    :installed="!!existed"
    :loading-members="false"
    :team-error="undefined"
    :get-version-detail="getVersionDetail"
    @install="onInstall"
    @open="onOpen"
  />
</template>
