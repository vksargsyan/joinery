/**
 * Draws an SVG document into a canvas and returns it as PNG bytes (the ER diagram's PNG export).
 * The scale is lowered for very large drawings so the canvas stays within Chromium's limits
 * (16,384 pixels a side, about 268 million in all).
 */
export async function rasteriseSvg(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<Uint8Array> {
  const side = 16_000 / Math.max(width, height);
  const area = Math.sqrt(200_000_000 / (width * height));
  const factor = Math.max(0.1, Math.min(scale, side, area));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * factor);
  canvas.height = Math.round(height * factor);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The canvas could not be drawn on');
  context.scale(factor, factor);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The image could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}
