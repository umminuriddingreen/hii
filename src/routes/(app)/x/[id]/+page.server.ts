import { error } from '@sveltejs/kit';
import { getExchangeLink, incrementLinkViews } from '@/lib/server/data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  let link;
  try { link = await getExchangeLink(params.id); } catch { throw error(503, 'Exchange service is not configured.'); }
  if (!link) throw error(404, 'Exchange not found');
  void incrementLinkViews(link.id).catch(() => {});
  return { link };
};
