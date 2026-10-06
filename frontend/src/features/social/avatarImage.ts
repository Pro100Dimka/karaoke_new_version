// A profile photo is shown at most this wide on any screen; the server accepts up to 256 KB.
const avatarPixels = 256;
const maximumBytes = 256 * 1024;
const qualities = [0.9, 0.8, 0.65, 0.5] as const;

const blobOf = (
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));

const base64Of = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * The centre square of a picture, reduced to the size it is shown at and encoded as WebP, small
 * enough for the server. Throws when the file is not a picture the browser can read.
 */
export const avatarFromFile = async (
  file: File,
): Promise<{ mime: string; data: string }> => {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = avatarPixels;
  canvas.height = avatarPixels;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.width - side) / 2,
    (image.height - side) / 2,
    side,
    side,
    0,
    0,
    avatarPixels,
    avatarPixels,
  );
  image.close();
  for (const quality of qualities) {
    const blob = await blobOf(canvas, quality);
    if (blob && blob.size <= maximumBytes)
      return { mime: "image/webp", data: await base64Of(blob) };
  }
  throw new Error("The photo is too large");
};
