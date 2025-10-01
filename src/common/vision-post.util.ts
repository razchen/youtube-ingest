// src/common/vision-post.util.ts
export type VisionRawBox = {
  name: string;
  conf: number;
  box: { x: number; y: number; w: number; h: number };
};
export type VisionPayload = {
  faces?: { count: number; largest?: { areaPct?: number }; boxes?: any[] };
  objects?: { tags: string[]; raw?: VisionRawBox[] };
  palette?: Array<{ hex: string; pct: number }>;
  contrast?: number;
  imageSize?: { width: number; height: number };
};

export function refineVision(
  v: VisionPayload,
  hints?: { title?: string; ocrText?: string },
) {
  const width = v.imageSize?.width ?? 1;
  const height = v.imageSize?.height ?? 1;
  const imgArea = width * height;

  // Filter raw detections (remove very low conf + very tiny boxes)
  const MIN_CONF = 0.5;
  const MIN_AREA_PCT = 0.002; // 0.2% of frame
  const raw = (v.objects?.raw ?? []).filter((r) => {
    const areaPct = (r.box.w * r.box.h) / imgArea;
    return r.conf >= MIN_CONF && areaPct >= MIN_AREA_PCT;
  });

  // Map raw -> stable coarse tags
  const names = new Set(raw.map((r) => r.name));
  const tags = new Set<string>(v.objects?.tags ?? []);

  // Vehicles → "car"
  const veh = ['car', 'bus', 'truck', 'motorcycle', 'train'];
  if (raw.some((r) => veh.includes(r.name))) tags.add('car');

  // Person present
  if (names.has('person')) tags.add('person');

  // Portrait rule (faces)
  const faceCount = v.faces?.count ?? 0;
  const largestPct = v.faces?.largest?.areaPct ?? 0;
  if (faceCount > 0 && largestPct >= 0.08) tags.add('portrait');

  // Money (OCR/title)
  const t = `${hints?.title ?? ''} ${hints?.ocrText ?? ''}`.toUpperCase();
  if (
    /\$|€|£/.test(t) ||
    /\b(MONEY|CASH|MILLION|BILLION|USD|EUR|GBP|[€$£]\s?\d[\d,\.]*)\b/.test(t)
  ) {
    tags.add('money');
  }

  // Fire (conservative warm-heuristic gate using palette & contrast)
  // NOTE: real detector later; this keeps false-positives low.
  const warmTop = (v.palette ?? []).some((p) => {
    // very rough warm check in hex
    const hex = p.hex.replace('#', '');
    if (hex.length !== 6) return false;
    const r = parseInt(hex.slice(0, 2), 16),
      g = parseInt(hex.slice(2, 4), 16),
      b = parseInt(hex.slice(4, 6), 16);
    const warmish = r > 180 && g > 80 && b < 100 && r > g && g > b;
    return warmish && p.pct >= 0.12; // requires sizable warm dominance
  });
  if (warmTop && (v.contrast ?? 0) >= 0.18) tags.add('fire');

  return {
    faces_json: v.faces ? JSON.stringify(v.faces) : null,
    objects_json: JSON.stringify({ tags: Array.from(tags), raw }), // keep filtered raw
    palette_json: v.palette ? JSON.stringify(v.palette) : null,
    contrast: v.contrast ?? null,
    // convenience exports for CSV
    csv: {
      faces_count: faceCount,
      faces_largest_areaPct: largestPct,
      palette_top1: v.palette?.[0]?.hex ?? null,
      tags: Array.from(tags).join('|'),
    },
  };
}
