import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@craftcompass/domain': fileURLToPath(
        new URL('./packages/domain/src/index.ts', import.meta.url),
      ),
      '@craftcompass/assurance-engine': fileURLToPath(
        new URL('./packages/assurance-engine/src/index.ts', import.meta.url),
      ),
      '@craftcompass/instruction-compiler': fileURLToPath(
        new URL(
          './packages/instruction-compiler/src/index.ts',
          import.meta.url,
        ),
      ),
      '@craftcompass/mutation-engine': fileURLToPath(
        new URL('./packages/mutation-engine/src/index.ts', import.meta.url),
      ),
      '@craftcompass/providers-pitest': fileURLToPath(
        new URL('./packages/providers-pitest/src/index.ts', import.meta.url),
      ),
      '@craftcompass/providers-filesystem': fileURLToPath(
        new URL(
          './packages/providers-filesystem/src/index.ts',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
