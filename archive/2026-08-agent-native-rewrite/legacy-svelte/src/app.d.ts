declare global {
  const __HII_TARGET__: 'web' | 'desktop';
  const __HII_DEPLOY_TARGET__: 'cloudflare' | 'local';

  namespace App {
    interface Platform {
      env?: {
        HII_REMOTE_USER?: string;
        HII_REMOTE_PASSWORD?: string;
        HII_REMOTE_SESSION_KEY?: string;
      };
    }
  }
}

export {};
