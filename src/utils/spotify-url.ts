// Links shared from the Spotify apps look like
// https://open.spotify.com/intl-it/track/<id>?si=..., but spotify-uri 3.x only
// understands https://open.spotify.com/track/<id>. Drop the locale segment and
// the tracking query so every Spotify helper receives a parseable URL.
export const normalizeSpotifyUrl = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  if (url.host !== 'open.spotify.com') {
    return input;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.startsWith('intl-')) {
    parts.shift();
  }

  return `https://open.spotify.com/${parts.join('/')}`;
};
