import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/unit/workspace-connections.test.ts',
      'tests/unit/workspace-history-frames.test.ts',
      'tests/unit/workspace-layout.test.ts',
      'tests/unit/link-embeds.test.ts',
      'tests/unit/music-playlists.test.ts',
      'tests/unit/workspace-persistence.test.ts',
      'tests/unit/workspace-rebase.test.ts',
      'tests/unit/workspace-scenes.test.ts',
      'tests/unit/workspace-selection.test.ts',
      'tests/unit/workspace-snap.test.ts',
      'tests/unit/workspace-tidy.test.ts',
      'tests/unit/workspace-viewport.test.ts'
    ],
    passWithNoTests: false,
    restoreMocks: true
  }
});
