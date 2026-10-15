import { BgtError } from '../errors';

const bad = () => new BgtError('InvalidInput', 'That does not look like a YouTube channel.');
const HANDLE = /^@[\p{L}\p{N}._-]{3,30}$/u;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const NAME = /^[\p{L}\p{N}._-]{1,100}$/u;

/** Turns whatever the user pasted into a canonical channel URL, or throws InvalidInput. */
export function normalizeChannelInput(text: string): string {
  const t = text.trim();
  if (HANDLE.test(t)) return `https://www.youtube.com/${t}`;
  if (CHANNEL_ID.test(t)) return `https://www.youtube.com/channel/${t}`;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw bad();
  }
  if (url.hostname.replace(/^(www|m)\./, '') !== 'youtube.com') throw bad();
  const parts = url.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [first = '', second = ''] = parts;
  if (HANDLE.test(first)) return `https://www.youtube.com/${first}`;
  if (first === 'channel' && CHANNEL_ID.test(second)) return `https://www.youtube.com/channel/${second}`;
  if ((first === 'c' || first === 'user') && NAME.test(second)) return `https://www.youtube.com/${first}/${second}`;
  throw bad();
}
