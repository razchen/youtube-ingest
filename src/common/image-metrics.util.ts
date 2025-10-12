import sharp from 'sharp';

/** Global Shannon entropy in bits (0..8). Super fast via libvips. */
export async function computeEntropyBits(imgPath: string): Promise<number> {
  const stats = await sharp(imgPath).greyscale().stats();
  return stats.entropy; // Already normalized to 0..8
}

/**
 * Cheap saliency via Sobel edges on a downscaled grayscale image.
 * Returns:
 *  - centerDist: distance of salient center-of-mass from image center (0..1, lower = more centered)
 *  - areaRatio: fraction of pixels marked salient after threshold (0..1)
 *  - blobCount: approximate connected components in salient mask
 */
export async function computeSaliencyFeatures(
  imgPath: string,
  opts?: { width?: number; percentile?: number; stride?: number },
): Promise<{ centerDist: number; areaRatio: number; blobCount: number }> {
  const width = opts?.width ?? 256; // speed knob
  const percentile = opts?.percentile ?? 0.85; // 85th percentile
  const stride = Math.max(1, opts?.stride ?? 2);

  // Downscale & grayscale to raw buffer
  const { data, info } = await sharp(imgPath)
    .resize({ width, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width,
    h = info.height;
  const N = w * h;

  // Sobel kernels
  const GxK = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const GyK = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  const mag = new Float32Array(N);
  const idx = (x: number, y: number) => y * w + x;

  // Sobel gradient magnitude (with stride)
  for (let y = 1; y < h - 1; y += stride) {
    for (let x = 1; x < w - 1; x += stride) {
      let gx = 0,
        gy = 0,
        k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, k++) {
          const p = data[idx(x + dx, y + dy)];
          gx += GxK[k] * p;
          gy += GyK[k] * p;
        }
      }
      mag[idx(x, y)] = Math.hypot(gx, gy);
    }
  }

  // Threshold at given percentile
  const sample: number[] = [];
  for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 5000)))
    sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const thr = sample[Math.floor(sample.length * percentile)] ?? 0;

  let area = 0;
  let sumX = 0,
    sumY = 0,
    sumW = 0;
  const mask = new Uint8Array(N);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (mag[i] >= thr) {
        mask[i] = 1;
        area++;
        const m = mag[i];
        sumX += x * m;
        sumY += y * m;
        sumW += m;
      }
    }
  }

  // Center-of-mass distance to center (normalized 0..1)
  const cx = sumW ? sumX / sumW : w / 2;
  const cy = sumW ? sumY / sumW : h / 2;
  const dx = (cx - w / 2) / (w / 2);
  const dy = (cy - h / 2) / (h / 2);
  const centerDist = Math.min(1, Math.hypot(dx, dy));
  const areaRatio = area / N;

  // Approx blob count via flood-fill on mask
  let blobCount = 0;
  const seen = new Uint8Array(N);
  const q: number[] = [];
  const push = (x: number, y: number) => {
    q.push(idx(x, y));
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i0 = idx(x, y);
      if (!mask[i0] || seen[i0]) continue;
      blobCount++;
      seen[i0] = 1;
      push(x, y);
      while (q.length) {
        const i = q.pop()!;
        const yy = Math.floor(i / w),
          xx = i % w;
        // 4-neighbors
        if (xx > 0) {
          const j = i - 1;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
        if (xx + 1 < w) {
          const j = i + 1;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
        if (yy > 0) {
          const j = i - w;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
        if (yy + 1 < h) {
          const j = i + w;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
    }
  }

  return { centerDist, areaRatio, blobCount };
}

export async function computeLumaAndSat(
  imgPath: string,
): Promise<{ meanLuma: number; meanSat: number }> {
  const { channels } = await sharp(imgPath).stats();
  const R = channels[0].mean / 255,
    G = channels[1].mean / 255,
    B = channels[2].mean / 255;
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B);
  const V = max; // HSV value (brightness)
  const S = max === 0 ? 0 : (max - min) / max; // HSV saturation
  return { meanLuma: V, meanSat: S };
}
