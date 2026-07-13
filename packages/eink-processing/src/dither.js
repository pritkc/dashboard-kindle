export function thresholdPixel(value, strategy = "threshold") {
  const clamped = Math.max(0, Math.min(255, Number(value)));
  if (strategy === "none") return clamped;
  return clamped >= 128 ? 255 : 0;
}

export function quantizeGray(value, levels = 4) {
  const clamped = Math.max(0, Math.min(255, Number(value)));
  const steps = Math.max(2, levels);
  return Math.round(Math.round((clamped / 255) * (steps - 1)) * (255 / (steps - 1)));
}

export function bayerThreshold(x, y, size = 4) {
  const bayer4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];
  const matrix = size === 2 ? [[0, 2], [3, 1]] : bayer4;
  return ((matrix[y % size][x % size] + 0.5) / (size * size)) * 255;
}
