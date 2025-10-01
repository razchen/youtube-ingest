// ocr.util.ts
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp'; // npm i sharp

interface OcrBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrWord {
  bbox?: OcrBBox;
}
interface OcrData {
  text?: string;
  words?: OcrWord[];
  lines?: { bbox?: OcrBBox }[];
  imageSize?: { width: number; height: number };
}
interface OcrResult {
  data: OcrData;
}

let workerPromise: Promise<Tesseract.Worker> | null = null;
async function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      // Key params for natural images
      await worker.setParameters({
        // Sparse text anywhere on the image
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        // Boost spacing fidelity (helps “CAN'T” etc.)
        preserve_interword_spaces: '1',
        // Avoid tiny dpi that hurts accuracy
        user_defined_dpi: '300',
        // Whitelist loud, thumbnail-ish characters
        tessedit_char_whitelist:
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\'!?.:,@%()[]{}+-/" ',
        // Don’t waste time generating HOCR/TSV unless you need it
        tessjs_create_hocr: '0',
        tessjs_create_tsv: '0',
      });
      return worker;
    })();
  }
  return workerPromise;
}

// Simple union-less sum of boxes area (fast & "good enough" for a % proxy)
function boxesArea(words: OcrWord[]): number {
  let sum = 0;
  for (const w of words) {
    const b = w.bbox;
    if (!b) continue;
    const wdt = Math.max(0, (b.x1 ?? 0) - (b.x0 ?? 0));
    const hgt = Math.max(0, (b.y1 ?? 0) - (b.y0 ?? 0));
    sum += wdt * hgt;
  }
  return sum;
}

// Basic image cleanup for thumbnails: upscale, grayscale, normalize, threshold
async function preprocessForOcr(inputPath: string): Promise<Buffer> {
  const img = sharp(inputPath);
  const meta = await img.metadata();
  const targetWidth =
    meta.width && meta.width < 1600 ? 1600 : meta.width || 1600;

  // Note: threshold value is heuristic; tweak 140–190 depending on your set.
  return await img
    .resize({ width: targetWidth }) // upsample small images
    .grayscale()
    .normalise() // increase contrast
    .threshold(170) // binarize
    .toBuffer();
}

export async function ocrBasic(
  filePath: string,
  // optionally pass native width/height if you already have them
  nativeSize?: { width?: number; height?: number },
): Promise<{ charCount: number; areaPct: number | null; rawText: string }> {
  try {
    const worker = await getWorker();
    const pre = await preprocessForOcr(filePath);

    const result: OcrResult = await worker.recognize(pre);
    const data: OcrData = result.data || {};
    const text = (data.text || '').replace(/\s+/g, ' ').trim();

    // --- areaPct ---
    // Prefer Tesseract’s imageSize; fall back to nativeSize (from imageMeta)
    const imgW = data.imageSize?.width || nativeSize?.width;
    const imgH = data.imageSize?.height || nativeSize?.height;

    let areaPct: number | null = null;
    const words = Array.isArray(data.words) ? data.words : [];
    if (imgW && imgH && imgW > 0 && imgH > 0 && words.length) {
      const total = imgW * imgH;
      const sum = boxesArea(words);
      areaPct = Math.max(0, Math.min(1, sum / total));
    }

    console.log({
      charCount: text.replace(/\s+/g, '').length,
      areaPct: areaPct,
      rawText: text,
    });

    return {
      charCount: text.replace(/\s+/g, '').length,
      areaPct,
      rawText: text,
    };
  } catch (e) {
    return { charCount: 0, areaPct: null, rawText: '' };
  }
}
