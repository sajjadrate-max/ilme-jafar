// Video downloader backend for the page in this repo.
//
// POST /api/download  {url}            -> resolves a post link into downloadable files
// GET  /api/download?file=..&name=..   -> streams one of those files back as an attachment,
//                                         so the browser saves it instead of playing it.

import { Readable } from 'node:stream';
import { UserError, allowedMedia, mediaHeaders, resolve, addSizes } from '../lib/resolve.js';

export const config = { maxDuration: 60 };

async function stream(req, res) {
  const file = String(req.query.file || '');
  if (!allowedMedia(file)) { res.status(400).json({ error: 'link.invalid' }); return; }
  const up = await fetch(file, { headers: mediaHeaders(file) });
  if (!up.ok || !up.body) { res.status(502).json({ error: 'fetch.fail' }); return; }
  const name = String(req.query.name || 'video.mp4');
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  const len = up.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  res.setHeader('Content-Disposition', "attachment; filename=\"" + name.replace(/[^\x20-\x7e]|"/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(name));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  Readable.fromWeb(up.body).pipe(res);
}

export default async function handler(req, res) {
  // Public, read-only API: any page (GitHub Pages, the installed app) may call it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET' && req.query && req.query.file) return await stream(req, res);
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const url = String((req.body && req.body.url) || '').trim();
    const m = url.match(/https?:\/\/\S+/);
    if (!m) { res.status(400).json({ error: 'link.invalid' }); return; }
    const out = await resolve(m[0]);
    if (!out.items.length) throw new UserError('empty');
    await addSizes(out.items);
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof UserError) { res.status(422).json({ error: e.code, detail: e.detail }); return; }
    console.error('download error', e);
    res.status(502).json({ error: 'fetch.fail', detail: String(e && e.message || e).slice(0, 80) });
  }
}
