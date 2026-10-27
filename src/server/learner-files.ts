import { constants } from 'node:os';
import { stores } from './stores.ts';

export function learnerFilesResponse() {
  return stores.learnerFiles.list().then(files => Response.json({ files }, { headers: { 'Cache-Control': 'no-store' } }));
}
export async function uploadLearnerFiles(request: Request) {
  const limit = 16 * 1024 * 1024;
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: 'Choose a file to upload.' }, { status: 400 });
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); return Response.json({ error: 'Upload at most 16 MiB at once.' }, { status: 413 }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let data: FormData;
  try { data = await new Request(request.url, { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }).formData(); }
  catch { return Response.json({ error: 'Submit files using the upload form.' }, { status: 400 }); }
  const files = data.getAll('files').filter((entry): entry is File => entry instanceof File);
  if (files.length < 1 || files.length > 8) return Response.json({ error: 'Choose between one and eight files.' }, { status: 400 });
  const uploaded = [];
  for (const file of files) {
    try { uploaded.push(await stores.learnerFiles.put(file.name, new Uint8Array(await file.arrayBuffer()))); }
    catch (error) {
      const failure = error as NodeJS.ErrnoException;
      const quota = failure.code === 'EDQUOT' || failure.errno === -constants.errno.EDQUOT;
      const full = failure.code === 'ENOSPC';
      return Response.json({ uploaded, error: quota ? 'Your 96 MiB storage quota is full. Remove files you no longer need before uploading more.' : full ? 'Storage is full. Please try again later.' : failure.message }, { status: quota || full ? 507 : 400 });
    }
  }
  return Response.json({ uploaded }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function downloadLearnerFile(id: string) {
  const file = await stores.learnerFiles.read(id);
  if (!file) return Response.json({ error: 'File not found.' }, { status: 404 });
  const filename = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(new Uint8Array(file.bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}
export async function deleteLearnerFile(id: string) {
  const removed = await stores.learnerFiles.remove(id);
  return Response.json(removed ? { ok: true } : { error: 'File not found.' }, { status: removed ? 200 : 404 });
}
