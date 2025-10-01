import { createHash } from 'crypto';
import imghash from 'imghash';

// sha256 buffer/string
export function sha256Buffer(buf: Buffer | string) {
  const h = createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

// perceptual hash (pHash) using imghash + sharp
export async function pHash(filePath: string): Promise<string> {
  // 64-bit hash string by default
  const hash = await imghash.hash(filePath, 16, 'hex'); // 16x16 -> 64-bit hash (in hex length 16)
  return hash;
}

// simple stable split by channelId -> train/val/test (80/10/10)
// We can use sha1 mod 100 for determinism.
export function assignSplit(channelId: string): 'train' | 'val' | 'test' {
  const h = createHash('sha1').update(channelId).digest();
  const val = h.readUInt32BE(0) % 100;
  if (val < 80) return 'train';
  if (val < 90) return 'val';
  return 'test';
}
