import type { Reroute } from '@sveltejs/kit';

const publicHomepageHosts = new Set([
  'humaninformationinterface.com',
  'www.humaninformationinterface.com'
]);

export const reroute: Reroute = ({ url }) => {
  if (__HII_DEPLOY_TARGET__ === 'cloudflare') return;
  if (url.pathname === '/' && publicHomepageHosts.has(url.hostname)) return '/landing';
};
