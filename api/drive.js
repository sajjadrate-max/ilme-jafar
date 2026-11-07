// "میرا ڈیٹا" — personal cloud storage backend for /mera-data/.
//
// Files live in Vercel Blob storage (not on the phone). Everything is guarded by one
// password, set in Vercel as the environment variable DRIVE_PASSWORD.
//
// Setup (once, in the Vercel dashboard of this project):
//   1. Storage -> Create -> Blob -> connect it to this project (adds BLOB_READ_WRITE_TOKEN).
//   2. Settings -> Environment Variables -> add DRIVE_PASSWORD = <your password>.
//   3. Redeploy.
//
// All requests send the password in the "x-drive-key" header, except the upload-token
// request made by @vercel/blob/client, which carries it in clientPayload.
//
// GET  /api/drive?path=a/b/            -> { folders:[{name,path}], files:[{name,path,url,size,uploadedAt}] }
// POST /api/drive {action:"mkdir", path:"a/b/"}         -> creates a folder
// POST /api/drive {action:"delete", path:"a/x.pdf"}     -> deletes a file
// POST /api/drive {action:"delete", path:"a/b/"}        -> deletes a folder with everything inside
// POST /api/drive {action:"check"}                      -> verifies the password
// POST /api/drive {type:"blob.generate-client-token"..} -> handled by handleUpload (browser uploads
//                                                          straight to Blob, so any size works)

import { timingSafeEqual } from 'node:crypto';
import { list, del, createFolder } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';

export const config = { maxDuration: 60 };

const ROOT = 'mera-data/';

function sameText(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// Turns a user path into a safe relative path ("" for the root). Folders end with "/".
function clean(p, folder) {
  const parts = String(p || '').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..');
  if (parts.some(s => s.length > 120 || /[\\\u0000-\u001f]/.test(s))) throw new Error('bad.path');
  const out = parts.join('/');
  return folder && out ? out + '/' : out;
}

async function listFolder(rel) {
  const prefix = ROOT + rel;
  const folders = [], files = [];
  let cursor;
  do {
    const r = await list({ prefix, mode: 'folded', cursor, limit: 1000 });
    for (const f of r.folders || []) {
      const path = f.slice(ROOT.length);
      folders.push({ name: path.slice(rel.length).replace(/\/$/, ''), path });
    }
    for (const b of r.blobs) {
      if (b.pathname.endsWith('/')) continue;          // the folder marker itself
      const path = b.pathname.slice(ROOT.length);
      files.push({ name: path.slice(rel.length), path, url: b.url, size: b.size, uploadedAt: b.uploadedAt });
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return { path: rel, folders, files };
}

async function remove(rel) {
  if (!rel) throw new Error('bad.path');                // never wipe the whole drive at once
  if (!rel.endsWith('/')) {
    const r = await list({ prefix: ROOT + rel, limit: 10 });
    const hit = r.blobs.filter(b => b.pathname === ROOT + rel).map(b => b.url);
    if (hit.length) await del(hit);
    return;
  }
  let cursor;
  do {
    const r = await list({ prefix: ROOT + rel, cursor, limit: 1000 });
    const urls = r.blobs.map(b => b.url);
    if (urls.length) await del(urls);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-drive-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const password = process.env.DRIVE_PASSWORD;
  if (!password || !process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'setup', missing: [!password && 'DRIVE_PASSWORD', !process.env.BLOB_READ_WRITE_TOKEN && 'BLOB_READ_WRITE_TOKEN'].filter(Boolean) });
    return;
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  try {
    // Upload token for the browser (and Vercel's upload-completed callback).
    if (req.method === 'POST' && typeof body.type === 'string' && body.type.startsWith('blob.')) {
      const out = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (!sameText(clientPayload, password)) throw new Error('auth');
          if (!pathname.startsWith(ROOT) || clean(pathname.slice(ROOT.length)) !== pathname.slice(ROOT.length)) throw new Error('bad.path');
          return { addRandomSuffix: true, maximumSizeInBytes: 5 * 1024 * 1024 * 1024 };
        }
      });
      res.status(200).json(out);
      return;
    }

    if (!sameText(req.headers['x-drive-key'], password)) { res.status(401).json({ error: 'auth' }); return; }

    if (req.method === 'GET') {
      res.status(200).json(await listFolder(clean(req.query && req.query.path, true)));
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

    if (body.action === 'check') { res.status(200).json({ ok: true }); return; }
    if (body.action === 'mkdir') {
      const rel = clean(body.path, true);
      if (!rel) throw new Error('bad.path');
      await createFolder(ROOT + rel, { access: 'public' });
      res.status(200).json({ ok: true, path: rel });
      return;
    }
    if (body.action === 'delete') {
      const raw = String(body.path || '');
      await remove(clean(raw, raw.endsWith('/')));
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'action' });
  } catch (e) {
    const code = String(e && e.message || e);
    if (code === 'auth') { res.status(401).json({ error: 'auth' }); return; }
    if (code === 'bad.path') { res.status(400).json({ error: 'bad.path' }); return; }
    console.error('drive error', e);
    res.status(502).json({ error: 'server', detail: code.slice(0, 120) });
  }
}
