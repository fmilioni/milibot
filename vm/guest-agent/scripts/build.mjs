import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const file = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const { version } = JSON.parse(readFileSync(file('../package.json'), 'utf8'))

// `import text from './file?raw'` (as in Vite, which runs the tests): the file's content as a string.
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
      watchFiles: [args.path],
    }))
  },
}

await build({
  entryPoints: [file('../src/main.ts')],
  outfile: file('../dist/guest-agent.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  define: { 'process.env.GUEST_AGENT_VERSION': JSON.stringify(version) },
  plugins: [rawText],
  logLevel: 'warning',
})
