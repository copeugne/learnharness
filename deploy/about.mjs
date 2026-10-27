import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.ttf': 'font/ttf' };
export function loadAbout(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const assets = new Map();
  const files = [{ path: '/index.html', servedSHA256: manifest.indexSHA256 }, ...manifest.assets];
  for (const file of files) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.includes('..')) throw new Error('Invalid About asset path.');
    const body = fs.readFileSync(path.join(directory, file.path.slice(1)));
    if (body.length > 16 * 1024 * 1024) throw new Error('About asset is too large.');
    const hash = createHash('sha256').update(body).digest('hex');
    if (hash !== file.servedSHA256) throw new Error(`About asset hash mismatch: ${file.path}`);
    const type = TYPES[path.extname(file.path)];
    if (!type) throw new Error('Unsupported About asset type.');
    assets.set(file.path === '/index.html' ? '/about/' : `/about-site${file.path}`, { body, type, etag: `"${hash}"` });
  }
  return assets;
}
