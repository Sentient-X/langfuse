import { describe, expect, it } from "vitest";
import {
  parseSxMediaKey,
  splitTextBySxMediaKeys,
} from "@/src/features/sx-media/sxMediaKey";
import { classifyMediaValue } from "@/src/components/ui/media/mediaUtils";

const PROJECT = "0b7d3c4e-1f2a-4b5c-8d9e-0f1a2b3c4d5e";
const DIGEST = "ab" + "0".repeat(62);
const KEY = `media/projects/${PROJECT}/sha256/ab/${DIGEST}.jpg`;
const CLIP = `media/projects/${PROJECT}/sha256/ab/${DIGEST}.mp4`;
const PAGE = `media/projects/${PROJECT}/report-pictures/sha256/ab/${DIGEST}.png`;

describe("parseSxMediaKey", () => {
  it("reads a picture key's Project and type", () => {
    expect(parseSxMediaKey(KEY)).toEqual({
      key: KEY,
      projectId: PROJECT,
      contentType: "image/jpeg",
    });
  });

  it("reads clips and report pictures", () => {
    expect(parseSxMediaKey(CLIP)?.contentType).toBe("video/mp4");
    expect(parseSxMediaKey(PAGE)?.contentType).toBe("image/png");
  });

  it("is no key for anything else", () => {
    for (const value of [
      "",
      "hello",
      42,
      null,
      `${KEY} `,
      KEY.replace(".jpg", ".json"),
      KEY.replace("/sha256/ab/", "/sha256/cd/"),
      KEY.replace(PROJECT, "not-a-project"),
      `media/projects/${PROJECT}/${DIGEST}.jpg`,
    ]) {
      expect(parseSxMediaKey(value)).toBeNull();
    }
  });
});

describe("splitTextBySxMediaKeys", () => {
  it("leaves text without keys whole", () => {
    expect(splitTextBySxMediaKeys("looks fine")).toEqual([
      { type: "text", value: "looks fine" },
    ]);
  });

  it("cuts out each key in free text", () => {
    const segments = splitTextBySxMediaKeys(`see ${KEY} and ${CLIP}.`);
    expect(segments.map((s) => s.type)).toEqual([
      "text",
      "key",
      "text",
      "key",
      "text",
    ]);
    expect(segments[1]).toEqual({ type: "key", key: parseSxMediaKey(KEY) });
    expect(segments[4]).toEqual({ type: "text", value: "." });
  });
});

describe("classifyMediaValue", () => {
  it("classifies a media key as sx media", () => {
    expect(classifyMediaValue(KEY)).toEqual({
      kind: "sxKey",
      contentType: "image/jpeg",
      sxKey: parseSxMediaKey(KEY),
    });
  });
});
