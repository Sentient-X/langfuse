// sentientx: short-lived links for Catalog media keys, asked of the sx public
// API (`CatalogMediaService.GetMediaLinks`) with Langfuse's own sx API key, so
// no storage credential ever reaches a browser. Each link is cached for less
// than its life; a key the API refuses is answered "refused", never broken.
import { logger } from "@langfuse/shared/src/server";
import { parseSxMediaKey } from "@/src/features/sx-media/sxMediaKey";

const METHOD =
  "/sentientx.sx.experience.catalog.v1.CatalogMediaService/GetMediaLinks";
const MAX_KEYS_PER_CALL = 200;
const REFUSAL_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const CALL_TIMEOUT_MS = 10_000;
const BATCH_WINDOW_MS = 10;

export type SxMediaLink =
  | { key: string; status: "ready"; url: string }
  | { key: string; status: "refused" }
  | { key: string; status: "unconfigured" }
  // The sx API could not answer (outage, rate limit, timeout); not cached.
  | { key: string; status: "unavailable" };

type Cached = { link: SxMediaLink; expiresAt: number };

export type SxMediaConfig = {
  catalogUrl: string | undefined;
  apiKey: string | undefined;
  fetch: typeof fetch;
  now: () => number;
};

const REFUSED_CODES = new Set([
  "permission_denied",
  "invalid_argument",
  "not_found",
]);

export class SxMediaLinkResolver {
  private readonly cache = new Map<string, Cached>();
  private pending:
    | { keys: Set<string>; answer: Promise<Map<string, SxMediaLink>> }
    | undefined;

  constructor(private readonly config: SxMediaConfig) {}

  /**
   * Like `resolve`, but every caller within one short window shares one call
   * per Project: a page's many keys arrive as many small requests.
   */
  async resolveTogether(keys: readonly string[]): Promise<SxMediaLink[]> {
    if (!this.pending) {
      const batch = new Set<string>();
      const answer = new Promise<Map<string, SxMediaLink>>((done, fail) => {
        setTimeout(() => {
          this.pending = undefined;
          this.resolve([...batch])
            .then((links) => done(new Map(links.map((l) => [l.key, l]))))
            .catch(fail);
        }, BATCH_WINDOW_MS);
      });
      this.pending = { keys: batch, answer };
    }
    for (const key of keys) this.pending.keys.add(key);
    const answers = await this.pending.answer;
    return keys.map(
      (key) => answers.get(key) ?? { key, status: "refused" as const },
    );
  }

  async resolve(keys: readonly string[]): Promise<SxMediaLink[]> {
    const { catalogUrl, apiKey } = this.config;
    const asked = [...new Set(keys)];
    if (!catalogUrl || !apiKey)
      return asked.map((key) => ({ key, status: "unconfigured" as const }));

    const now = this.config.now();
    const answers = new Map<string, SxMediaLink>();
    const byProject = new Map<string, string[]>();
    for (const key of asked) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > now) {
        answers.set(key, cached.link);
        continue;
      }
      const parsed = parseSxMediaKey(key);
      if (!parsed) {
        answers.set(key, { key, status: "refused" });
        continue;
      }
      byProject.set(parsed.projectId, [
        ...(byProject.get(parsed.projectId) ?? []),
        key,
      ]);
    }

    const calls: Promise<void>[] = [];
    for (const [projectId, projectKeys] of byProject) {
      for (let i = 0; i < projectKeys.length; i += MAX_KEYS_PER_CALL) {
        const chunk = projectKeys.slice(i, i + MAX_KEYS_PER_CALL);
        calls.push(
          this.ask(catalogUrl, apiKey, projectId, chunk).then(
            (links) => {
              for (const link of links) answers.set(link.key, link);
            },
            (error: unknown) => {
              // One Project's failure costs only its own keys.
              logger.warn("sx GetMediaLinks failed", { projectId, error });
              for (const key of chunk)
                answers.set(key, { key, status: "unavailable" });
            },
          ),
        );
      }
    }
    await Promise.all(calls);
    return asked.map(
      (key) => answers.get(key) ?? { key, status: "refused" as const },
    );
  }

  private async ask(
    catalogUrl: string,
    apiKey: string,
    projectId: string,
    keys: string[],
  ): Promise<SxMediaLink[]> {
    const response = await this.config.fetch(
      `${catalogUrl.replace(/\/+$/, "")}${METHOD}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-api-key": apiKey,
          // A key names its Project; asking within it lets the API decide
          // with that Project's grants.
          "x-sx-project-id": projectId,
        },
        body: JSON.stringify({ keys }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
      links?: { key: string; url: string }[];
      linksValidS?: number;
    } | null;
    const now = this.config.now();

    if (!response.ok) {
      if (body?.code && REFUSED_CODES.has(body.code)) {
        return keys.map((key) =>
          this.remember({ key, status: "refused" }, now + REFUSAL_TTL_MS),
        );
      }
      throw new Error(
        `sx GetMediaLinks failed: ${response.status} ${body?.code ?? ""} ${body?.message ?? ""}`.trim(),
      );
    }

    // Keep a link for well under its life so a page never holds a dead one.
    const validMs = Math.max(0, (body?.linksValidS ?? 0) * 1000);
    const expiresAt = now + Math.floor(validMs * 0.5);
    const links = new Map((body?.links ?? []).map((l) => [l.key, l.url]));
    return keys.map((key) => {
      const url = links.get(key);
      return url
        ? this.remember({ key, status: "ready", url }, expiresAt)
        : this.remember({ key, status: "refused" }, now + REFUSAL_TTL_MS);
    });
  }

  private remember(link: SxMediaLink, expiresAt: number): SxMediaLink {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(link.key);
    this.cache.set(link.key, { link, expiresAt });
    return link;
  }
}

let resolver: SxMediaLinkResolver | undefined;

/** The one resolver, configured from SX_CATALOG_URL and SX_MEDIA_API_KEY. */
export function sxMediaLinkResolver(): SxMediaLinkResolver {
  if (!resolver) {
    resolver = new SxMediaLinkResolver({
      catalogUrl: process.env.SX_CATALOG_URL,
      apiKey: process.env.SX_MEDIA_API_KEY,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    });
  }
  return resolver;
}
