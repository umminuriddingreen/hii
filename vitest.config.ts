import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.{ts,js}'],
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: false,
    restoreMocks: true
  }
});
