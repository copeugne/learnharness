'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SidebarToggle } from '@/components/sidebar';

type LearnerFile = { id: string; name: string; path: string; bytes: number; uploadedAt: string };
export function LearnerFiles() {
  const [files, setFiles] = useState<LearnerFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreUploadFocus = useRef(false);
  useEffect(() => { if (!busy && restoreUploadFocus.current) { restoreUploadFocus.current = false; input.current?.focus(); } }, [busy]);
  async function refresh() {
    const response = await fetch('/api/files', { cache: 'no-store' });
    if (!response.ok) throw new Error('Your files could not be loaded. Please retry.');
    const body = await response.json(); setFiles(body.files);
  }
  useEffect(() => { void refresh().catch(error => setError(error.message)); }, []);
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = input.current?.files;
    if (!selected?.length || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const body = new FormData(); for (const file of selected) body.append('files', file);
      const response = await fetch('/api/files', { method: 'POST', body });
      const result = await response.json();
      await refresh();
      if (!response.ok) throw new Error(result.error ?? 'The files could not be uploaded. Please retry.');
      if (input.current) input.current.value = '';
      setNotice('Uploaded. Copy a file path into your session when you want the teacher to read it.');
    } catch (error) { setError(error instanceof Error ? error.message : 'The upload failed. Please retry.'); }
    finally { setBusy(false); }
  }
  async function remove(file: LearnerFile) {
    if (busy || !window.confirm(`Delete ${file.name}? This uploaded file will be permanently removed.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('The file could not be removed. Please retry.');
      await refresh(); restoreUploadFocus.current = true; setNotice('File removed. Existing session messages are unchanged.');
    } catch (error) { setError(error instanceof Error ? error.message : 'The file could not be removed.'); }
    finally { setBusy(false); }
  }
  return <div className="flex h-dvh flex-col overflow-hidden">
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3"><SidebarToggle /><h1 className="font-title text-2xl">Learner files</h1><Link href="/" className="ml-auto text-sm underline underline-offset-4">Back to learning</Link></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6"><div className="mx-auto max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">Upload notes, PDFs or images for your teacher to read. These files stay in your private learning space on this server. Uploading alone does not send them to a model provider.</p>
      <p className="text-sm text-muted-foreground">Up to 8 MiB per file and 16 MiB per upload. Your account has 96 MiB of persistent storage for files and learning records.</p>
      <form onSubmit={upload} className="space-y-3"><label htmlFor="learner-upload" className="block text-sm">Choose files</label><input ref={input} id="learner-upload" type="file" multiple required disabled={busy} className="block max-w-full rounded-sm border border-border p-2 text-base" /><Button type="submit" disabled={busy}>{busy ? 'Working…' : 'Upload files'}</Button></form>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {files === null ? error ? <Button type="button" onClick={() => { setError(null); void refresh().catch(error => setError(error.message)); }}>Retry loading files</Button> : <p className="text-sm text-muted-foreground">Loading files…</p> : files.length === 0 ? <p className="text-sm text-muted-foreground">No uploaded files yet.</p> : <ul className="space-y-4">{files.map(file => <li key={file.id} className="space-y-2 rounded-sm border border-border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="break-all text-sm font-medium">{file.name}</strong><span className="text-xs text-muted-foreground">{(file.bytes / 1024).toFixed(1)} KiB</span></div>
        <code className="block select-all break-all text-sm">{file.path}</code>
        <div className="flex flex-wrap items-center gap-4"><Button type="button" size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(file.path); setNotice('File path copied.'); } catch { setError('Select the displayed path and copy it with your browser.'); } }}>Copy path</Button><a href={`/api/files/${file.id}`} className="text-sm underline underline-offset-4">Download</a><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void remove(file)}>Delete file</Button></div>
      </li>)}</ul>}
    </div></div>
  </div>;
}
