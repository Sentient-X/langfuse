// sentientx: the references our traces carry to private recordings, besides
// Catalog media keys (`sxMediaKey.ts`): an episode or a moment of one, an object
// in a bucket, a QC view, an R2 link, and tracing's note for a picture it did not
// keep. sx resolves each under its own access check (`ResolveReferences`); this
// module only recognises them, mirroring `sx_catalog.references` in sx.

// The longest reference read; longer strings are not references.
const MAX_REFERENCE_LENGTH = 2048;

const EPISODE_MOMENT =
  /^episode:ep_[0-9a-f]{6,64}(?:@(?:\d{1,20}ns|\d{1,9}(?:\.\d{1,9})?(?:-\d{1,9}(?:\.\d{1,9})?)?))?(?:#[^\s#]{1,200})?$/;
const BARE_EPISODE = /^ep_[0-9a-f]{6,64}$/;
const BUCKET_URI = /^(?:r2|s3):\/\/[a-z0-9][a-z0-9.-]{1,62}\/\S{1,1800}$/;
const R2_LINK = /^https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^\s]+$/;
const CATALOG_KEY_PREFIXES = ["captures/", "annotations/"];
const OMITTED_PREFIX = "sx-media-omitted:";
// The picture's own digest and size, or (base64 that did not decode) its text's
// digest and length, which a picture's size follows at three bytes in four.
const OMITTED =
  /^sx-media-omitted:([a-z]+\/[a-z0-9.+-]+);sha256(-of-text)?=([0-9a-f]{64});(?:bytes|chars)=(\d+)$/;

export type SxReference =
  | { kind: "resolvable"; reference: string }
  | { kind: "omitted"; reference: string; mediaType: string; bytes: number };

/** The reference a string is, or null. Cheap for the common non-reference string. */
export function parseSxReference(value: unknown): SxReference | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_REFERENCE_LENGTH) return null;
  const first = value.charCodeAt(0);
  // Every reference starts with one of: e(pisode/p_) r s q c a h(ttps) s(x-media).
  if (!"erqcahs".includes(String.fromCharCode(first))) return null;
  if (value.startsWith(OMITTED_PREFIX)) {
    const match = OMITTED.exec(value);
    if (!match) return null;
    return {
      kind: "omitted",
      reference: value,
      mediaType: match[1]!,
      bytes: match[2]
        ? Math.floor((Number(match[4]) * 3) / 4)
        : Number(match[4]),
    };
  }
  if (
    EPISODE_MOMENT.test(value) ||
    BARE_EPISODE.test(value) ||
    BUCKET_URI.test(value) ||
    R2_LINK.test(value) ||
    (value.startsWith("qc/view/") && value.endsWith(".rrd")) ||
    CATALOG_KEY_PREFIXES.some(
      (prefix) => value.startsWith(prefix) && !/\s/.test(value),
    )
  ) {
    return { kind: "resolvable", reference: value };
  }
  return null;
}

/** A size in words: "12 KB". */
export function bytesInWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
