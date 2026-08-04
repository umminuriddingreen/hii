import { error } from '@sveltejs/kit';
import { listHiiDocs, readHiiDoc } from '@/lib/server/hii-docs';

export function load({ params }: { params: { slug: string } }) {
  const document = readHiiDoc(params.slug);
  if (!document) error(404, 'HII document not found');
  return { catalog: listHiiDocs(), document };
}
