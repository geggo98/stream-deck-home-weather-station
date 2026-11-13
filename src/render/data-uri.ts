/**
 * Base64 `data:` URI wrapper for composed images.
 *
 * `setImage` with a raw SVG string is accepted by the SDK's types but silently ignored by
 * the hardware for composed images (measured on a Stream Deck + in the sibling project this
 * structure comes from; not re-measured here). A base64 data URI renders. Every composed
 * image therefore goes through this function; tests/key-images.test.ts asserts that no raw
 * markup ever reaches `setImage`.
 *
 * Only `href`-less markup is produced by tile.ts (no embedded bitmaps), so no xlink
 * duplication is needed.
 */

export const SVG_DATA_URI_PREFIX = "data:image/svg+xml;base64,";

/** Upper bound for a composed image; a tile is ~2 KB, so this only guards against bugs. */
export const MAX_IMAGE_BYTES = 64 * 1024;

export function svgToDataUri(svg: string): string {
	const bytes = Buffer.from(svg, "utf8");
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error(`composed image is ${bytes.length} bytes, limit ${MAX_IMAGE_BYTES}`);
	}
	return `${SVG_DATA_URI_PREFIX}${bytes.toString("base64")}`;
}

export function isSvgDataUri(value: string): boolean {
	return value.startsWith(SVG_DATA_URI_PREFIX);
}
