import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    files: {
      assets: 'public'
    },
    env: {
      publicPrefix: 'NEXT_PUBLIC_'
    },
    adapter: adapter({ out: 'build' }),
    alias: {
      '@': '.',
      '@/*': './*'
    }
  }
};

export default config;
