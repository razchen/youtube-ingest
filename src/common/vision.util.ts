// src/common/vision.util.ts
import fs from 'fs';
import fetch from 'node-fetch'; // npm i node-fetch@2 (or 3 if ESM)
import FormData from 'form-data'; // npm i form-data

export type VisionResponse = {
  faces?: {
    count: number;
    largest?: {
      x: number;
      y: number;
      w: number;
      h: number;
      area: number;
      areaPct: number;
    };
    boxes?: Array<{ x: number; y: number; w: number; h: number; area: number }>;
  };
  objects?: {
    tags: string[];
    raw?: Array<{
      name: string;
      conf: number;
      box: { x: number; y: number; w: number; h: number };
    }>;
  };
  palette?: Array<{ hex: string; pct: number }>;
  contrast?: number; // 0..1
};

export async function analyzeImage(
  imgPath: string,
  hints?: { title?: string; ocrText?: string },
): Promise<VisionResponse> {
  const fd = new FormData();
  fd.append('image', fs.createReadStream(imgPath));
  if (hints?.title) fd.append('title', hints.title);
  if (hints?.ocrText) fd.append('ocrText', hints.ocrText);
  if (!process.env.VISION_URL) {
    throw new Error('VISION_URL env var not set');
  }

  const res = await fetch(process.env.VISION_URL, {
    method: 'POST',
    body: fd as any,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Vision service error ${res.status}: ${msg}`);
  }
  return (await res.json()) as VisionResponse;
}
