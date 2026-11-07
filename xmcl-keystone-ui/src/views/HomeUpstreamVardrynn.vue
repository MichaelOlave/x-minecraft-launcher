<script lang="ts" setup>
import { useLocalStorage } from '@vueuse/core'
import { useService } from '@/composables'
import { useDateString } from '@/composables/date'
import { useDialog } from '@/composables/dialog'
import { kInstance } from '@/composables/instance'
import { AddInstanceDialogKey } from '@/composables/instanceTemplates'
import { useMarkdown } from '@/composables/markdown'
import { useNotifier } from '@/composables/notifier'
import { getVardrynnLoaderNames } from '@/util/vardrynnPack'
import { useVardrynnPackUpdate } from '@/composables/vardrynnPack'
import { injection } from '@/util/inject'
import type { VardrynnUpstream } from '@xmcl/instance'
import { VardrynnPackServiceKey, type VardrynnPackVersion } from '@xmcl/runtime-api'
import useSWRV from 'swrv'
import vardrynnMark from '@/assets/vardrynn-mark.png'
import HomeUpstreamBase from './HomeUpstreamBase.vue'
import { UpstreamHeaderProps } from './HomeUpstreamHeader.vue'
import { ProjectVersionProps } from './HomeUpstreamVersion.vue'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const { instance } = injection(kInstance)
const upstream = computed(() => instance.value?.upstream as VardrynnUpstream)
const { getVardrynnPack, getVardrynnPackVersion } = useService(VardrynnPackServiceKey)
const { data: pack } = useSWRV(computed(() => `vardrynn-pack:${props.slug}`), () => getVardrynnPack(props.slug))
const { getDateString } = useDateString()
const { render: renderHtml } = useMarkdown()
// Changelogs come from the service; escaping `<` and `&` keeps Markdown but lets no HTML through.
const render = (markdown: string) => renderHtml(markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;'))

const headerData = computed(() => {
  const p = pack.value
  if (!p) return undefined
  const result: UpstreamHeaderProps = {
    url: '',
    icon: p.iconUrl || vardrynnMark,
    title: p.title,
    description: p.summary,
    categories: [],
    type: 'vardrynn',
    store: `/store/vardrynn/${p.slug}`,
    infos: [{
      icon: 'event',
      name: t('modrinth.createAt'),
      value: getDateString(p.createdAt, { dateStyle: 'long' }),
    }, {
      icon: 'update',
      name: t('modrinth.updateAt'),
      value: getDateString(p.updatedAt, { dateStyle: 'long' }),
    }],
  }
  return result
})

const toProps = (v: VardrynnPackVersion): ProjectVersionProps => markRaw({
  id: v.id,
  name: v.version,
  versionType: 'release',
  versionNumber: v.version,
  loaders: getVardrynnLoaderNames(v.loaders),
  gameVersions: [v.minecraft],
  datePublished: v.publishedAt,
  downloads: 0,
  changelog: v.changelog ? render(v.changelog) : '',
})

const currentVersion = computed(() => {
  const ver = pack.value?.versions.find((v) => v.id === upstream.value?.versionId)
  return ver ? toProps(ver) : undefined
})

const limit = ref(10)
const onlyCurrentVersion = useLocalStorage(computed(() => `instanceUpstreamOnlyShowCurrentVersion/${instance.value.path}`), false, { writeDefaults: false })
const items = computed(() => {
  const result = {} as Record<string, ProjectVersionProps[]>
  let all = pack.value?.versions ?? []
  if (onlyCurrentVersion.value) all = all.filter((v) => v.minecraft === instance.value.runtime.minecraft)
  for (const v of all.slice(0, limit.value)) {
    if (v.id === currentVersion.value?.id) continue
    const date = getDateString(v.publishedAt, { dateStyle: 'long' })
    ;(result[date] ??= []).push(toProps(v))
  }
  return result
})

const state = inject('scroll', { bottom: false })
watch(computed(() => state.bottom), (reached) => {
  if (reached) limit.value += 10
})

const { notify } = useNotifier()
const { updatePack } = useVardrynnPackUpdate()
const updating = ref(false)
async function onUpdate(v: ProjectVersionProps) {
  updating.value = true
  try {
    await updatePack(props.slug, upstream.value.versionId, v.id)
  } catch (e) {
    notify({ level: 'error', title: (e as Error).message })
  } finally {
    updating.value = false
  }
}

const { show: showAddInstanceDialog } = useDialog(AddInstanceDialogKey)
const duplicating = ref(false)
async function onDuplicate(v: ProjectVersionProps) {
  duplicating.value = true
  try {
    const version = await getVardrynnPackVersion(props.slug, v.id)
    if (!version) throw new Error(t('vardrynnPack.versionMissing'))
    showAddInstanceDialog({ format: 'manifest', manifest: markRaw(version.manifest) })
  } catch (e) {
    notify({ level: 'error', title: (e as Error).message })
  } finally {
    duplicating.value = false
  }
}
</script>

<template>
  <HomeUpstreamBase
    v-model:only-current-version="onlyCurrentVersion"
    :items="items"
    :current-version="currentVersion"
    :header="headerData"
    :updating="updating"
    :duplicating="duplicating"
    @duplicate="onDuplicate"
    @update="onUpdate"
  />
</template>
