// Explicit reference capture, never run during build or application startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const origin = 'https://learnharness.ai';
const directory = path.resolve(import.meta.dirname, '../public/about-site');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fetchBytes(resource) {
  const response = await fetch(new URL(resource, origin), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${resource}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const home = await fetchBytes('/');
const css = await fetchBytes('/styles.css');
const html = home.toString('utf8');
const paths = new Set(['/mark.svg', '/styles.css']);
for (const match of html.matchAll(/src="(\/[^"#]+)"/g)) paths.add(match[1]);
for (const match of css.toString('utf8').matchAll(/url\("(\/[^"#]+)"\)/g)) paths.add(match[1]);
const resources = [...paths];
const manifest = { origin, capturedAt: new Date().toISOString(), homeSHA256: hash(home), modifications: ['Local About and asset paths', 'Browser-app navigation link', 'Browser hosting and privacy note'], assets: [] };
await fs.mkdir(directory, { recursive: true });
let done = 0;
console.log(`[reference] 0% (0/${resources.length}) Capturing original website assets`);
await Promise.all(resources.map(async resource => {
  const original = resource === '/styles.css' ? css : await fetchBytes(resource);
  const body = resource === '/styles.css' ? Buffer.from(original.toString('utf8').replaceAll('url("/', 'url("/about-site/')) : original;
  const destination = path.join(directory, resource.slice(1));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, body);
  manifest.assets.push({ path: resource, originalSHA256: hash(original), servedSHA256: hash(body), bytes: body.length });
  done++; console.log(`[reference] ${Math.round(done / resources.length * 100)}% (${done}/${resources.length}) ${resource}`);
}));
const note = '<section class="chapter page-width" aria-labelledby="browser-edition"><div class="section-heading"><h2 id="browser-edition">Browser edition</h2></div><div class="prose"><p>This page describes the original desktop app by Amos Blomqvist. The browser edition at learn.nix.zone keeps learning records and provider keys in your private account on this server. It sends context to your chosen providers when you use teaching, practice, research or dictation.</p><p><a href="/">Open the browser app</a> · <a href="/source">Corresponding source for this port (AGPL-3.0)</a></p></div></section>';
const mirrored = html.replaceAll('href="/styles.css"', 'href="/about-site/styles.css"').replaceAll('href="/mark.svg"', 'href="/about-site/mark.svg"').replaceAll('src="/', 'src="/about-site/').replaceAll('href="/"', 'href="/about/"').replaceAll('href="/#', 'href="/about/#').replaceAll('href="/download/"', 'href="https://learnharness.ai/download/"').replace('</nav>', '<a href="/">Browser app</a></nav>').replace('  </main>', `    ${note}\n  </main>`);
await fs.writeFile(path.join(directory, 'index.html'), mirrored);
manifest.indexSHA256 = hash(Buffer.from(mirrored));
manifest.assets.sort((a, b) => a.path.localeCompare(b.path));
await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
