import { join } from 'path';
import { mkdir, unlink, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { getDataDir } from '../../db/index';
import type { BlobDriver } from './types';

// Local-disk blob driver. Used when no S3 / R2 env is set — the default for
// `bun run dev` and self-hosted deploys. Files live under $DATA_DIR/uploads/
// so they share the same persistent location as the SQLite database.

function uploadsRoot(): string {
  return join(getDataDir(), 'uploads');
}

function abs(key: string): string {
  return join(uploadsRoot(), key);
}

async function ensureDirFor(filePath: string): Promise<void> {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) await mkdir(dir, { recursive: true });
}

export function makeLocalBlobDriver(): BlobDriver {
  return {
    kind: 'local',

    async put(key, bytes) {
      const path = abs(key);
      await ensureDirFor(path);
      await writeFile(path, bytes);
    },

    async getBytes(key) {
      const path = abs(key);
      try {
        const f = Bun.file(path);
        if (!(await f.exists())) return null;
        return new Uint8Array(await f.arrayBuffer());
      } catch {
        return null;
      }
    },

    async servingResponse(key, mime) {
      const path = abs(key);
      try {
        const s = await stat(path);
        if (!s.isFile()) return null;
        const file = Bun.file(path);
        return new Response(file, {
          headers: {
            'Content-Type': mime,
            'Content-Length': String(s.size),
            // Attachment ids are immutable + unguessable, cache aggressively.
            'Cache-Control': 'private, max-age=31536000, immutable',
          },
        });
      } catch {
        return null;
      }
    },

    async delete(key) {
      try {
        await unlink(abs(key));
      } catch (e: any) {
        if (e?.code !== 'ENOENT') {
          console.warn(`[blob/local] failed to unlink ${key}:`, e?.message ?? e);
        }
      }
    },

    async deleteMany(keys) {
      if (keys.length === 0) return;
      await Promise.all(keys.map(k => this.delete(k)));
    },
  };
}
