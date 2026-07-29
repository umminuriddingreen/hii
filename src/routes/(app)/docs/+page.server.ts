import { listHiiDocs } from '@/lib/server/hii-docs';

export function load() {
  return { catalog: listHiiDocs() };
}
