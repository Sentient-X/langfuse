// sentientx: a Catalog media key shown as the picture or the playing clip it
// names, the key itself one click away. Links come from Langfuse's own server
// (`media.sxLinks`), which asks the sx API; nothing here holds a credential.
import { useState } from "react";
import { Check, Copy, ImageOff } from "lucide-react";
import { api } from "@/src/utils/api";
import useProjectIdFromURL from "@/src/hooks/useProjectIdFromURL";
import { copyTextToClipboard } from "@/src/utils/clipboard";
import {
  splitTextBySxMediaKeys,
  type SxMediaKey,
} from "@/src/features/sx-media/sxMediaKey";

export function SxMediaKeyView({ mediaKey }: { mediaKey: SxMediaKey }) {
  const projectId = useProjectIdFromURL();
  const query = api.media.sxLinks.useQuery(
    { projectId: projectId as string, keys: [mediaKey.key] },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // The server keeps a link for half its life; refetch well inside that.
      staleTime: 2 * 60 * 1000,
    },
  );
  const link = query.data?.[0];
  const isVideo = mediaKey.contentType.startsWith("video/");

  let body: React.ReactNode;
  if (query.isError) {
    body = <Notice text="Could not load" />;
  } else if (!link) {
    body = <div className="bg-muted h-32 w-48 animate-pulse rounded-sm" />;
  } else if (link.status === "refused") {
    body = <Notice text="Not allowed" />;
  } else if (link.status === "unconfigured") {
    body = <Notice text="Media links are not set up" />;
  } else if (isVideo) {
    body = (
      <video
        controls
        preload="metadata"
        src={link.url}
        className="max-h-80 max-w-full rounded-sm"
      />
    );
  } else {
    body = (
      <a href={link.url} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={link.url}
          alt={mediaKey.key}
          loading="lazy"
          className="max-h-80 max-w-full rounded-sm object-contain"
        />
      </a>
    );
  }

  return (
    <span
      className="inline-flex max-w-full flex-col gap-1 py-1 align-top"
      data-sx-media-key={mediaKey.key}
    >
      {body}
      <CopyKey mediaKey={mediaKey.key} />
    </span>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <span className="text-muted-foreground bg-muted inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs">
      <ImageOff className="h-3.5 w-3.5" />
      {text}
    </span>
  );
}

function CopyKey({ mediaKey }: { mediaKey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the media key"
      className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-left font-mono text-[10px]"
      onClick={(event) => {
        event.stopPropagation();
        copyTextToClipboard(mediaKey).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? (
        <Check className="h-3 w-3 shrink-0" />
      ) : (
        <Copy className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate" title={mediaKey}>
        {mediaKey}
      </span>
    </button>
  );
}

/** Free text with each media key inside it shown as its picture or clip. */
export function SxMediaText({ text }: { text: string }) {
  const segments = splitTextBySxMediaKeys(text);
  if (segments.length === 1 && segments[0]!.type === "text") return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <span key={index}>{segment.value}</span>
        ) : (
          <SxMediaKeyView key={index} mediaKey={segment.key} />
        ),
      )}
    </>
  );
}
