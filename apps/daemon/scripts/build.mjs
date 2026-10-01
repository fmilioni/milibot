import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: {
    main: 'src/main.ts',
    'runtime-main': 'src/runtime-main.ts',
    // Knowledge embeddings run in a child process (see packages/agent/src/embeddings/local.ts).
    'embedding-worker': '../../packages/agent/src/embeddings/local-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  packages: 'bundle',
  // Native addons (and onnxruntime-common, which must be the same instance onnxruntime-node loads; the keyring
  // addon is loaded on demand on Linux/Windows).
  external: ['better-sqlite3', 'onnxruntime-node', 'onnxruntime-common', '@napi-rs/keyring'],
  alias: { sharp: fileURLToPath(new URL('./sharp-stub.mjs', import.meta.url)) },
  define: { __MILIBOT_VERSION__: JSON.stringify(version) },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
})
