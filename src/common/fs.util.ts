import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';

export function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export async function downloadToFile(
  url: string,
  destPath: string,
): Promise<void> {
  const dir = path.dirname(destPath);
  ensureDir(dir);
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
  });
  await fs.promises.writeFile(destPath, resp.data);
}

export async function imageMeta(
  filePath: string,
): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(filePath).metadata();
    return { width: meta.width, height: meta.height };
  } catch {
    return {};
  }
}

export function writeJsonl(filePath: string, records: any[]) {
  ensureDir(path.dirname(filePath));
  const lines = records.map((r) => JSON.stringify(r));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function writeCsv(filePath: string, headers: string[], rows: any[][]) {
  ensureDir(path.dirname(filePath));
  const out =
    [headers.join(',')]
      .concat(rows.map((r) => r.map(csvEscape).join(',')))
      .join('\n') + '\n';
  fs.writeFileSync(filePath, out, 'utf8');
}
