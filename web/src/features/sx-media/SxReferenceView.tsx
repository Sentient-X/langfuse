// sentientx: a reference to a private recording shown as what it names: an
// episode's frames, a picture, the page that opens a recording or a QC view.
// Langfuse's server asks sx (`media.sxReferences`); nothing here holds a
// credential, and what sx refuses shows as not allowed.
import { ExternalLink, ImageOff } from "lucide-react";
import { api } from "@/src/utils/api";
import useProjectIdFromURL from "@/src/hooks/useProjectIdFromURL";
import {
  bytesInWords,
  type SxReference,
} from "@/src/features/sx-media/sxReference";

export function SxReferenceView({ reference }: { reference: SxReference }) {
  if (reference.kind === "omitted") {
    return (
      <Notice
        text={`Picture not kept in the trace (${reference.mediaType}, ${bytesInWords(reference.bytes)})`}
      />
    );
  }
  return <Resolved reference={reference.reference} />;
}

function Resolved({ reference }: { reference: string }) {
  const projectId = useProjectIdFromURL();
  const query = api.media.sxReferences.useQuery(
    { projectId: projectId as string, references: [reference] },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 2 * 60 * 1000,
    },
  );
  const shown = query.data?.[0];

  let body: React.ReactNode;
  if (query.isError || shown?.status === "unavailable") {
    const unavailable = shown?.status === "unavailable" ? shown : undefined;
    body = (
      <span className="inline-flex items-center gap-2 text-xs">
        <Notice text={unavailable?.label || "Could not load"} />
        {unavailable?.page && <OpenLink href={unavailable.page} />}
      </span>
    );
  } else if (!shown) {
    body = <div className="bg-muted h-24 w-40 animate-pulse rounded-sm" />;
  } else if (shown.status === "refused") {
    body = <Notice text={shown.label || "Not allowed"} />;
  } else if (shown.status === "unconfigured") {
    body = <Notice text="Recording links are not set up" />;
  } else {
    body = (
      <>
        {shown.pictures.length > 0 && (
          <span className="flex max-w-full flex-wrap gap-1">
            {shown.pictures.map((picture, index) =>
              picture.mediaType.startsWith("video/") ? (
                <video
                  key={index}
                  controls
                  preload="metadata"
                  src={picture.url}
                  className="max-h-60 max-w-full rounded-sm"
                />
              ) : (
                <a
                  key={index}
                  href={picture.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={picture.url}
                    alt={shown.label}
                    loading="lazy"
                    className={
                      shown.pictures.length > 1
                        ? "max-h-32 rounded-sm object-contain"
                        : "max-h-48 max-w-full rounded-sm object-contain"
                    }
                  />
                </a>
              ),
            )}
          </span>
        )}
        <span className="text-muted-foreground inline-flex items-center gap-2 text-xs">
          <span>{shown.label}</span>
          {shown.page && <OpenLink href={shown.page} />}
        </span>
      </>
    );
  }

  return (
    <span
      className="inline-flex max-w-full flex-col gap-1 py-1 align-top"
      data-sx-reference={reference}
      title={reference}
    >
      {body}
    </span>
  );
}

function OpenLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary inline-flex items-center gap-0.5 hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      Open
      <ExternalLink className="h-3 w-3" />
    </a>
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
