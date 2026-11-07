import { describe, expect, it } from 'vitest'
import { isUpstreamIsSameOrigin } from './instance'

describe('isUpstreamIsSameOrigin', () => {
  it('lets an instance move between versions of the same Vardrynn pack', () => {
    const installed = { type: 'vardrynn-pack', slug: 'folded', versionId: 'v1' } as const
    expect(isUpstreamIsSameOrigin({ type: 'vardrynn-pack', slug: 'folded', versionId: 'v2' }, installed)).toBe(true)
    expect(isUpstreamIsSameOrigin({ type: 'vardrynn-pack', slug: 'other', versionId: 'v2' }, installed)).toBe(false)
    expect(isUpstreamIsSameOrigin({ type: 'modrinth-modpack', projectId: 'folded', versionId: 'v2' }, installed)).toBe(false)
  })
})
