import { describe, expect, it, vi } from "vitest";
import { SxMediaLinkResolver } from "@/src/features/sx-media/server/sxMediaLinks";

const ONE = "0b7d3c4e-1f2a-4b5c-8d9e-0f1a2b3c4d5e";
const TWO = "1c8e4d5f-2a3b-4c6d-9e0f-1a2b3c4d5e6f";
const key = (project: string, n: number) => {
  const digest = "ab" + String(n).padStart(62, "0");
  return `media/projects/${project}/sha256/ab/${digest}.jpg`;
};

function answering(
  reply: (
    projectId: string,
    keys: string[],
  ) => { status: number; body: unknown },
) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const { keys } = JSON.parse(init.body as string) as { keys: string[] };
    const { status, body } = reply(headers["x-sx-project-id"]!, keys);
    return new Response(JSON.stringify(body), { status });
  });
}

function resolver(fetch: ReturnType<typeof answering>, now = () => 0) {
  return new SxMediaLinkResolver({
    catalogUrl: "https://sx.example/d/catalog/",
    apiKey: "sxk_test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    now,
  });
}

const linked = (keys: string[]) => ({
  status: 200,
  body: {
    links: keys.map((k) => ({ key: k, url: `https://r2.example/${k}` })),
    linksValidS: 600,
  },
});

describe("SxMediaLinkResolver", () => {
  it("asks once per Project with the key and the Project", async () => {
    const fetch = answering((_, keys) => linked(keys));
    const links = await resolver(fetch).resolve([
      key(ONE, 1),
      key(TWO, 2),
      key(ONE, 3),
    ]);

    expect(links.map((l) => l.status)).toEqual(["ready", "ready", "ready"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://sx.example/d/catalog/sentientx.sx.experience.catalog.v1.CatalogMediaService/GetMediaLinks",
    );
    expect(init.headers).toMatchObject({
      "x-api-key": "sxk_test",
      "x-sx-project-id": ONE,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      keys: [key(ONE, 1), key(ONE, 3)],
    });
  });

  it("answers a refused Project's keys as refused, the others as links", async () => {
    const fetch = answering((project, keys) =>
      project === TWO
        ? { status: 403, body: { code: "permission_denied", message: "no" } }
        : linked(keys),
    );
    const links = await resolver(fetch).resolve([key(ONE, 1), key(TWO, 2)]);
    expect(links).toEqual([
      {
        key: key(ONE, 1),
        status: "ready",
        url: `https://r2.example/${key(ONE, 1)}`,
      },
      { key: key(TWO, 2), status: "refused" },
    ]);
  });

  it("refuses a string that is no media key without asking", async () => {
    const fetch = answering((_, keys) => linked(keys));
    const links = await resolver(fetch).resolve(["media/projects/x/y.jpg"]);
    expect(links).toEqual([
      { key: "media/projects/x/y.jpg", status: "refused" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a link for less than its life", async () => {
    let now = 0;
    const fetch = answering((_, keys) => linked(keys));
    const sx = resolver(fetch, () => now);
    await sx.resolve([key(ONE, 1)]);
    now = 299_000;
    await sx.resolve([key(ONE, 1)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 300_001;
    await sx.resolve([key(ONE, 1)]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers an outage as unavailable for that Project's keys alone", async () => {
    const fetch = answering((project, keys) =>
      project === TWO
        ? { status: 503, body: { code: "unavailable", message: "down" } }
        : linked(keys),
    );
    const sx = resolver(fetch);
    const links = await sx.resolve([key(ONE, 1), key(TWO, 2)]);
    expect(links.map((l) => l.status)).toEqual(["ready", "unavailable"]);
    // Not remembered: the next ask tries again.
    await sx.resolve([key(TWO, 2)]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("says unconfigured when it has no key", async () => {
    const fetch = answering((_, keys) => linked(keys));
    const sx = new SxMediaLinkResolver({
      catalogUrl: undefined,
      apiKey: undefined,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 0,
    });
    expect(await sx.resolve([key(ONE, 1)])).toEqual([
      { key: key(ONE, 1), status: "unconfigured" },
    ]);
  });

  it("shares one call among callers in the same moment", async () => {
    const fetch = answering((_, keys) => linked(keys));
    const sx = resolver(fetch);
    const [a, b] = await Promise.all([
      sx.resolveTogether([key(ONE, 1)]),
      sx.resolveTogether([key(ONE, 2)]),
    ]);
    expect(a[0]!.status).toBe("ready");
    expect(b[0]!.status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
