import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineApi, endpoint, Ok, QueryBool, queryBool } from './endpoint'

describe('defineApi', () => {
  const ping = { ping: endpoint({ method: 'GET', path: '/ping', response: Ok }) }

  it('merges the domain maps', () => {
    const api = defineApi(ping, { pong: endpoint({ method: 'POST', path: '/ping', response: Ok }) })
    expect(Object.keys(api)).toEqual(['ping', 'pong'])
  })

  it('throws on an endpoint name declared twice', () => {
    expect(() =>
      defineApi(ping, { ping: endpoint({ method: 'GET', path: '/other', response: Ok }) }),
    ).toThrow(/Endpoint declared twice: ping/)
  })

  it('throws on a method and path declared twice', () => {
    expect(() =>
      defineApi(ping, { again: endpoint({ method: 'GET', path: '/ping', response: Ok }) }),
    ).toThrow(/Route declared twice: GET \/ping/)
  })

  it('classifies scope by path prefix', () => {
    expect(endpoint({ method: 'GET', path: '/w/:workspaceId/x', response: z.null() }).scope).toBe('workspace')
    expect(endpoint({ method: 'GET', path: '/workspaces/:workspaceId', response: z.null() }).scope).toBe(
      'app',
    )
  })
})

describe('query booleans', () => {
  it('reads URL strings and typed-client booleans, with a default when absent', () => {
    const withTrue = queryBool(true)
    const withFalse = queryBool(false)
    expect(withTrue.parse(undefined)).toBe(true)
    expect(withFalse.parse(undefined)).toBe(false)
    for (const v of ['true', '1', true]) expect(withFalse.parse(v)).toBe(true)
    for (const v of ['false', '0', false]) expect(withTrue.parse(v)).toBe(false)
    expect(withTrue.safeParse('yes').success).toBe(false)
    expect(QueryBool.optional().parse(undefined)).toBeUndefined()
  })
})
