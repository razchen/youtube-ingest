export type Saliency = {
  centerDist: number;
  areaRatio: number;
  blobCount: number;
};
export type Faces = { count: number; largestAreaPct?: number | null };
export type PaletteTop = { hex: string; pct: number };

export type CategorizeInput = {
  title?: string;
  channelId?: string;
  categoryId?: string | number | null;
  meanLuma?: number | null; // 0..1  (brightness)
  meanSat?: number | null; // 0..1  (saturation, optional)

  // computed metrics (from your pipeline)
  ocr_areaPct?: number | null; // 0..1
  contrast?: number | null; // 0..1 (RMS)
  entropy?: number | null; // ~2..8
  saliency?: Saliency | null;
  faces?: Faces | null;
  palette?: PaletteTop[] | null; // optional

  // optional switches
  allowUncertain?: boolean; // default true
};

export type CategorizeOutput = {
  genre_bucket: string | null; // e.g., "extreme_challenge"
  style_bucket: string | null; // e.g., "challenge_split_headline"
  caption: string; // ready for .txt
  reasons: string[]; // human-readable debug traces
  scores: Record<string, number>; // numeric scores (confidence-ish)
};

// ---- Config/prior knobs ----

// Channels that heavily bias toward "extreme_challenge" (add more as needed)
const CHALLENGE_PRIOR_CHANNELS = new Set<string>([
  'UCX6OQ3DkcsbYNE6H8uQQuVA', // MrBeast
]);

const DARK_LUMA_MAX = 0.38;

// Simple title keyword prior for challenge content
const CHALLENGE_TITLE_RX =
  /\b(last to|survive|challenge|vs|beat|wins?|win\s*\$|\$\s*\d|million)\b/i;

// Thresholds (tweak as you get data)
const TH = {
  bigFace: 0.18, // largest face area %
  splitHeadlineTextLo: 0.08,
  splitHeadlineTextHi: 0.18, // OCR% for split+headline
  minimalText: 0.03, // OCR% low
  cleanContrastMax: 0.14, // "clean" looks
  neonSatMin: 0.65,
  darkValMax: 0.35, // you can compute mean V later if you want
  entropyLowMax: 4.5,
  entropyMidMax: 5.5,
};

// Utility: median hue from palette (optional)
function medianHueFromPalette(pal?: PaletteTop[] | null): number | null {
  if (!pal?.length) return null;
  // rough: convert hex to hue for the top color only (enough for warm/cool gate)
  const hex = pal[0].hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  switch (max) {
    case r:
      h = ((g - b) / d) % 6;
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    case b:
      h = (r - g) / d + 4;
      break;
  }
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function isWarmHue(h: number | null): boolean {
  return h != null && h >= 20 && h <= 60;
}

// ---- Scoring helpers (soft decisions > brittle if/else) ----
function sSplitHeadline(inp: CategorizeInput) {
  const faces2plus = (inp.faces?.count ?? 0) >= 2 ? 1 : 0;
  const text = inp.ocr_areaPct ?? 0;

  // stronger curve toward 1.0 when text is big
  const textScore = Math.max(
    0,
    Math.min(
      1,
      (text - TH.splitHeadlineTextLo) /
        (TH.splitHeadlineTextHi - TH.splitHeadlineTextLo),
    ),
  );

  const blobs = inp.saliency?.blobCount ?? 0;
  const center = 1 - Math.min(1, inp.saliency?.centerDist ?? 1);
  const layoutScore =
    (text >= 0.1 ? 0.55 : 0) + // +0.05 bump
    (blobs >= 2 && blobs <= 6 ? 0.3 : 0) +
    (center < 0.35 ? 0.2 : 0);

  return Math.max(0.6 * faces2plus + 0.4 * textScore, layoutScore);
}

function sExtremeReaction(inp: CategorizeInput) {
  const faces = (inp.faces?.count ?? 0) >= 1 ? 1 : 0;
  const big = (inp.faces?.largestAreaPct ?? 0) > TH.bigFace ? 1 : 0;
  const entropy = inp.entropy ?? 0;
  const entScore = Math.max(
    0,
    Math.min(1, (entropy - TH.entropyLowMax) / (8 - TH.entropyLowMax)),
  );
  const textOK = (inp.ocr_areaPct ?? 0) < 0.06 ? 1 : 0.6; // allow some text
  return 0.45 * faces + 0.35 * big + 0.2 * entScore * textOK;
}

function sCleanTech(inp: CategorizeInput) {
  const facesLe1 = (inp.faces?.count ?? 0) <= 1 ? 1 : 0;
  const textLow = (inp.ocr_areaPct ?? 1) <= TH.minimalText ? 1 : 0.5;
  const c = inp.contrast ?? 1;
  const contrastScore =
    c < TH.cleanContrastMax
      ? 1
      : Math.max(0, 1 - (c - TH.cleanContrastMax) * 4);
  const ent = inp.entropy ?? 8;
  const entScore =
    ent <= TH.entropyLowMax ? 1 : Math.max(0, 1 - (ent - TH.entropyLowMax) / 2);
  return (
    0.35 * facesLe1 + 0.3 * textLow + 0.2 * contrastScore + 0.15 * entScore
  );
}

function sGamingNeon(inp: CategorizeInput) {
  const darkOK = (inp.meanLuma ?? 1) < DARK_LUMA_MAX ? 1 : 0; // NEW hard gate
  if (!darkOK) return 0; // no darkness → no neon
  const textOK = (inp.ocr_areaPct ?? 0) < 0.1 ? 1 : 0.6;
  const ent = inp.entropy ?? 0;
  const entScore = Math.max(0, Math.min(1, (ent - 5.0) / 3)); // 5..8 → 0..1
  return 0.7 * entScore + 0.3 * textOK;
}

function sFoodCloseup(inp: CategorizeInput) {
  const noFace = (inp.faces?.count ?? 0) === 0 ? 1 : 0;
  const cent = 1 - Math.min(1, inp.saliency?.centerDist ?? 1);
  const textLow = (inp.ocr_areaPct ?? 1) <= TH.minimalText ? 1 : 0.4;
  const warm = isWarmHue(medianHueFromPalette(inp.palette)) ? 1 : 0.4;
  const ent = inp.entropy ?? 5;
  const entMid = ent >= 4 && ent <= 6 ? 1 : 0.5;
  return 0.35 * noFace + 0.3 * cent + 0.2 * textLow + 0.15 * warm * entMid;
}

function sCinematicPoster(inp: CategorizeInput) {
  const facesLe1 = (inp.faces?.count ?? 0) <= 1 ? 1 : 0;
  const cent = 1 - Math.min(1, inp.saliency?.centerDist ?? 1);
  const lowSatProxy = (inp.contrast ?? 0.2) < 0.18 ? 1 : 0.6;
  const ent = inp.entropy ?? 6;
  const entOK = ent <= TH.entropyMidMax ? 1 : 0.5;
  return 0.4 * facesLe1 + 0.35 * cent + 0.15 * lowSatProxy + 0.1 * entOK;
}

function sComedyCollage(inp: CategorizeInput) {
  const text = inp.ocr_areaPct ?? 0;
  const blobs = inp.saliency?.blobCount ?? 0;
  const ent = inp.entropy ?? 0;

  const textHi = text >= 0.12 ? 1 : 0; // big typographic area
  const blobsHi = blobs >= 12 ? 1 : 0; // many cutouts
  const entHi = ent >= 6.0 ? 1 : 0; // very busy

  // require (textHi OR blobsHi) AND entHi
  if (!(entHi && (textHi || blobsHi))) return 0;

  // bonus if BOTH are true
  const both = textHi && blobsHi ? 0.2 : 0.0;
  return 0.8 + both; // 0.8..1.0 only when clearly collage
}

function sBeautySoft(inp: CategorizeInput) {
  const text = inp.ocr_areaPct ?? 0;
  const faces = inp.faces?.count ?? 0;
  const largest = inp.faces?.largestAreaPct ?? 0;
  const contrast = inp.contrast ?? 1;
  const entropy = inp.entropy ?? 8;

  // hard gates
  if (text >= 0.06) return 0; // big headline ≠ beauty
  if (faces >= 2 || largest > 0.18) return 0; // big/2 faces ≠ beauty
  if (contrast >= 0.12) return 0; // needs soft contrast
  if (entropy > 4.8) return 0; // too busy

  // if all gates pass, high score
  return 0.8;
}

// helper: detect rough skin tone in top palette color (prevents cartoon)
function looksLikeSkinFromPalette(pal?: { hex: string; pct: number }[] | null) {
  if (!pal?.length) return false;
  const hex = pal[0].hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255,
    g = parseInt(hex.slice(2, 4), 16) / 255,
    b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  const S = max === 0 ? 0 : d / max;
  const V = max;
  // crude skin gate: moderate saturation, warmish tone, mid-high value
  const warmish = (r > g && g > b) || (V > 0.35 && r > 0.5 && g > 0.3);
  return warmish && S >= 0.15 && S <= 0.6 && V >= 0.4 && V <= 0.95;
}

function sKidsCartoon(inp: CategorizeInput) {
  const faces0 = (inp.faces?.count ?? 0) === 0 ? 1 : 0;
  const textLow = (inp.ocr_areaPct ?? 1) <= 0.03 ? 1 : 0; // tighten text
  const entLow = (inp.entropy ?? 8) <= 4.2 ? 1 : 0; // really low detail
  const satHigh = (inp.meanSat ?? 0) >= 0.75 ? 1 : 0; // very saturated
  const blobsFew = (inp.saliency?.blobCount ?? 99) <= 3 ? 1 : 0; // few big regions
  const areaLow = (inp.saliency?.areaRatio ?? 1) <= 0.1 ? 1 : 0; // mostly flat fill
  const skinVeto = looksLikeSkinFromPalette(inp.palette) ? 1 : 0;

  // hard gates: must be face-free, saturated, simple
  if (!(faces0 && satHigh && entLow)) return 0;
  // veto if likely skin tones (i.e., real photo)
  if (skinVeto) return 0;

  // positive signals combine
  return 0.35 * textLow + 0.3 * blobsFew + 0.35 * areaLow; // 0..1
}

function sMysteryDark(inp: CategorizeInput) {
  const darkOK = (inp.meanLuma ?? 1) < DARK_LUMA_MAX; // NEW
  if (!darkOK) return 0;
  const textOK = (inp.ocr_areaPct ?? 0) <= 0.06 ? 1 : 0.5;
  const entMidHi = (inp.entropy ?? 0) >= 4.8 ? 1 : 0.4;
  return 0.6 * textOK + 0.4 * entMidHi;
}

// --- Genre scoring ---
function gExtremeChallenge(inp: CategorizeInput) {
  const prior =
    inp.channelId && CHALLENGE_PRIOR_CHANNELS.has(inp.channelId) ? 1 : 0;
  const titleHit = inp.title ? (CHALLENGE_TITLE_RX.test(inp.title) ? 1 : 0) : 0;
  return Math.max(prior, titleHit); // simple for now: 0 or 1
}

// ---- Main categorizer ----
export function categorizeThumbnail(inp: CategorizeInput): CategorizeOutput {
  const reasons: string[] = [];
  const scores: Record<string, number> = {};

  // GENRE
  const genreScore = gExtremeChallenge(inp);
  const genre_bucket = genreScore >= 1 ? 'extreme_challenge' : null;
  if (genre_bucket)
    reasons.push('genre: extreme_challenge (title/channel prior)');

  // STYLE scores
  const sSplit = sSplitHeadline(inp);
  scores['split_headline'] = sSplit;
  const sReact = sExtremeReaction(inp);
  scores['extreme_reaction'] = sReact;
  const sTech = sCleanTech(inp);
  scores['clean_tech'] = sTech;
  const sGame = sGamingNeon(inp);
  scores['gaming_neon'] = sGame;
  const sFood = sFoodCloseup(inp);
  scores['food_closeup'] = sFood;
  const sPost = sCinematicPoster(inp);
  scores['cinematic_poster'] = sPost;
  const sComedy = sComedyCollage(inp);
  scores['comedy_collage'] = sComedy;
  const sBeauty = sBeautySoft(inp);
  scores['beauty_soft'] = sBeauty;
  const sKids = sKidsCartoon(inp);
  scores['kids_cartoon'] = sKids;
  const sMyst = sMysteryDark(inp);
  scores['mystery_dark'] = sMyst;

  // pick top style
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  let style_bucket =
    top && top[1] >= 0.55
      ? top[0]
      : inp.allowUncertain !== false
        ? 'uncertain'
        : null;

  if (style_bucket && ['mystery_dark', 'gaming_neon'].includes(style_bucket)) {
    const l = inp.meanLuma ?? 1;
    if (l >= 0.45) {
      // down-rank and pick the next best non-dark style
      const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const fallback = ordered.find(
        ([k]) => !['mystery_dark', 'gaming_neon'].includes(k),
      );
      if (fallback && fallback[1] >= 0.5) {
        style_bucket = fallback[0];
        reasons.push(
          `fallback: ${style_bucket} (not dark; meanLuma=${l.toFixed(2)})`,
        );
      } else {
        style_bucket = 'uncertain';
        reasons.push(
          `fallback: uncertain (not dark; meanLuma=${l.toFixed(2)})`,
        );
      }
    }
  }

  if (genre_bucket === 'extreme_challenge' && style_bucket === 'beauty_soft') {
    const text = inp.ocr_areaPct ?? 1;
    const faces = inp.faces?.count ?? 99;
    const largest = inp.faces?.largestAreaPct ?? 1;
    if (!(text < 0.03 && faces <= 1 && largest <= 0.12)) {
      // pick next best non-beauty style
      const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const fallback = ordered.find(([k]) => k !== 'beauty_soft');
      if (fallback) style_bucket = fallback[0];
    }
  }

  if (style_bucket === 'uncertain')
    reasons.push('style: low confidence → uncertain');
  else if (style_bucket)
    reasons.push(`style: ${style_bucket} (score=${top[1].toFixed(2)})`);

  // caption (style + optional genre token)
  const styleToCaption: Record<string, string> = {
    split_headline:
      'two portraits split screen, large headline text, bright background, challenge thumbnail style',
    extreme_reaction:
      'big face close-up, extreme emotion, saturated colors, solid background, youtube thumbnail style',
    clean_tech:
      'clean layout, single person on one side, gradient background, minimal text, educational thumbnail style',
    gaming_neon:
      'dark background, neon glow accents, energetic composition, gaming thumbnail style',
    food_closeup:
      'warm tones, close-up food, cinematic lighting, shallow depth of field, minimal text, cooking thumbnail style',
    cinematic_poster:
      'centered subject, dramatic lighting, desaturated colors, movie poster thumbnail style',
    comedy_collage:
      'multiple cutouts, emoji elements, bright palette, playful composition, meme thumbnail style',
    beauty_soft:
      'pastel palette, soft lighting, clean background, lifestyle thumbnail style',
    kids_cartoon:
      'flat shapes, chunky characters, high saturation, simple background, cartoon thumbnail style',
    mystery_dark:
      'dark background, red blue rim light, dramatic shadows, serif headline space, mystery analysis thumbnail style',
    uncertain: 'uncertain style, generic youtube thumbnail style',
  };

  const prefix = genre_bucket ? '<extreme-challenge>, ' : '';
  const caption = style_bucket
    ? `${prefix}${styleToCaption[style_bucket]}`
    : `${prefix}youtube thumbnail style`;

  return { genre_bucket, style_bucket, caption, reasons, scores };
}
