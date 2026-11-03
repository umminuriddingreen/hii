import { previewResolver } from './fixture.ts';
import { handleSpacesRequest as handleWithResolver } from './handler.ts';
import type { PublicSpaceResolver } from './types.ts';

const PREVIEW_OPTIONS = Object.freeze({
  previewFavicon: true,
  previewIndexLink: Object.freeze({ href: '/s/14th-street', label: 'Open preview' })
});

export async function handleSpacesRequest(
  request: Request,
  resolver: PublicSpaceResolver = previewResolver
): Promise<Response> {
  return handleWithResolver(request, resolver, PREVIEW_OPTIONS);
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleSpacesRequest(request);
  }
} satisfies ExportedHandler<Env>;
