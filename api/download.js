// Video downloader backend for /video/.
//
// POST /api/download  {url}            -> resolves a post link into downloadable files
// GET  /api/download?file=..&name=..   -> streams one of those files back as an attachment,
//                                         so the browser saves it instead of playing it.
//
// Supported: TikTok (via tikwm.com) and X/Twitter (via api.fxtwitter.com).
// If COBALT_API_URL is set, any other link is tried against that cobalt instance.

import { Readable } from 'node:stream';

export const config = { maxDuration: 60 };

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

// Only media from these hosts may be streamed through /api/download?file=,
// so the endpoint can't be used as an open proxy.
const MEDIA_HOSTS = [
  'tikwm.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com',
  'tiktokv.us', 'tiktokv.eu', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'muscdn.com',
  'video.twimg.com', 'pbs.twimg.com'
];

function allowedMedia(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return MEDIA_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch { return false; }
}

function safeName(s, ext) {
  const base = String(s || 'video').replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
  return base + '.' + ext;
}

function proxied(file, name) {
  return '/api/download?file=' + encodeURIComponent(file) + '&name=' + encodeURIComponent(name);
}

class UserError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function tiktok(url) {
  const r = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ url, hd: '1' })
  });
  if (!r.ok) throw new UserError('fetch.fail');
  const j = await r.json();
  if (j.code !== 0 || !j.data) throw new UserError(/private/i.test(j.msg || '') ? 'private' : 'unavailable');
  const d = j.data;
  const abs = u => (u && u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  const title = d.title || (d.author && d.author.unique_id) || 'tiktok';
  const items = [];
  if (Array.isArray(d.images) && d.images.length) {
    d.images.forEach((img, i) => items.push({ type: 'photo', url: proxied(abs(img), safeName(title + ' ' + (i + 1), 'jpg')), thumb: abs(img) }));
  } else {
    if (d.hdplay) items.push({ type: 'video', hd: true, url: proxied(abs(d.hdplay), safeName(title, 'mp4')) });
    if (d.play) items.push({ type: 'video', hd: false, url: proxied(abs(d.play), safeName(title, 'mp4')) });
  }
  if (d.music) items.push({ type: 'audio', url: proxied(abs(d.music), safeName(title, 'mp3')) });
  return { title, thumb: abs(d.cover || d.origin_cover), items };
}

async function twitter(url) {
  const id = (url.match(/\/status(?:es)?\/(\d+)/) || [])[1];
  if (!id) throw new UserError('link.invalid');
  const r = await fetch('https://api.fxtwitter.com/status/' + id, { headers: { 'User-Agent': UA } });
  if (r.status === 404) throw new UserError('unavailable');
  if (!r.ok) throw new UserError('fetch.fail');
  const j = await r.json();
  const t = j.tweet;
  if (!t) throw new UserError('unavailable');
  const title = (t.author && t.author.screen_name ? t.author.screen_name + ' ' : '') + id;
  const media = t.media || {};
  const items = [];
  (media.videos || []).forEach((v, i) => items.push({ type: 'video', hd: true, url: proxied(v.url, safeName(title + (i ? '-' + (i + 1) : ''), 'mp4')), thumb: v.thumbnail_url }));
  (media.photos || []).forEach((p, i) => items.push({ type: 'photo', url: proxied(p.url, safeName(title + '-' + (i + 1), 'jpg')), thumb: p.url }));
  if (!items.length) throw new UserError('empty');
  return { title, thumb: items[0].thumb, items };
}

async function cobalt(url) {
  const base = process.env.COBALT_API_URL;
  if (!base) throw new UserError('unsupported');
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (process.env.COBALT_API_KEY) h.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;
  const r = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ url, filenameStyle: 'basic' }) });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'tunnel' || j.status === 'redirect') {
    return { title: j.filename || 'video', items: [{ type: 'video', hd: true, url: j.url, direct: true }] };
  }
  if (j.status === 'picker') {
    return { title: 'media', items: (j.picker || []).map(p => ({ type: p.type === 'photo' ? 'photo' : 'video', url: p.url, thumb: p.thumb, direct: true })) };
  }
  throw new UserError('unavailable');
}

async function resolve(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { throw new UserError('link.invalid'); }
  if (/(^|\.)tiktok\.com$/.test(host)) return tiktok(url);
  if (/(^|\.)(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com)$/.test(host)) return twitter(url);
  return cobalt(url);
}

async function stream(req, res) {
  const file = String(req.query.file || '');
  if (!allowedMedia(file)) { res.status(400).json({ error: 'link.invalid' }); return; }
  const up = await fetch(file, { headers: { 'User-Agent': UA, Referer: 'https://www.tikwm.com/' } });
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
  try {
    if (req.method === 'GET' && req.query && req.query.file) return await stream(req, res);
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const url = String((req.body && req.body.url) || '').trim();
    const m = url.match(/https?:\/\/\S+/);
    if (!m) { res.status(400).json({ error: 'link.invalid' }); return; }
    const out = await resolve(m[0]);
    if (!out.items.length) throw new UserError('empty');
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof UserError) { res.status(422).json({ error: e.code }); return; }
    console.error('download error', e);
    res.status(502).json({ error: 'fetch.fail' });
  }
}
