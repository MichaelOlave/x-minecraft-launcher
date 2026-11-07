import { describe, expect, it } from 'vitest'
import { toPackSlug } from './vardrynnPackPublish'

describe('toPackSlug', () => {
  it('makes a pack ID the service accepts from an instance name', () => {
    expect(toPackSlug('Beyond The Cobbleverse + Magnum Torches + C2ME')).toBe('beyond-the-cobbleverse-magnum-torches-c2me')
    expect(toPackSlug('  FoldedMultiverse!! ')).toBe('foldedmultiverse')
    expect(toPackSlug('Pokémon Café')).toBe('pokemon-cafe')
    expect(toPackSlug('files')).toBe('files-pack')
    expect(toPackSlug('!!!')).toBe('')
    expect(toPackSlug(`${'a'.repeat(63)}-b`)).toBe('a'.repeat(63))
  })
})
