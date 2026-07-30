declare global {
  const __HII_TARGET__: 'web' | 'desktop';
  const __HII_DEPLOY_TARGET__: 'cloudflare' | 'local';

  namespace App {}
}

export {};
