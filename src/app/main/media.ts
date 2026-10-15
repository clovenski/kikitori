import { createReadStream, existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Repo } from '../../core/db/repo';
import { isUrl } from '../../core/pipeline/real-deps';

/** `bgt-media://job/<id>` -> id, or null for anything else. */
export function parseMediaUrl(url: string): number | null {
  const m = /^bgt-media:\/\/job\/(\d+)\/?(?:[?#].*)?$/.exec(url);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Only the local-file source of an existing job may be served; never an arbitrary path. */
export function resolveMediaPath(repo: Repo, jobId: unknown): string | null {
  if (typeof jobId !== 'number' || !Number.isInteger(jobId) || jobId < 1) return null;
  const job = repo.getJob(jobId);
  if (!job || isUrl(job.source)) return null;
  try {
    return existsSync(job.source) && statSync(job.source).isFile() ? job.source : null;
  } catch {
    return null;
  }
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Parses a single `bytes=` range for a file of `size` bytes. Returns null when the header is missing,
 * malformed or asks for several ranges (the whole file is then served), and 'unsatisfiable' when it
 * points past the end of the file.
 */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
};

/**
 * Serves a local media file with byte-range support. Chromium only lets a <video> seek when the response
 * carries Accept-Ranges and answers Range requests with 206 and Content-Range; net.fetch on a file URL
 * returns a plain 200, which silently breaks seeking.
 */
export async function buildMediaResponse(file: string, rangeHeader: string | null): Promise<Response> {
  const size = (await stat(file)).size;
  const base = {
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
  };
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  }
  if (range === null) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      status: 200,
      headers: { ...base, 'Content-Length': String(size) },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file, { start: range.start, end: range.end })) as ReadableStream, {
    status: 206,
    headers: {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
    },
  });
}
