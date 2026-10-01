import { describe, expect, it } from 'vitest'

import { imageProtocol } from './images'

describe('imageProtocol', () => {
  it('picks the drawing API from the preset or the base URL', () => {
    expect(imageProtocol(null, 'openrouter')).toBe('openrouter')
    expect(imageProtocol('https://openrouter.ai/api/v1', null)).toBe('openrouter')
    expect(imageProtocol(null, 'google')).toBe('google')
    expect(imageProtocol('https://generativelanguage.googleapis.com/v1beta/openai', null)).toBe('google')
    expect(imageProtocol('https://api.openai.com/v1', null)).toBe('openai_images')
    expect(imageProtocol(null, null)).toBe('openai_images')
  })
})
