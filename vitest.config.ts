import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // The desktop renderer's `@/` alias (tsconfig.web.json); no other package uses the prefix.
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('apps/desktop/src/renderer/src/', import.meta.url)),
      },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            '{apps,packages}/*/{src,test}/**/*.test.ts',
            'vm/{guest-agent,host}/test/**/*.test.ts',
            'test/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          // Renderer components and stores rendered in a DOM (Testing Library).
          name: 'dom',
          environment: 'happy-dom',
          include: ['apps/desktop/src/renderer/src/**/*.test.tsx'],
          setupFiles: ['apps/desktop/src/renderer/src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages}/*/{src,test}/**/*.int.test.ts', 'vm/host/test/**/*.int.test.ts'],
          env: {
            MILIBOT_SECRET_STORE: 'memory',
            MILIBOT_LOG_LEVEL: 'warn',
            // Runtimes spawned by integration tests must never boot a real VM.
            MILIBOT_VM_DISABLED: '1',
            MILIBOT_FAKE_EMBEDDINGS: '1',
          },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
