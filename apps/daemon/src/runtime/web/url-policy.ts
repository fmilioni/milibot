import { BlockList, isIP } from 'node:net'

import { ToolInputError } from '@milibot/agent/tools'

/**
 * Addresses `web_fetch` never connects to: loopback, private networks, link-local, the VM's view of the host
 * (10.0.2.2) and multicast. Hardening against pages steering a bot at local services, not a sandbox: `bash`
 * reaches the same addresses. The fetch script in the VM gets this list as is.
 */
export const BLOCKED_SUBNETS: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['::', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]

const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i
const LOCAL_ONLY = 'web_fetch reads public sites only; for local addresses use bash (curl) or your browser.'

let blocked: BlockList | null = null

function blockList(): BlockList {
  if (blocked) return blocked
  blocked = new BlockList()
  for (const [address, prefix, family] of BLOCKED_SUBNETS) blocked.addSubnet(address, prefix, family)
  return blocked
}

/** IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is checked as the IPv4 address it maps. */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
  if (mapped) return blockList().check(mapped, 'ipv4')
  const family = isIP(ip)
  if (family === 0) return true
  return blockList().check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * A bare domain gets https and http is upgraded (`httpFallback`: the fetch may retry on http when https fails);
 * only public http(s) URLs without credentials pass.
 */
export function normalizeWebUrl(raw: string): { url: URL; httpFallback: boolean } {
  const text = raw.trim()
  if (!text) throw new ToolInputError('"url" is empty')
  const withScheme =
    /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ToolInputError(`not a valid URL: ${clipUrl(text)}`)
  }
  const httpFallback = url.protocol === 'http:'
  if (httpFallback) url.protocol = 'https:'
  if (url.protocol !== 'https:')
    throw new ToolInputError(`only http(s) URLs can be read, not ${url.protocol}`)
  if (url.username || url.password) throw new ToolInputError('URLs with a user or password are not supported')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || LOCAL_NAME.test(host) || (!host.includes('.') && !isIP(host)))
    throw new ToolInputError(LOCAL_ONLY)
  if (isIP(host) && isBlockedAddress(host)) throw new ToolInputError(LOCAL_ONLY)
  url.hash = ''
  return { url, httpFallback }
}

function clipUrl(text: string): string {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}
