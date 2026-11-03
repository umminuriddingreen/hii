export type AllowedEmbedProvider = 'youtube' | 'vimeo' | 'soundcloud';

export type AllowedEmbed = {
  provider: AllowedEmbedProvider;
  id: string;
  canonicalUrl: string;
  embedUrl: string;
  label: string;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{5,12}$/;

function hostname(url: URL) {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function youtubeId(url: URL): string | null {
  const host = hostname(url);
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) return null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const [kind, id] = url.pathname.split('/').filter(Boolean);
  return ['embed', 'shorts', 'live'].includes(kind) ? id || null : null;
}

/**
 * Turn a user-provided link into one of HII's bounded embed contracts.
 *
 * The returned iframe URL is derived entirely from an allowlisted provider and
 * identifier. Arbitrary HTML, script URLs, credentials, and caller-supplied
 * iframe parameters never cross this boundary.
 */
export function parseAllowedEmbed(input: string): AllowedEmbed | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = hostname(url);
  const ytId = youtubeId(url);
  if (ytId && YOUTUBE_ID.test(ytId)) {
    return {
      provider: 'youtube',
      id: ytId,
      canonicalUrl: `https://www.youtube.com/watch?v=${ytId}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${ytId}?rel=0`,
      label: `YouTube ${ytId}`
    };
  }

  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[0] === 'video' ? parts[1] : parts[0];
    if (id && VIMEO_ID.test(id)) {
      return {
        provider: 'vimeo',
        id,
        canonicalUrl: `https://vimeo.com/${id}`,
        embedUrl: `https://player.vimeo.com/video/${id}`,
        label: `Vimeo ${id}`
      };
    }
  }

  if (host === 'soundcloud.com' || host === 'www.soundcloud.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts.every((part) => /^[A-Za-z0-9_-]{1,100}$/.test(part))) {
      const canonicalUrl = `https://soundcloud.com/${parts.join('/')}`;
      return {
        provider: 'soundcloud',
        id: parts.join('/'),
        canonicalUrl,
        embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonicalUrl)}`,
        label: `SoundCloud ${parts.at(-1)}`
      };
    }
  }

  return null;
}
