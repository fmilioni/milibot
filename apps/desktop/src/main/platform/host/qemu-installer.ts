import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Language } from '@milibot/shared'
import { app, shell } from 'electron'

import { mainText } from '../../app/i18n'
import { shellQuote } from '../exec'

/** macOS: a `.command` file opens in Terminal without asking for automation permission. */
export async function openQemuInstaller(language: Language): Promise<void> {
  // Linux and Windows show the command to copy instead (`GET /host`'s `setup`).
  if (process.platform !== 'darwin') throw new Error('The QEMU installer only runs on macOS')
  const script = [
    '#!/bin/bash',
    'BREW=$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -n1)',
    'if [ -z "$BREW" ]; then',
    `  echo ${shellQuote(mainText(language, 'qemuNoBrew'))}`,
    '  open https://brew.sh',
    '  exit 1',
    'fi',
    `echo ${shellQuote(mainText(language, 'qemuInstalling'))}`,
    `"$BREW" install qemu && echo && echo ${shellQuote(mainText(language, 'qemuInstalled'))}`,
    '',
  ].join('\n')
  const file = join(app.getPath('temp'), 'milibot-install-qemu.command')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  const error = await shell.openPath(file)
  if (error) throw new Error(error)
}
