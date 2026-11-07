import { describe, expect, it } from 'vitest'
import { detectNetworkEnv, type NetworkProbe } from './gfw'

function probe(google: boolean | 'never', mirror: boolean | 'never'): NetworkProbe {
  const answer = (value: boolean | 'never') => value === 'never' ? new Promise<boolean>(() => {}) : Promise.resolve(value)
  return (origin) => answer(origin.includes('google') ? google : mirror)
}

describe('detectNetworkEnv', () => {
  it('is global whenever Google answers, even when the mirror answers too', async () => {
    expect(await detectNetworkEnv(probe(true, true))).toBe('global')
    expect(await detectNetworkEnv(probe(true, false))).toBe('global')
  })

  it('does not wait for the mirror once Google answered', async () => {
    expect(await detectNetworkEnv(probe(true, 'never'))).toBe('global')
  })

  it('is mainland China only when Google is blocked and the mirror answers', async () => {
    expect(await detectNetworkEnv(probe(false, true))).toBe('cn')
  })

  it('keeps official sources when offline', async () => {
    expect(await detectNetworkEnv(probe(false, false))).toBe('global')
  })
})
