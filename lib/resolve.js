// Finds the downloadable files behind a post link. Shared by the Vercel API
// (api/download.js) and the Android app, which runs it on the phone itself.
//
// Supported: TikTok (via tikwm.com), X/Twitter (via api.fxtwitter.com), public
// Instagram posts/reels and public Facebook videos/reels (read from their own pages).
// If COBALT_API_URL is set (server only), any other link is tried against that cobalt instance.

export const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

// Only media from these hosts may be streamed through /api/download?file=,
// so the endpoint can't be used as an open proxy.
const MEDIA_HOSTS = [
  'tikwm.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com',
  'tiktokv.us', 'tiktokv.eu', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'muscdn.com',
  'video.twimg.com', 'pbs.twimg.com', 'cdninstagram.com', 'fbcdn.net',
  'googlevideo.com', 'ytimg.com', 'sc-cdn.net', 'snapchat.com', 'pinimg.com'
];
// Public YouTube front-ends that hand out (and proxy) the video streams themselves.
const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee'];
const INVIDIOUS = ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be'];
const FRONTEND_HOST = /(^|\.)(piped[a-z0-9-]*|pipedproxy[a-z0-9-]*|inv|invidious[a-z0-9-]*|yewtu)\./i;


// Some CDNs check where a request comes from; send each the site it expects (or none).
export function mediaHeaders(u) {
  const h = { 'User-Agent': UA };
  let host = '';
  try { host = new URL(u).hostname; } catch { return h; }
  if (/tikwm\.com|tiktokcdn|tiktokv|byteoversea|ibyte|muscdn/.test(host)) h.Referer = 'https://www.tikwm.com/';
  else if (/twimg\.com$/.test(host)) h.Referer = 'https://x.com/';
  else if (/cdninstagram\.com$/.test(host)) h.Referer = 'https://www.instagram.com/';
  else if (/fbcdn\.net$/.test(host)) h.Referer = 'https://www.facebook.com/';
  else if (/pinimg\.com$/.test(host)) h.Referer = 'https://www.pinterest.com/';
  return h;
}

export function allowedMedia(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return MEDIA_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h)) || FRONTEND_HOST.test(hostname);
  } catch { return false; }
}

export function safeName(s, ext) {
  const base = String(s || 'video').replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
  return base + '.' + ext;
}

function proxied(file, name) {
  return '/api/download?file=' + encodeURIComponent(file) + '&name=' + encodeURIComponent(name);
}

export class UserError extends Error {
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
  // The post's own text (without trailing t.co links) is the title; the account name if it has none.
  const text = (t.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const who = t.author ? (t.author.name || t.author.screen_name || '') : '';
  const title = (text || who || 'X ' + id).slice(0, 140);
  const media = t.media || {};
  const items = [];
  (media.videos || []).forEach((v, i) => {
    // Pick a real MP4 (highest bitrate), never the .m3u8 streaming playlist.
    const mp4s = [...(v.formats || []), ...(v.variants || [])]
      .filter(f => f && f.url && (f.container === 'mp4' || /video\/mp4/.test(f.content_type || '') || /\.mp4(\?|$)/.test(f.url)))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const file = (mp4s[0] && mp4s[0].url) || (/\.m3u8(\?|$)/.test(v.url || '') ? '' : v.url);
    if (!file) return;
    items.push({ type: 'video', hd: true, url: proxied(file, safeName(title + (i ? ' ' + (i + 1) : ''), 'mp4')), file, thumb: v.thumbnail_url });
  });
  (media.photos || []).forEach((p, i) => items.push({ type: 'photo', url: proxied(p.url, safeName(title + ' ' + (i + 1), 'jpg')), file: p.url, thumb: p.url }));
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
  // Other \uXXXX escapes (e.g. \u002F in Next.js data); quotes and backslashes stay escaped.
  h = h.replace(/\\u([0-9a-fA-F]{4})/g, (m, x) => (/^00(22|5[cC])$/.test(x) ? m : String.fromCharCode(parseInt(x, 16))));
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
    u = new URL(r.url || url);   // the Android app's native fetch leaves r.url empty
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
export async function addSizes(items) {
  await Promise.all(items.map(async it => {
    if (!it.file || it.type === 'photo') return;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(it.file, { method: 'HEAD', headers: mediaHeaders(it.file), signal: ctl.signal });
      clearTimeout(t);
      const n = Number(r.headers.get('content-length'));
      if (r.ok && n > 0) it.size = n;
    } catch { /* size stays unknown */ }
  }));
  // `direct` lets the page fetch straight from the CDN when CORS allows, skipping this function.
  items.forEach(it => { if (it.file) it.direct = it.file; delete it.file; });
}

async function cobalt(url) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const base = env.COBALT_API_URL;
  if (!base) throw new UserError('unsupported');
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (env.COBALT_API_KEY) h.Authorization = 'Api-Key ' + env.COBALT_API_KEY;
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
  ['browser_native_hd_url', true], ['playable_url_quality_hd', true], ['hd_src', true], ['progressive_hd', true],
  ['browser_native_sd_url', false], ['playable_url', false], ['sd_src', false], ['progressive_sd', false], ['any_mp4', false]
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

// Caption, uploader and picture from any of the fetched Facebook pages.
function fbInfo(pages) {
  const ent = v => v.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const weak = t => !t || /^(facebook|video|watch|reels?|log in.*|facebook video)$/i.test(t.trim());
  // "Caption | By Name | Facebook" -> "Caption"
  const clean = t => ent((t || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))).replace(/\s*\|\s*Facebook\s*$/i, '').replace(/\s*\|\s*By [^|]+$/i, '')
    .replace(/^[\d.,]+[KMB]?\s*views?\s*·\s*[\d.,]+[KMB]?\s*reactions?\s*\|\s*/i, '').replace(/\s+/g, ' ').trim();
  let title = '', author = '', thumb = '';
  for (const p of pages) {
    const html = p.html || '';
    const all = igUnescape(html);
    const meta = n => (html.match(new RegExp('<meta (?:property|name)="og:' + n + '" content="([^"]*)"')) || [])[1] || '';
    const cands = [
      meta('title'), meta('description'),
      // "message":{"delight_ranges":[],...,"text":"caption"}
      (all.match(/"message":\{(?:[^{}]|\{[^{}]*\})*?"text":"([^"]{2,500})"/) || [])[1],
      (all.match(/"title":\{(?:[^{}]|\{[^{}]*\})*?"text":"([^"]{2,500})"/) || [])[1],
      (all.match(/"accessibility_caption":"([^"]{2,500})"/) || [])[1],
      (html.match(/<title>([^<]*)<\/title>/) || [])[1]
    ];
    if (!title) title = cands.map(clean).find(t => !weak(t)) || '';
    if (!author) author = clean((all.match(/"owner":\{(?:[^{}]|\{[^{}]*\})*?"name":"([^"]{2,80})"/) || [])[1] ||
      ((meta('title').match(/\|\s*By ([^|]+)\|/) || [])[1]) || '');
    if (!thumb) thumb = ent(meta('image')) || (all.match(/"preferred_thumbnail":\{"image":\{"uri":"(https:[^"]+)"/) ||
      all.match(/"thumbnailImage":\{"uri":"(https:[^"]+)"/) || all.match(/"first_frame_thumbnail":"(https:[^"]+)"/) || [])[1] || '';
  }
  return { title, author, thumb: thumb || undefined };
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
    // Same search that worked first (raw page, one level of escaping) ...
    for (const [k] of FB_KEYS) {
      const m = page.html.match(new RegExp('"' + k + '":"([^"]+)"'));
      if (m && !found[k]) found[k] = fbUnescape(m[1]);
    }
    // ... then the page with every layer of escaping removed.
    const text = igUnescape(page.html);
    for (const [k] of FB_KEYS) {
      const m = text.match(new RegExp('"' + k + '":"(https:[^"]+)"'));
      if (m && !found[k]) found[k] = m[1];
    }
    // Newer pages: "progressive_url":"https://...","failure_reason":null,"metadata":{"quality":"HD"}
    for (const m of text.matchAll(/"progressive_url":"(https:[^"]+)"[^}]{0,120}?"quality":"(HD|SD)"/g)) {
      const k = m[2] === 'HD' ? 'progressive_hd' : 'progressive_sd';
      if (!found[k]) found[k] = m[1];
    }
    if (!Object.keys(found).length) {
      // Last resort: any progressive .mp4 on Facebook's video CDN in the page.
      const any = text.match(/https:\/\/video[^"'\s<>\\]*?\.fbcdn\.net\/[^"'\s<>\\]+?\.mp4[^"'\s<>\\]*/);
      if (any) found.any_mp4 = any[0];
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
  const pages = [page];
  // The page that had the video (often the embed player) usually has no caption,
  // so fetch the link-preview and normal pages just for the title when needed.
  let info = fbInfo(pages);
  for (const [tag, u, h] of [['c', real, FB_CRAWLER], ['d', real, FB_BROWSER]]) {
    if (info.title) break;
    try { pages.push(await facebookPage(u, h)); info = fbInfo(pages); why += ' t' + tag; } catch { /* keep what we have */ }
  }
  const title = (info.title || info.author || 'Facebook video').replace(/\s+/g, ' ').slice(0, 140);
  const thumb = info.thumb;
  const items = [];
  if (hd) items.push({ type: 'video', hd: true, url: proxied(hd, safeName(title, 'mp4')), file: hd });
  if (sd && sd !== hd) items.push({ type: 'video', hd: false, url: proxied(sd, safeName(title, 'mp4')), file: sd });
  return { title, thumb, items };
}


// ---- YouTube ----
const YT_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

async function youtube(url) {
  const id = (url.match(YT_ID) || [])[1];
  if (!id) throw new UserError('link.invalid');
  const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  let why = '';
  // 1) YouTube's own player API, asking as the Android VR app (gives direct links without a sign-in).
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-YouTube-Client-Name': '28', 'X-YouTube-Client-Version': '1.60.19',
        'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
      },
      body: JSON.stringify({
        videoId: id, contentCheckOk: true, racyCheckOk: true,
        context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US' } }
      })
    });
    why += 'yt:' + r.status;
    if (r.ok) {
      const j = await r.json();
      const st = (j.playabilityStatus || {}).status;
      why += '-' + st;
      if (st === 'OK' && j.streamingData) {
        const title = (j.videoDetails || {}).title || 'YouTube video';
        const muxed = (j.streamingData.formats || []).filter(f => f.url && /video\/mp4/.test(f.mimeType)).sort((a, b) => (b.height || 0) - (a.height || 0));
        const audio = (j.streamingData.adaptiveFormats || []).filter(f => f.url && /audio\/mp4/.test(f.mimeType)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const items = muxed.map((f, i) => ({ type: 'video', hd: i === 0, label: f.qualityLabel || '', url: proxied(f.url, safeName(title, 'mp4')), file: f.url }));
        if (audio) items.push({ type: 'audio', label: 'M4A', url: proxied(audio.url, safeName(title, 'm4a')), file: audio.url });
        if (items.length) return { title, thumb, items };
      }
    }
  } catch { why += 'yt:err'; }
  // 2) Piped instances
  for (const api of PIPED) {
    try {
      const r = await fetch(api + '/streams/' + id);
      why += ' p:' + r.status;
      if (!r.ok) continue;
      const j = await r.json();
      const title = j.title || 'YouTube video';
      const vids = (j.videoStreams || []).filter(v => !v.videoOnly && v.url && /mp4/i.test(v.mimeType || v.format || '')).sort((a, b) => (b.height || 0) - (a.height || 0));
      const aud = (j.audioStreams || []).filter(a => a.url && /mp4|m4a/i.test(a.mimeType || a.format || '')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const items = vids.slice(0, 2).map((v, i) => ({ type: 'video', hd: i === 0, label: v.quality || '', url: proxied(v.url, safeName(title, 'mp4')), file: v.url }));
      if (aud) items.push({ type: 'audio', label: 'M4A', url: proxied(aud.url, safeName(title, 'm4a')), file: aud.url });
      if (items.length) return { title, thumb: j.thumbnailUrl || thumb, items };
    } catch { why += ' p:err'; }
  }
  // 3) Invidious instances (local=true: the instance streams the file itself)
  for (const inv of INVIDIOUS) {
    try {
      const r = await fetch(inv + '/api/v1/videos/' + id + '?local=true');
      why += ' i:' + r.status;
      if (!r.ok) continue;
      const j = await r.json();
      const title = j.title || 'YouTube video';
      const abs = u => (u && u.startsWith('/') ? inv + u : u);
      const vids = (j.formatStreams || []).filter(f => f.url && /mp4/.test(f.type || '')).reverse();
      const aud = (j.adaptiveFormats || []).filter(f => f.url && /audio\/mp4/.test(f.type || '')).sort((a, b) => (+b.bitrate || 0) - (+a.bitrate || 0))[0];
      const items = vids.map((f, i) => ({ type: 'video', hd: i === 0, label: f.qualityLabel || '', url: proxied(abs(f.url), safeName(title, 'mp4')), file: abs(f.url) }));
      if (aud) items.push({ type: 'audio', label: 'M4A', url: proxied(abs(aud.url), safeName(title, 'm4a')), file: abs(aud.url) });
      if (items.length) return { title, thumb, items };
    } catch { why += ' i:err'; }
  }
  throw new UserError('yt.blocked', why.trim());
}

// ---- Pages that carry the video in their own HTML (Snapchat, Pinterest, many others) ----
const PAGE_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' };

function pageMeta(html) {
  const ent = v => (v || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const m = n => ent((html.match(new RegExp('<meta[^>]+(?:property|name)="(?:og|twitter):' + n + '"[^>]+content="([^"]*)"')) ||
    html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="(?:og|twitter):' + n + '"')) || [])[1]);
  return { title: m('title') || ent((html.match(/<title>([^<]*)<\/title>/) || [])[1]), desc: m('description'), image: m('image'), video: m('video:secure_url') || m('video:url') || m('video') || m('player:stream') };
}

async function webPage(url, site, pick) {
  const r = await fetch(url, { headers: PAGE_UA, redirect: 'follow' });
  if (r.status === 404) throw new UserError('unavailable');
  if (!r.ok) throw new UserError('fetch.fail', site + ':' + r.status);
  const raw = await r.text();
  const html = igUnescape(raw);
  const meta = pageMeta(raw);
  const files = [...new Set(pick(html, meta).filter(Boolean))];
  if (!files.length) throw new UserError('empty', site + ':nomedia');
  const title = (meta.title || meta.desc || site).replace(/\s+/g, ' ').trim().slice(0, 140);
  const items = files.slice(0, 2).map((f, i) => {
    const ok = allowedMedia(f);
    return { type: 'video', hd: i === 0, url: ok ? proxied(f, safeName(title, 'mp4')) : f, file: f, direct: ok ? undefined : true };
  });
  return { title, thumb: meta.image || undefined, items };
}

const snapchat = url => webPage(url, 'snap', (h, m) => [
  ...[...h.matchAll(/"(?:mediaUrl|videoUrl|contentUrl|mediaStreamUrl)":"(https:[^"]+)"/g)].map(x => x[1]).filter(u => !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)),
  m.video
]);
const pinterest = url => webPage(url, 'pin', (h, m) => [
  ...[...h.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+?\.mp4/g)].map(x => x[0]).sort((a, b) => (/720p|1080p/.test(b) ? 1 : 0) - (/720p|1080p/.test(a) ? 1 : 0)),
  m.video
]);
const anyPage = url => webPage(url, 'web', (h, m) => [
  m.video && !/\.m3u8|\/embed|youtube\.com/i.test(m.video) ? m.video : '',
  ...[...h.matchAll(/<(?:video|source)[^>]+src="(https:[^"]+\.mp4[^"]*)"/g)].map(x => x[1]),
  (h.match(/"(?:contentUrl|videoUrl|video_url|mp4Url)":"(https:[^"]+\.mp4[^"]*)"/) || [])[1]
]);

export async function resolve(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { throw new UserError('link.invalid'); }
  if (/(^|\.)tiktok\.com$/.test(host)) return tiktok(url);
  if (/(^|\.)(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com)$/.test(host)) return twitter(url);
  if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return instagram(url);
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return facebook(url);
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return youtube(url);
  if (/(^|\.)snapchat\.com$/.test(host)) return snapchat(url);
  if (/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(host)) return pinterest(url);
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  if (env.COBALT_API_URL) return cobalt(url);
  return anyPage(url);
}

