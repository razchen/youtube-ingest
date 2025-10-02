import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';

const OCR_BASE_URL = process.env.OCR_BASE_URL || 'http://localhost:8000';
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 15000);
const OCR_MAX_RETRIES = Number(process.env.OCR_MAX_RETRIES || 2);

type PaddleWord = {
  bbox: [number, number, number, number]; // [x0,y0,x1,y1]
  text: string;
  conf: number;
};

type PaddleResp = {
  text: string;
  charCount: number;
  areaPct: number | null;
  words: PaddleWord[];
  imageSize: { width: number; height: number };
};

async function postWithRetry<T>(form: FormData, url: string): Promise<T> {
  let attempt = 0;
  let delay = 400;
  for (;;) {
    try {
      const { data } = await axios.post<T>(url, form, {
        headers: form.getHeaders(),
        timeout: OCR_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 500, // we’ll throw below on 4xx
      });
      if ((data as any)?.detail)
        throw new Error(JSON.stringify((data as any).detail));
      return data;
    } catch (e) {
      const ax = e as AxiosError;
      const isRetryable =
        !ax.response ||
        ax.code === 'ECONNABORTED' ||
        (ax.response.status >= 500 && ax.response.status < 600);
      if (isRetryable && attempt < OCR_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 3000);
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

/**
 * Paddle-only OCR.
 * Returns charCount, areaPct, and normalized text. No fallback.
 */
export async function ocrBasic(
  filePath: string,
): Promise<{ charCount: number; areaPct: number | null; text?: string }> {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const data = await postWithRetry<PaddleResp>(form, `${OCR_BASE_URL}/ocr`);

  const text = (data.text || '').replace(/\s+/g, ' ').trim();
  return {
    charCount: text.replace(/\s+/g, '').length,
    areaPct: data.areaPct,
    text,
  };
}
