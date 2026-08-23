import { handleSpacesRequest } from './handler.ts';
import type { PublicSpaceResolver } from './types.ts';

/** Production remains read-only and unpublished until an approved resolver is wired. */
const unpublishedResolver: PublicSpaceResolver = Object.freeze({
  async resolve() {
    return null;
  }
});

export function handleProductionRequest(request: Request): Promise<Response> {
  return handleSpacesRequest(request, unpublishedResolver);
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleProductionRequest(request);
  }
} satisfies ExportedHandler<Env>;
