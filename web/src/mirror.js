// Map a click on an object-fit:contain screenshot to Chromium viewport
// coordinates. Ignore clicks on letterboxed edges; never click an unrelated
// remote location because the image aspect ratio differs from the display.
export function mirrorPoint(clientX, clientY, bounds, sourceWidth, sourceHeight) {
  if (!bounds || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
      sourceWidth <= 0 || sourceHeight <= 0 || bounds.width <= 0 || bounds.height <= 0)
    return null;
  const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  const left = bounds.left + (bounds.width - w) / 2;
  const top = bounds.top + (bounds.height - h) / 2;
  const x = (clientX - left) / w, y = (clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
