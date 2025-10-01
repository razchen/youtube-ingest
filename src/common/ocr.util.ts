import { createWorker } from 'tesseract.js';

interface OcrWord {
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

interface OcrData {
  text?: string;
  words?: OcrWord[];
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
      return worker;
    })();
  }
  return workerPromise;
}

export async function ocrBasic(
  filePath: string,
): Promise<{ charCount: number; areaPct: number | null }> {
  try {
    const worker = await getWorker();
    const result: OcrResult = await worker.recognize(filePath);
    const data: OcrData = result.data;
    const text: string = data.text ?? '';
    let areaPct: number | null = null;

    if (Array.isArray(data.words) && data.words.length) {
      const imgW = data.imageSize?.width;
      const imgH = data.imageSize?.height;
      if (imgW && imgH) {
        const totalArea = imgW * imgH;
        const boxesArea = data.words.reduce((acc: number, w: OcrWord) => {
          const bb = w.bbox;
          if (!bb) return acc;
          const wdt = Math.max(0, (bb.x1 ?? 0) - (bb.x0 ?? 0));
          const hgt = Math.max(0, (bb.y1 ?? 0) - (bb.y0 ?? 0));
          return acc + wdt * hgt;
        }, 0);
        if (totalArea > 0) {
          areaPct = boxesArea / totalArea;
        }
      }
    }

    return {
      charCount: text.replace(/\s+/g, '').length,
      areaPct,
    };
  } catch {
    return { charCount: 0, areaPct: null };
  }
}
