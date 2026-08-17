import { describe, expect, it } from 'vitest';
import { parseAllowedEmbed } from '../../lib/workspace/link-embeds';

describe('bounded link embeds', () => {
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ?t=12', 'youtube', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=private', 'youtube', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789?share=copy', 'vimeo', '123456789', 'https://vimeo.com/123456789'],
    ['https://soundcloud.com/artist-name/track_name?secret_token=s-ignored', 'soundcloud', 'artist-name/track_name', 'https://soundcloud.com/artist-name/track_name']
  ])('canonicalizes %s', (input, provider, id, canonicalUrl) => {
    expect(parseAllowedEmbed(input)).toMatchObject({ provider, id, canonicalUrl });
  });

  it.each([
    'javascript:alert(1)',
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.example/watch?v=dQw4w9WgXcQ',
    'https://example.com/embed/component',
    'https://soundcloud.com/only-one-segment',
    'https://vimeo.com/not-a-number'
  ])('rejects non-allowlisted input %s', (input) => {
    expect(parseAllowedEmbed(input)).toBeNull();
  });
});
