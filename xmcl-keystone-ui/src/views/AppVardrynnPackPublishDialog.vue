<template>
  <v-dialog v-model="isShown" max-width="680" scrollable persistent>
    <v-card data-testid="vardrynn-pack-publish-dialog">
      <v-card-title class="flex items-center gap-3 px-6 pt-5">
        <v-icon color="primary">cloud_upload</v-icon>
        {{ t('vardrynnPack.publishTitle') }}
      </v-card-title>
      <v-card-text class="pack-form">
        <v-alert v-if="!parameter?.files.length" type="warning" variant="tonal" density="compact">{{ t('vardrynnPack.noFiles') }}</v-alert>
        <v-skeleton-loader v-else-if="previewLoading" type="text" />
        <v-alert v-else-if="previewError" type="error" variant="tonal" density="compact">{{ previewError }}</v-alert>
        <v-alert v-else-if="preview" :type="preview.blocked ? 'error' : 'info'" variant="tonal" density="compact">
          <div class="flex flex-wrap gap-2">
            <v-chip v-for="entry in sourceCounts" :key="entry.source" size="small" variant="tonal">
              {{ t(`vardrynnPack.source.${entry.source}`) }}: {{ entry.count }}
            </v-chip>
          </div>
          <div v-if="preview.uploadBytes" class="mt-2">{{ t('vardrynnPack.uploadSize', { size: formatSize(preview.uploadBytes) }) }}</div>
          <v-expansion-panels v-if="flagged.length" class="mt-2" variant="accordion">
            <v-expansion-panel :title="t('vardrynnPack.flaggedFiles', { count: flagged.length })">
              <template #text>
                <div v-for="file in flagged" :key="file.path" class="file-entry">
                  <span class="font-mono truncate">{{ file.path }}</span>
                  <span class="opacity-70 flex-shrink-0">{{ t(`vardrynnPack.warning.${file.warning}`) }}</span>
                </div>
              </template>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-alert>
        <div class="pack-grid">
          <v-text-field
            v-model="slug"
            data-testid="vardrynn-pack-slug"
            :label="t('vardrynnPack.slug')"
            :hint="t('vardrynnPack.slugHint')"
            :rules="[() => validSlug || t('vardrynnPack.slugInvalid')]"
            variant="outlined"
            density="compact"
            persistent-hint
            @blur="loadExisting"
          />
          <v-text-field
            v-model="version"
            data-testid="vardrynn-pack-version"
            :label="t('modpack.modpackVersion')"
            :rules="[() => validVersion || t('vardrynnPack.versionInvalid')]"
            variant="outlined"
            density="compact"
          />
        </div>
        <v-text-field v-model="title" data-testid="vardrynn-pack-title" :label="t('vardrynnPack.packTitle')" variant="outlined" density="compact" hide-details counter="100" />
        <v-text-field v-model="summary" :label="t('vardrynnPack.summary')" variant="outlined" density="compact" hide-details />
        <v-textarea v-model="description" :label="t('vardrynnPack.description')" variant="outlined" rows="3" hide-details />
        <v-textarea v-model="changelog" data-testid="vardrynn-pack-changelog" :label="t('modpack.publishChangelog')" variant="outlined" rows="4" hide-details />
        <v-alert v-if="existing" type="info" variant="tonal" density="compact">
          {{ t('vardrynnPack.existing', { version: existing.versions[0]?.version ?? '-' }) }}
        </v-alert>
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        <v-alert v-if="result" type="success" variant="tonal" density="compact">
          {{ t('vardrynnPack.published', { slug: result.slug, version, uploaded: result.uploaded }) }}
        </v-alert>
      </v-card-text>
      <v-divider />
      <v-card-actions class="px-6 py-4">
        <v-spacer />
        <v-btn data-testid="vardrynn-pack-publish-cancel" variant="text" :disabled="publishing" @click="hide">
          {{ result ? t('shared.close') : t('shared.cancel') }}
        </v-btn>
        <v-btn
          v-if="!result"
          data-testid="vardrynn-pack-publish-confirm"
          color="primary"
          variant="flat"
          prepend-icon="cloud_upload"
          :loading="publishing"
          :disabled="!valid"
          @click="publish"
        >
          {{ t('vardrynnPack.publish') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { useService } from '@/composables'
import { useDialog } from '@/composables/dialog'
import { getRememberedPackSlug, rememberPackSlug, toPackSlug, VardrynnPackPublishDialogKey } from '@/composables/vardrynnPackPublish'
import { getErrorMessage } from '@/util/error'
import { VardrynnPackServiceKey, type PublishVardrynnPackResult, type VardrynnPack, type VardrynnPackFileSource, type VardrynnPackPreview } from '@xmcl/runtime-api'
import { inc } from 'semver'

// Same rules as the service (vardrynn-service/packs.js).
const SLUG = /^(?!files$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/
const SOURCES: VardrynnPackFileSource[] = ['modrinth', 'curseforge', 'link', 'upload']

const { t } = useI18n()
const { isShown, parameter, hide } = useDialog(VardrynnPackPublishDialogKey)
const { previewVardrynnPack, publishVardrynnPack, getVardrynnPack } = useService(VardrynnPackServiceKey)

const slug = ref('')
const version = ref('')
const title = ref('')
const summary = ref('')
const description = ref('')
const changelog = ref('')
const preview = shallowRef<VardrynnPackPreview>()
const previewLoading = ref(false)
const previewError = ref('')
const existing = shallowRef<VardrynnPack>()
const publishing = ref(false)
const error = ref('')
const result = shallowRef<PublishVardrynnPackResult>()

const validSlug = computed(() => SLUG.test(slug.value))
const validVersion = computed(() => VERSION.test(version.value))
const valid = computed(() => validSlug.value && validVersion.value && !!title.value.trim() && title.value.length <= 100 &&
  summary.value.length <= 300 && !!preview.value && !preview.value.blocked && !!parameter.value?.files.length)
const sourceCounts = computed(() => SOURCES
  .map((source) => ({ source, count: preview.value?.files.filter((f) => f.source === source).length ?? 0 }))
  .filter((entry) => entry.count > 0))
const flagged = computed(() => preview.value?.files.filter((f) => f.warning) ?? [])

// Service and runtime error codes with their own message; others are shown as they are.
const ERRORS: Record<string, string> = {
  not_found: 'unsupported',
  method_not_allowed: 'unsupported',
  forbidden: 'forbidden',
  unauthorized: 'signedOut',
  xmcl_account_session_missing: 'signedOut',
  version_exists: 'versionExists',
  invalid_manifest: 'invalidManifest',
  packs_unconfigured: 'storage',
  pack_storage_unavailable: 'storage',
  vardrynn_pack_file_too_large: 'tooLarge',
}

function describeError(caught: unknown) {
  const message = getErrorMessage(caught)
  const separator = message.indexOf(': ')
  const code = separator === -1 ? message : message.slice(0, separator)
  const detail = separator === -1 ? '' : message.slice(separator + 2)
  const key = ERRORS[code]
  return key ? t(`vardrynnPack.error.${key}`, { detail }) : message
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

let previewRequest = 0
async function loadPreview(instancePath: string, files: string[]) {
  const request = ++previewRequest
  previewLoading.value = true
  previewError.value = ''
  preview.value = undefined
  try {
    const value = await previewVardrynnPack(instancePath, files)
    if (request === previewRequest) preview.value = value
  } catch (caught) {
    if (request === previewRequest) previewError.value = describeError(caught)
  } finally {
    if (request === previewRequest) previewLoading.value = false
  }
}

// A published pack keeps its details, and the next version defaults to a patch bump.
let existingRequest = 0
async function loadExisting() {
  if (!validSlug.value) return
  const request = ++existingRequest
  const pack = await getVardrynnPack(slug.value).catch(() => undefined)
  if (request !== existingRequest) return
  existing.value = pack
  if (!pack) return
  title.value = pack.title
  summary.value = pack.summary
  description.value = pack.description
  const latest = pack.versions[0]?.version
  if (latest && version.value === latest) version.value = inc(latest, 'patch') ?? version.value
}

// Runs immediately, so it must follow the request counters above.
watch(parameter, (options) => {
  if (!options) return
  slug.value = getRememberedPackSlug(options.instancePath) ?? toPackSlug(options.name)
  version.value = options.currentVersion
  title.value = options.name.slice(0, 100)
  summary.value = options.description.slice(0, 300)
  description.value = ''
  changelog.value = ''
  existing.value = undefined
  result.value = undefined
  error.value = ''
  loadPreview(options.instancePath, options.files)
  loadExisting()
}, { immediate: true })

async function publish() {
  const options = parameter.value
  if (!options || !valid.value) return
  publishing.value = true
  error.value = ''
  try {
    result.value = await publishVardrynnPack({
      instancePath: options.instancePath,
      files: options.files,
      slug: slug.value,
      title: title.value.trim(),
      summary: summary.value.trim(),
      description: description.value.trim(),
      version: version.value,
      changelog: changelog.value.trim(),
    })
    rememberPackSlug(options.instancePath, slug.value)
  } catch (caught) {
    error.value = describeError(caught)
  } finally {
    publishing.value = false
  }
}
</script>

<style scoped>
.pack-form { display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; }
/* The card body scrolls; its children keep their height. */
.pack-form > * { flex-shrink: 0; }
.pack-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; }
.file-entry { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; font-size: 12px; min-width: 0; }
@media (max-width: 640px) { .pack-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
