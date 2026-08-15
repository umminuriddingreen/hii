import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterNode from '@sveltejs/adapter-node';

const cloudflareBuild = process.env.HII_DEPLOY_TARGET === 'cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    files: {
      assets: 'public'
    },
    env: {
      publicPrefix: 'NEXT_PUBLIC_'
    },
    adapter: cloudflareBuild
      ? adapterCloudflare()
      : adapterNode({ out: 'build' }),
    alias: {
      '@': '.',
      '@/*': './*'
    }
  }
};

export default config;
