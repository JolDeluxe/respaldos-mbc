import fs from 'node:fs/promises';
import path from 'node:path';

/** Espacio libre (bytes disponibles) del volumen que contiene `dir` (o su ancestro existente más cercano). */
export async function freeBytes(dir: string): Promise<number> {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const s = await fs.statfs(cur);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      cur = parent;
    }
  }
}

export const GB = 1024 ** 3;
