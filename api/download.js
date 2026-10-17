// Video downloader backend for /video/.
//
// POST /api/download  {url}            -> resolves a post link into downloadable files
// GET  /api/download?file=..&name=..   -> streams one of those files back as an attachment,
//                                         so the browser saves it instead of playing it.
//
// Supported: TikTok (via tikwm.com), X/Twitter (via api.fxtwitter.com) and public
// Instagram posts/reels (Instagram's own web endpoints, no login) and public Facebook
// videos/reels (read from the post page).
// Deployed with the page on Vercel (video-downloader-rho-five.vercel.app); same-origin calls.
// If COBALT_API_URL is set, any other link is tried against that cobalt instance.

import { Readable } from 'node:stream';

export const config = { maxDuration: 60 };

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

// Only media from these hosts may be streamed through /api/download?file=,
// so the endpoint can't be used as an open proxy.
const MEDIA_HOSTS = [
  'tikwm.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com',
  'tiktokv.us', 'tiktokv.eu', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'muscdn.com',
  'video.twimg.com', 'pbs.twimg.com', 'cdninstagram.com', 'fbcdn.net'
];


function allowedMedia(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return MEDIA_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch { return false; }
}

function safeName(s, ext) {
  const base = String(s || 'video').replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
  return base + '.' + ext;
}

function proxied(file, name) {
  return '/api/download?file=' + encodeURIComponent(file) + '&name=' + encodeURIComponent(name);
}

class UserError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
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
    if (d.hdplay) items.push({ type: 'video', hd: true, url: proxied(abs(d.hdplay), safeName(title, 'mp4')), file: abs(d.hdplay) });
    if (d.play) items.push({ type: 'video', hd: false, url: proxied(abs(d.play), safeName(title, 'mp4')), file: abs(d.play) });
  }
  if (d.music) items.push({ type: 'audio', url: proxied(abs(d.music), safeName(title, 'mp3')), file: abs(d.music) });
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
  (media.videos || []).forEach((v, i) => items.push({ type: 'video', hd: true, url: proxied(v.url, safeName(title + (i ? '-' + (i + 1) : ''), 'mp4')), file: v.url, thumb: v.thumbnail_url }));
  (media.photos || []).forEach((p, i) => items.push({ type: 'photo', url: proxied(p.url, safeName(title + '-' + (i + 1), 'jpg')), thumb: p.url }));
  if (!items.length) throw new UserError('empty');
  return { title, thumb: items[0].thumb, items };
}

const IG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'X-IG-App-ID': '936619743392459',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Instagram pages escape JSON several layers deep (\\\"video_url\\\":\\\"https:\\\/\\\/...).
function igUnescape(h) {
  for (let i = 0; i < 4; i++) {
    const n = h.replace(/\\+u0026/g, '&').replace(/\\+u0025/g, '%').replace(/\\+\//g, '/').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (n === h) break;
    h = n;
  }
  return h.replace(/&amp;/g, '&');
}

// Instagram's GraphQL wants a csrftoken cookie that a plain page visit hands out.
async function igSession() {
  try {
    const r = await fetch('https://www.instagram.com/', { headers: { ...IG_HEADERS, Accept: 'text/html' } });
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).join('; ');
    const csrf = (cookies.match(/csrftoken=([^;,\s]+)/) || [])[1] || '';
    const cookie = ['csrftoken', 'mid', 'ig_did', 'datr'].map(k => { const m = cookies.match(new RegExp(k + '=([^;,\\s]+)')); return m ? k + '=' + m[1] : ''; }).filter(Boolean).join('; ');
    return { csrf, cookie };
  } catch { return { csrf: '', cookie: '' }; }
}

function igMediaFrom(obj) {
  // GraphQL answers use either data.xdt_shortcode_media or data.shortcode_media / graphql.shortcode_media.
  const d = obj && (obj.data || obj.graphql || (obj.items && { shortcode_media: obj.items[0] }));
  return d && (d.xdt_shortcode_media || d.shortcode_media) || null;
}

async function instagram(url) {
  let u = new URL(url);
  // Share links (instagram.com/share/...) redirect to the real /reel/<code>/ address.
  if (u.pathname.startsWith('/share/')) {
    const r = await fetch(url, { headers: IG_HEADERS, redirect: 'follow' });
    u = new URL(r.url);
  }
  const code = (u.pathname.match(/\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!code) throw new UserError('link.invalid');

  let media = null, why = '';
  const sess = await igSession();
  why += 'csrf:' + (sess.csrf ? 'y' : 'n');

  // 1) GraphQL, a few known endpoint / query-id combinations.
  const tries = [
    ['https://www.instagram.com/graphql/query', '8845758582119845'],
    ['https://www.instagram.com/api/graphql', '8845758582119845'],
    ['https://www.instagram.com/api/graphql', '10015901848480474']
  ];
  for (const [endpoint, docId] of tries) {
    if (media) break;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...IG_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*',
          'X-FB-LSD': 'AVqbxe3J_YA', 'X-ASBD-ID': '129477', 'X-CSRFToken': sess.csrf || 'missing',
          'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery', 'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://www.instagram.com', Referer: 'https://www.instagram.com/reel/' + code + '/',
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
          ...(sess.cookie ? { Cookie: sess.cookie } : {})
        },
        body: new URLSearchParams({
          av: '0', __d: 'www', __user: '0', __a: '1', __req: '3', dpr: '2', __ccg: 'UNKNOWN', lsd: 'AVqbxe3J_YA', jazoest: '2957',
          fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery', server_timestamps: 'true',
          variables: JSON.stringify({ shortcode: code, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null }),
          doc_id: docId
        })
      });
      why += ' g' + (endpoint.includes('/api/') ? 'a' : 'q') + ':' + r.status;
      if (r.ok) { media = igMediaFrom(await r.json().catch(() => null)); if (!media) why += '-empty'; }
    } catch { why += ' g:err'; }
  }

  // 2) Old JSON view of the post page (works for some public posts without login).
  if (!media) {
    try {
      const r = await fetch('https://www.instagram.com/p/' + code + '/?__a=1&__d=dis', { headers: { ...IG_HEADERS, Accept: 'application/json', ...(sess.cookie ? { Cookie: sess.cookie } : {}) } });
      why += ' a1:' + r.status;
      if (r.ok) media = igMediaFrom(await r.json().catch(() => null));
    } catch { why += ' a1:err'; }
  }

  const items = [];
  let title = code, thumb;
  if (media) {
    const cap = media.edge_media_to_caption && media.edge_media_to_caption.edges[0];
    title = (cap && cap.node.text) || (media.caption && media.caption.text) || (media.owner && media.owner.username) || (media.user && media.user.username) || code;
    thumb = media.display_url || (media.image_versions2 && media.image_versions2.candidates[0].url);
    const nodes = media.edge_sidecar_to_children ? media.edge_sidecar_to_children.edges.map(e => e.node) : media.carousel_media || [media];
    nodes.forEach((n, i) => {
      const nm = title + (nodes.length > 1 ? ' ' + (i + 1) : '');
      const v = n.video_url || (n.video_versions && n.video_versions[0] && n.video_versions[0].url);
      const img = n.display_url || (n.image_versions2 && n.image_versions2.candidates[0].url);
      if (v) items.push({ type: 'video', hd: true, url: proxied(v, safeName(nm, 'mp4')), file: v, thumb: img });
      else if (img) items.push({ type: 'photo', url: proxied(img, safeName(nm, 'jpg')), file: img, thumb: img });
    });
  }

  // 3) Public embed page; its JSON is escaped several layers deep.
  if (!items.length) {
    for (const path of ['/p/' + code + '/embed/captioned/', '/reel/' + code + '/embed/']) {
      try {
        const r = await fetch('https://www.instagram.com' + path, { headers: { ...IG_HEADERS, Accept: 'text/html' } });
        why += ' e:' + r.status;
        if (!r.ok) continue;
        const html = igUnescape(await r.text());
        const vid = (html.match(/"video_url":"(https:[^"]+)"/) || [])[1];
        const img = (html.match(/"display_url":"(https:[^"]+)"/) || html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || [])[1];
        const user = (html.match(/"username":"([^"]+)"/) || [])[1];
        if (user) title = user + ' ' + code;
        thumb = thumb || img;
        if (vid) { items.push({ type: 'video', hd: true, url: proxied(vid, safeName(title, 'mp4')), file: vid, thumb: img }); break; }
        if (!/\/reels?\//.test(u.pathname) && img) { items.push({ type: 'photo', url: proxied(img, safeName(title, 'jpg')), file: img, thumb: img }); break; }
        why += '-nomedia';
      } catch { why += ' e:err'; }
    }
  }
  if (!items.length) throw new UserError('ig.blocked', why.trim());
  return { title, thumb, items };
}

// Fill in file sizes (for the "21.0 MB" label) with quick HEAD requests.
async function addSizes(items) {
  await Promise.all(items.map(async it => {
    if (!it.file || it.type === 'photo') return;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(it.file, { method: 'HEAD', headers: { 'User-Agent': UA, Referer: 'https://www.tikwm.com/' }, signal: ctl.signal });
      clearTimeout(t);
      const n = Number(r.headers.get('content-length'));
      if (r.ok && n > 0) it.size = n;
    } catch { /* size stays unknown */ }
  }));
  items.forEach(it => { delete it.file; });
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

// Facebook puts the video's direct addresses in JSON inside the post page.
const FB_KEYS = [
  ['browser_native_hd_url', true], ['playable_url_quality_hd', true], ['hd_src', true],
  ['browser_native_sd_url', false], ['playable_url', false], ['sd_src', false]
];

function fbUnescape(v) {
  try { return JSON.parse('"' + v + '"'); } catch { return v.replace(/\\\//g, '/'); }
}

// Header sets Facebook accepts. A partial set (e.g. only Sec-Fetch-Mode) gets HTTP 400.
const FB_BROWSER = {
  'User-Agent': IG_HEADERS['User-Agent'],
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"'
};
// Facebook's own link-preview crawler; public videos get og:video tags.
const FB_CRAWLER = { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', Accept: '*/*' };

async function facebookPage(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  return { status: r.status, finalUrl: r.url, html: r.ok ? await r.text() : '' };
}

// /share/v/... and fb.watch links redirect to the real /reel/ or /videos/ address.
async function facebookCanonical(url) {
  if (!/\/share\/|fb\.watch/.test(url)) return url;
  for (const h of [FB_BROWSER, FB_CRAWLER]) {
    try {
      const r = await fetch(url, { headers: h, redirect: 'manual' });
      const loc = r.headers.get('location');
      if (loc && !/\/login/.test(loc)) return new URL(loc, url).href;
    } catch { /* try the next header set */ }
  }
  return url;
}

async function facebook(url) {
  const real = await facebookCanonical(url);
  const attempts = [
    ['e', 'https://www.facebook.com/plugins/video.php?show_text=false&href=' + encodeURIComponent(real), FB_BROWSER],
    ['d', real, FB_BROWSER],
    ['c', real, FB_CRAWLER],
    ['b', real.replace('://www.', '://mbasic.').replace('://m.', '://mbasic.'), { ...FB_BROWSER, 'User-Agent': UA, 'Sec-Ch-Ua-Mobile': '?1', 'Sec-Ch-Ua-Platform': '"Android"' }]
  ];
  let why = real !== url ? 'r ' : '';
  const found = {};
  let page = { html: '', finalUrl: url }, best = page;
  for (const [tag, u, h] of attempts) {
    try { page = await facebookPage(u, h); } catch { why += tag + ':err '; continue; }
    why += tag + ':' + page.status + (/\/login/.test(page.finalUrl) ? '-login' : '') + ' ';
    for (const [k] of FB_KEYS) {
      const m = page.html.match(new RegExp('"' + k + '":"([^"]+)"'));
      if (m && !found[k]) found[k] = fbUnescape(m[1]);
    }
    // mbasic pages link the file directly: /video_redirect/?src=<encoded mp4>
    const vr = page.html.match(/video_redirect\/\?src=([^"&]+)/);
    if (vr && !found.sd_src) found.sd_src = decodeURIComponent(vr[1].replace(/&amp;/g, '&'));
    const og = page.html.match(/<meta property="og:video(?::secure_url|:url)?" content="([^"]+)"/);
    if (og && !found.og) found.og = og[1].replace(/&amp;/g, '&');
    if (/og:title/.test(page.html) && !/og:title/.test(best.html)) best = page;
    if (Object.keys(found).length) break;
  }
  why = why.trim();
  if (/og:title/.test(best.html)) page = best;
  const hd = FB_KEYS.filter(([, h]) => h).map(([k]) => found[k]).find(Boolean);
  const sd = FB_KEYS.filter(([, h]) => !h).map(([k]) => found[k]).find(Boolean) || found.og;
  if (!hd && !sd) throw new UserError('fb.blocked', why + '-nomedia');
  const meta = n => ((page.html.match(new RegExp('<meta property="og:' + n + '" content="([^"]*)"')) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
  const title = meta('title') || (page.html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'facebook video';
  const thumb = meta('image') || undefined;
  const items = [];
  if (hd) items.push({ type: 'video', hd: true, url: proxied(hd, safeName(title, 'mp4')), file: hd });
  if (sd && sd !== hd) items.push({ type: 'video', hd: false, url: proxied(sd, safeName(title, 'mp4')), file: sd });
  return { title, thumb, items };
}

async function resolve(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { throw new UserError('link.invalid'); }
  if (/(^|\.)tiktok\.com$/.test(host)) return tiktok(url);
  if (/(^|\.)(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com)$/.test(host)) return twitter(url);
  if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return instagram(url);
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return facebook(url);
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
