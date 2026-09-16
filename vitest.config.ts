import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': new URL('./tests/mocks/primitives.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
