import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_LEARNER_FILE_BYTES = 8 * 1024 * 1024;
export function createLearnerFiles(directory: string) {
  async function entries() {
    try { return await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async function locate(id: string) {
    if (!ID.test(id)) return null;
    const entry = (await entries()).find(entry => entry.isFile() && entry.name.startsWith(`${id}--`));
    if (!entry) return null;
    return { id, name: entry.name.slice(38), path: path.join(directory, entry.name) };
  }
  return {
    async list() {
      const files = await Promise.all((await entries()).filter(entry => entry.isFile() && ID.test(entry.name.slice(0, 36)) && entry.name.slice(36, 38) === '--').map(async entry => {
        const stat = await fs.stat(path.join(directory, entry.name));
        return { id: entry.name.slice(0, 36), name: entry.name.slice(38), path: path.join(directory, entry.name), bytes: stat.size, uploadedAt: stat.mtime.toISOString() };
      }));
      return files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    },
    async put(name: string, bytes: Uint8Array) {
      if (!name || Buffer.byteLength(name) > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error('Use a file name of at most 180 bytes without path separators or control characters.');
      if (bytes.byteLength > MAX_LEARNER_FILE_BYTES) throw new Error('Each file must be 8 MiB or smaller.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const destination = path.join(directory, `${id}--${name}`);
      const temporary = path.join(directory, `.upload-${id}`);
      try {
        await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, destination);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
      return { id, name, path: destination, bytes: bytes.byteLength };
    },
    async read(id: string) {
      const file = await locate(id);
      return file ? { ...file, bytes: await fs.readFile(file.path) } : null;
    },
    async remove(id: string) {
      const file = await locate(id);
      if (!file) return false;
      await fs.unlink(file.path);
      return true;
    },
  };
}
