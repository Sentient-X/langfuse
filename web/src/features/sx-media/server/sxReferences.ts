// sentientx: what our traces' references to private recordings show, asked of
// the sx public API (`CatalogMediaService.ResolveReferences`) with Langfuse's own
// sx key, within the Project that key reads (SX_MEDIA_PROJECT_ID). sx checks
// every reference against that key's access; a picture it answers by a path on
// its own origin (an episode's indexed frame) is fetched by Langfuse's server
// (`/api/sx-media/picture`), so no credential reaches a browser.
import { logger } from "@langfuse/shared/src/server";

const METHOD =
  "/sentientx.sx.experience.catalog.v1.CatalogMediaService/ResolveReferences";
const MAX_REFERENCES_PER_CALL = 100;
const REFUSAL_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const CALL_TIMEOUT_MS = 15_000;
const BATCH_WINDOW_MS = 10;
// The one path a proxied picture may have: the Catalog's governed thumbnails.
export const SX_PICTURE_PATH_PREFIX = "/d/catalog/api/experience/thumbs/";
export const SX_PICTURE_PROXY = "/api/sx-media/picture";

export type SxPicture = { url: string; mediaType: string; timeNs?: string };

export type SxShown =
  | {
      reference: string;
      status: "ready";
      label: string;
      page?: string;
      pictures: SxPicture[];
    }
  | { reference: string; status: "refused"; label: string }
  | { reference: string; status: "unconfigured" }
  // Nothing to show now: the sx API could not answer (outage, rate limit,
  // timeout), or sx said so in `label`; not cached.
  | { reference: string; status: "unavailable"; label?: string };

type Cached = { shown: SxShown; expiresAt: number };

export type SxReferenceConfig = {
  catalogUrl: string | undefined;
  apiKey: string | undefined;
  projectId: string | undefined;
  fetch: typeof fetch;
  now: () => number;
};

type WireLink = { key?: string; url?: string; mediaType?: string };
type WireResolved = {
  reference?: string;
  shown?: string;
  pictures?: WireLink[];
  page?: string;
  label?: string;
  pictureTimesNs?: string[];
};

const MEDIA_TYPES: Record<string, string> = {
  MEDIA_TYPE_PNG: "image/png",
  MEDIA_TYPE_JPEG: "image/jpeg",
  MEDIA_TYPE_WEBP: "image/webp",
  MEDIA_TYPE_MP4: "video/mp4",
};

/** The URL a browser loads a picture from: as given when absolute (a short-lived
 * link), through Langfuse's own proxy when it is a path on sx's origin. */
export function browserUrl(url: string): string | null {
  if (url.startsWith("https://")) return url;
  if (url.startsWith(SX_PICTURE_PATH_PREFIX))
    return `${SX_PICTURE_PROXY}?path=${encodeURIComponent(url)}`;
  return null;
}

export class SxReferenceResolver {
  private readonly cache = new Map<string, Cached>();
  private pending:
    | { references: Set<string>; answer: Promise<Map<string, SxShown>> }
    | undefined;

  constructor(private readonly config: SxReferenceConfig) {}

  /** Every caller within one short window shares one call. */
  async resolveTogether(references: readonly string[]): Promise<SxShown[]> {
    if (!this.pending) {
      const batch = new Set<string>();
      const answer = new Promise<Map<string, SxShown>>((done, fail) => {
        setTimeout(() => {
          this.pending = undefined;
          this.resolve([...batch])
            .then((all) => done(new Map(all.map((s) => [s.reference, s]))))
            .catch(fail);
        }, BATCH_WINDOW_MS);
      });
      this.pending = { references: batch, answer };
    }
    for (const reference of references) this.pending.references.add(reference);
    const answers = await this.pending.answer;
    return references.map(
      (reference) =>
        answers.get(reference) ?? {
          reference,
          status: "refused" as const,
          label: "Not allowed",
        },
    );
  }

  async resolve(references: readonly string[]): Promise<SxShown[]> {
    const { catalogUrl, apiKey, projectId } = this.config;
    const asked = [...new Set(references)];
    if (!catalogUrl || !apiKey || !projectId)
      return asked.map((reference) => ({
        reference,
        status: "unconfigured" as const,
      }));
    const now = this.config.now();
    const answers = new Map<string, SxShown>();
    const missing: string[] = [];
    for (const reference of asked) {
      const cached = this.cache.get(reference);
      if (cached && cached.expiresAt > now)
        answers.set(reference, cached.shown);
      else missing.push(reference);
    }
    const calls: Promise<void>[] = [];
    for (let i = 0; i < missing.length; i += MAX_REFERENCES_PER_CALL) {
      const chunk = missing.slice(i, i + MAX_REFERENCES_PER_CALL);
      calls.push(
        this.ask(catalogUrl, apiKey, projectId, chunk).then(
          (shown) => {
            for (const s of shown) answers.set(s.reference, s);
          },
          (error: unknown) => {
            logger.warn("sx ResolveReferences failed", { error });
            for (const reference of chunk)
              answers.set(reference, { reference, status: "unavailable" });
          },
        ),
      );
    }
    await Promise.all(calls);
    return asked.map(
      (reference) =>
        answers.get(reference) ?? { reference, status: "unavailable" as const },
    );
  }

  private async ask(
    catalogUrl: string,
    apiKey: string,
    projectId: string,
    references: string[],
  ): Promise<SxShown[]> {
    const response = await this.config.fetch(
      `${catalogUrl.replace(/\/+$/, "")}${METHOD}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-api-key": apiKey,
          "x-sx-project-id": projectId,
        },
        body: JSON.stringify({ references }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
      resolved?: WireResolved[];
      linksValidS?: number;
    } | null;
    if (!response.ok) {
      throw new Error(
        `sx ResolveReferences failed: ${response.status} ${body?.code ?? ""} ${body?.message ?? ""}`.trim(),
      );
    }
    const now = this.config.now();
    const validMs = Math.max(0, (body?.linksValidS ?? 0) * 1000);
    const expiresAt = now + Math.floor(validMs * 0.5);
    const byReference = new Map(
      (body?.resolved ?? []).map((r) => [r.reference ?? "", r]),
    );
    return references.map((reference) => {
      const wire = byReference.get(reference);
      if (!wire || wire.shown === "REFERENCE_SHOWN_REFUSED") {
        return this.remember(
          { reference, status: "refused", label: wire?.label || "Not allowed" },
          now + REFUSAL_TTL_MS,
        );
      }
      // Only pictures, or a page that opens it, are ready. Anything else
      // (REFERENCE_SHOWN_UNAVAILABLE, a kind this build does not know, a page
      // answer without its page) is unavailable: shown as such, never cached.
      const ready =
        wire.shown === "REFERENCE_SHOWN_MEDIA" ||
        (wire.shown === "REFERENCE_SHOWN_PAGE" && !!wire.page);
      if (!ready)
        return {
          reference,
          status: "unavailable" as const,
          ...(wire.label ? { label: wire.label } : {}),
        };
      const times = wire.pictureTimesNs ?? [];
      const pictures = (wire.pictures ?? []).flatMap((link, index) => {
        const url = link.url ? browserUrl(link.url) : null;
        return url
          ? [
              {
                url,
                mediaType: MEDIA_TYPES[link.mediaType ?? ""] ?? "image/jpeg",
                ...(times[index] ? { timeNs: times[index] } : {}),
              },
            ]
          : [];
      });
      return this.remember(
        {
          reference,
          status: "ready",
          label: wire.label ?? "",
          ...(wire.page ? { page: wire.page } : {}),
          pictures,
        },
        expiresAt,
      );
    });
  }

  private remember(shown: SxShown, expiresAt: number): SxShown {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(shown.reference);
    this.cache.set(shown.reference, { shown, expiresAt });
    return shown;
  }
}

let resolver: SxReferenceResolver | undefined;

/** The one resolver, from SX_CATALOG_URL, SX_MEDIA_API_KEY and SX_MEDIA_PROJECT_ID. */
export function sxReferenceResolver(): SxReferenceResolver {
  if (!resolver) {
    resolver = new SxReferenceResolver({
      catalogUrl: process.env.SX_CATALOG_URL,
      apiKey: process.env.SX_MEDIA_API_KEY,
      projectId: process.env.SX_MEDIA_PROJECT_ID,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    });
  }
  return resolver;
}
