// sentientx: a Catalog media key names one Project's picture or clip by its
// content, `media/projects/<project>/[report-pictures/]sha256/<ab>/<sha256>.<ext>`.
// Traces, dataset items, queue items and score comments carry the key instead of
// the bytes; this module recognises one so the views show the picture or clip.

const SX_MEDIA_PREFIX = "media/projects/";

const SX_MEDIA_KEY_SOURCE =
  "media/projects/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(?:report-pictures/)?sha256/([0-9a-f]{2})/([0-9a-f]{64})\\.(png|jpg|webp|mp4)";

const SX_MEDIA_KEY_PATTERN = new RegExp(`^${SX_MEDIA_KEY_SOURCE}$`);

// The longest key is well under this; it bounds the regex on the hot path.
const MAX_SX_MEDIA_KEY_LENGTH = 160;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
};

export type SxMediaKey = {
  key: string;
  projectId: string;
  contentType: string;
};

/** The media key a string is, or null. Cheap for the common non-key string. */
export function parseSxMediaKey(value: unknown): SxMediaKey | null {
  if (typeof value !== "string" || !value.startsWith(SX_MEDIA_PREFIX))
    return null;
  if (value.length > MAX_SX_MEDIA_KEY_LENGTH) return null;
  const match = SX_MEDIA_KEY_PATTERN.exec(value);
  if (!match) return null;
  const [, projectId, shard, digest, extension] = match;
  if (digest!.slice(0, 2) !== shard) return null;
  return {
    key: value,
    projectId: projectId!,
    contentType: CONTENT_TYPES[extension!]!,
  };
}

/** Free text cut into its plain runs and the media keys inside it. */
export function splitTextBySxMediaKeys(
  text: string,
): Array<{ type: "text"; value: string } | { type: "key"; key: SxMediaKey }> {
  if (!text.includes(SX_MEDIA_PREFIX)) return [{ type: "text", value: text }];
  const segments: Array<
    { type: "text"; value: string } | { type: "key"; key: SxMediaKey }
  > = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(SX_MEDIA_KEY_SOURCE, "g"))) {
    const key = parseSxMediaKey(match[0]);
    const index = match.index ?? 0;
    if (!key) continue;
    if (index > last)
      segments.push({ type: "text", value: text.slice(last, index) });
    segments.push({ type: "key", key });
    last = index + match[0].length;
  }
  if (last < text.length)
    segments.push({ type: "text", value: text.slice(last) });
  return segments.length > 0 ? segments : [{ type: "text", value: text }];
}
