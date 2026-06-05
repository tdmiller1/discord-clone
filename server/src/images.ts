import { imageSize } from "image-size";
import { ALLOWED_IMAGE_TYPES, type AllowedImageType } from "./config.js";

/**
 * Maps the format string reported by `image-size` to the canonical MIME type
 * the route stores. `image-size` reports JPEG as `jpg`.
 */
const TYPE_TO_MIME: Record<string, AllowedImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Byte-sniffs an uploaded image buffer (SPEC.md §10): determines the real MIME
 * type and dimensions from the header bytes, ignoring any client-supplied
 * Content-Type/filename. Returns `null` when the bytes are undecodable or the
 * sniffed type is not one of the allowed image types — the caller maps that to
 * a `400 invalid_image`.
 */
export function sniffImage(
  buffer: Buffer,
): { contentType: AllowedImageType; width: number; height: number } | null {
  let result;
  try {
    result = imageSize(buffer);
  } catch {
    return null;
  }

  const type = result.type;
  if (type === undefined) return null;

  const contentType = TYPE_TO_MIME[type];
  if (contentType === undefined || !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return null;
  }

  const { width, height } = result;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return { contentType, width, height };
}
