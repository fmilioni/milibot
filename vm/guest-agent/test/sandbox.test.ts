import { describe, expect, it } from 'vitest'

import { sandboxArgv } from '../src/extract/sandbox.ts'

describe('sandbox', () => {
  it('runs as an unprivileged user in a capped transient scope', () => {
    expect(sandboxArgv(['pdftotext', 'in.pdf', '-'], { uid: 65534, gid: 65534 }, 2048)).toEqual({
      file: '/usr/bin/systemd-run',
      args: [
        '--scope',
        '--quiet',
        '--collect',
        '--property=MemoryMax=2048M',
        '--property=CPUWeight=20',
        '--',
        '/usr/bin/setpriv',
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        '--no-new-privs',
        '--',
        'pdftotext',
        'in.pdf',
        '-',
      ],
    })
  })
})
