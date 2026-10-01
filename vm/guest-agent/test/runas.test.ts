import { describe, expect, it } from 'vitest'

import { LineSplitter } from '../src/procs.ts'
import { buildRunAs, parsePasswd } from '../src/users.ts'

const agent = { name: 'agent', uid: 1500, gid: 1500, home: '/home/agent', shell: '/bin/bash' }

describe('buildRunAs', () => {
  it('drops privileges with setpriv and keeps supplementary groups', () => {
    const spec = buildRunAs({ user: agent, cmd: 'id', display: 3, env: { FOO: 'bar' } })
    expect(spec.file).toBe('/usr/bin/setpriv')
    expect(spec.args).toEqual([
      '--reuid=1500',
      '--regid=1500',
      '--init-groups',
      '--',
      '/bin/bash',
      '-lc',
      'id',
    ])
    expect(spec.env).toMatchObject({ HOME: '/home/agent', USER: 'agent', DISPLAY: ':3', FOO: 'bar' })
  })

  it('passes argv through exec without shell interpolation', () => {
    const spec = buildRunAs({ user: agent, argv: ['claude', '-p', '$(whoami)'] })
    expect(spec.args.slice(-5)).toEqual(['-lc', 'exec "$0" "$@"', 'claude', '-p', '$(whoami)'])
  })

  it('validates input', () => {
    expect(() => buildRunAs({ user: agent })).toThrow()
    expect(() => buildRunAs({ user: agent, cmd: 'x', env: { 'BAD-NAME': 'x' } })).toThrow(/env/)
  })
})

describe('parsePasswd', () => {
  it('parses entries', () => {
    expect(
      parsePasswd('root:x:0:0:root:/root:/bin/bash\nagent:x:1500:1500::/home/agent:/bin/bash\n'),
    ).toEqual([
      { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
      { name: 'agent', uid: 1500, gid: 1500, home: '/home/agent', shell: '/bin/bash' },
    ])
  })
})

describe('LineSplitter', () => {
  it('splits across chunks, handles multibyte boundaries and flushes the tail', () => {
    const lines: Array<[string, boolean]> = []
    const s = new LineSplitter((l, p) => lines.push([l, p]))
    const euro = Buffer.from('€')
    s.push(Buffer.from('{"a":1}\n{"b":'))
    s.push(Buffer.concat([Buffer.from('"'), euro.subarray(0, 1)]))
    s.push(Buffer.concat([euro.subarray(1), Buffer.from('"}\ntail')]))
    s.flush()
    expect(lines).toEqual([
      ['{"a":1}', false],
      ['{"b":"€"}', false],
      ['tail', true],
    ])
  })
})
