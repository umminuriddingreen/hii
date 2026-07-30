import { rm } from 'node:fs/promises';

const cloudflareOutput = new URL('../.svelte-kit/cloudflare/', import.meta.url);
const excludedPublicAssets = ['.DS_Store', 'downloads', 'vendor'];

await Promise.all(
  excludedPublicAssets.map((path) =>
    rm(new URL(path, cloudflareOutput), { recursive: true, force: true })
  )
);
