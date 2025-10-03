function isApprox169(w: number, h: number, maxDrift = 0.06) {
  const ar = w / h,
    target = 16 / 9;
  return Math.abs(ar - target) <= maxDrift;
}

export function shouldKeepForTraining(
  w: number | null,
  h: number | null,
): boolean {
  if (!w || !h) return false;
  if (w >= 1280 && h >= 720 && isApprox169(w, h)) return true; // best
  if (w >= 1000 && isApprox169(w, h)) return true; // acceptable
  return false;
}
