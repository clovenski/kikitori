const ID = /^[A-Za-z0-9_-]{11}$/;

/** Extracts the video id from a YouTube watch/short/embed/live URL; null for anything else. */
export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (url.pathname === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    return ID.test(v) ? v : null;
  }
  const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
  return m && ID.test(m[1]) ? m[1] : null;
}
