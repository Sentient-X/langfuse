import { describe, expect, it, vi } from "vitest";
import {
  bytesInWords,
  parseSxReference,
} from "@/src/features/sx-media/sxReference";
import {
  browserUrl,
  SxReferenceResolver,
} from "@/src/features/sx-media/server/sxReferences";
import { classifyMediaValue } from "@/src/components/ui/media/mediaUtils";

vi.mock("@langfuse/shared/src/server", () => ({
  logger: { warn: () => undefined },
}));

const EPISODE = "ep_6dce375a430589eb9e455f6812c4f5698416e646";
const DIGEST = "b4" + "0a".repeat(31);
const RECORDING =
  "captures/sentientx/cs_4910425d/artifacts/009c761d/5d7c0369.mcap";

describe("parseSxReference", () => {
  it("reads every reference shape our traces carry", () => {
    for (const value of [
      EPISODE,
      "ep_be84a9c1",
      `episode:${EPISODE}@12.5#quest3s/head_left/camera/compressed`,
      `episode:${EPISODE}@3-9`,
      `episode:${EPISODE}@1792231819191480853ns#quest3s/head_left/camera/compressed`,
      `r2://sx-catalog/${RECORDING}`,
      RECORDING,
      "qc/view/01980000-0000-7000-8000-000000000001/b98ba48a-39c1-4346-98a4-d9c130144a42/cs_77b42b16/ep_ab97d039/91fc47ab.rrd",
      "https://d35e9189.r2.cloudflarestorage.com/sx-catalog/media/x.png?X-Amz-Signature=1",
    ]) {
      expect(parseSxReference(value)).toEqual({
        kind: "resolvable",
        reference: value,
      });
    }
  });

  it("reads tracing's note for a picture it did not keep", () => {
    expect(
      parseSxReference(
        `sx-media-omitted:image/jpeg;sha256=${"ab".repeat(32)};bytes=12345`,
      ),
    ).toEqual({
      kind: "omitted",
      reference: `sx-media-omitted:image/jpeg;sha256=${"ab".repeat(32)};bytes=12345`,
      mediaType: "image/jpeg",
      bytes: 12345,
    });
    expect(bytesInWords(12345)).toBe("12 KB");
    // Base64 that did not decode is named by its text: about 3 bytes in 4 chars.
    expect(
      parseSxReference(
        `sx-media-omitted:image/png;sha256-of-text=${"cd".repeat(32)};chars=4000`,
      ),
    ).toMatchObject({ kind: "omitted", mediaType: "image/png", bytes: 3000 });
  });

  it("is no reference for anything else", () => {
    for (const value of [
      "",
      "episode",
      "ep_xyz",
      "the episode ep_6dce375a went well",
      "https://example.com/x.png",
      "captures of the floor",
      `media/projects/0b7d3c4e-1f2a-4b5c-8d9e-0f1a2b3c4d5e/sha256/b4/${DIGEST}.jpg`,
      42,
      null,
    ]) {
      expect(parseSxReference(value)).toBeNull();
    }
  });

  it("is classified for every value view", () => {
    expect(classifyMediaValue(EPISODE)?.kind).toBe("sxReference");
  });
});

describe("SxReferenceResolver", () => {
  const config = (fetch: typeof globalThis.fetch) => ({
    catalogUrl: "https://app.sentientx.io/d/catalog",
    apiKey: "sk-test",
    projectId: "b98ba48a-39c1-4346-98a4-d9c130144a42",
    fetch,
    now: () => 1_000,
  });

  it("asks once within the key's Project and proxies sx-origin pictures", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        references: [EPISODE, "ep_00000000"],
      });
      expect((init?.headers as Record<string, string>)["x-sx-project-id"]).toBe(
        "b98ba48a-39c1-4346-98a4-d9c130144a42",
      );
      return new Response(
        JSON.stringify({
          resolved: [
            {
              reference: EPISODE,
              shown: "REFERENCE_SHOWN_MEDIA",
              pictures: [
                {
                  url: `/d/catalog/api/experience/thumbs/${DIGEST}?project_id=b98ba48a-39c1-4346-98a4-d9c130144a42`,
                  mediaType: "MEDIA_TYPE_JPEG",
                },
              ],
              pictureTimesNs: ["7"],
              page: "https://app.sentientx.io/p/sentientx/platform/library/episodes/cs_1/ep_1",
              label: "Episode ep_6dce375a, head_left camera",
            },
            {
              reference: "ep_00000000",
              shown: "REFERENCE_SHOWN_REFUSED",
              label: "Not allowed: an episode you cannot read",
            },
          ],
          linksValidS: 3600,
        }),
        { status: 200 },
      );
    });
    const resolver = new SxReferenceResolver(config(fetch as never));
    const [shown, refused] = await resolver.resolve([EPISODE, "ep_00000000"]);
    expect(shown).toEqual({
      reference: EPISODE,
      status: "ready",
      label: "Episode ep_6dce375a, head_left camera",
      page: "https://app.sentientx.io/p/sentientx/platform/library/episodes/cs_1/ep_1",
      pictures: [
        {
          url: `/api/sx-media/picture?path=${encodeURIComponent(`/d/catalog/api/experience/thumbs/${DIGEST}?project_id=b98ba48a-39c1-4346-98a4-d9c130144a42`)}`,
          mediaType: "image/jpeg",
          timeNs: "7",
        },
      ],
    });
    expect(refused).toEqual({
      reference: "ep_00000000",
      status: "refused",
      label: "Not allowed: an episode you cannot read",
    });
    // Answers are kept: asking again calls nobody.
    await resolver.resolve([EPISODE]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says unavailable, uncached, when sx cannot answer", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    const resolver = new SxReferenceResolver(config(fetch as never));
    expect((await resolver.resolve([EPISODE]))[0]?.status).toBe("unavailable");
    await resolver.resolve([EPISODE]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats only pictures or a page as ready, anything else as unavailable", async () => {
    const answers = [
      {
        reference: "ep_00000001",
        shown: "REFERENCE_SHOWN_UNAVAILABLE",
        label: "Episode ep_00000001: its frames are unavailable right now",
        page: "https://app.sentientx.io/p/x/library/episodes/cs_1/ep_00000001",
      },
      { reference: "ep_00000002", shown: "REFERENCE_SHOWN_SOMETHING_NEW" },
      { reference: "ep_00000003", shown: "REFERENCE_SHOWN_PAGE" },
      { reference: "ep_00000004" },
      {
        reference: "ep_00000005",
        shown: "REFERENCE_SHOWN_PAGE",
        page: "https://app.sentientx.io/p/x",
        label: "Episode",
      },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ resolved: answers, linksValidS: 3600 }), {
          status: 200,
        }),
    );
    const resolver = new SxReferenceResolver(config(fetch as never));
    const references = answers.map((a) => a.reference);
    const shown = await resolver.resolve(references);
    expect(shown.map((s) => s.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "ready",
    ]);
    expect(shown[0]).toEqual({
      reference: "ep_00000001",
      status: "unavailable",
      label: "Episode ep_00000001: its frames are unavailable right now",
      page: "https://app.sentientx.io/p/x/library/episodes/cs_1/ep_00000001",
    });
    expect(shown[1]).toEqual({
      reference: "ep_00000002",
      status: "unavailable",
    });
    // Only the ready answer is kept.
    await resolver.resolve(references);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, again] = fetch.mock.calls[1] as unknown as [unknown, RequestInit];
    expect(JSON.parse(String(again.body))).toEqual({
      references: references.slice(0, 4),
    });
  });

  it("never hands a browser anything but a link or our own proxy", () => {
    expect(browserUrl("https://signed.example/x.jpg")).toBe(
      "https://signed.example/x.jpg",
    );
    expect(browserUrl("/d/catalog/api/elsewhere")).toBeNull();
    expect(browserUrl("javascript:alert(1)")).toBeNull();
  });
});
