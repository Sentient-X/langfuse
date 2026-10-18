// sentientx: one indexed frame of an episode, fetched by Langfuse's server from
// the sx Catalog's governed thumbnail route with Langfuse's own sx key, for a
// signed-in Langfuse user. Only that route's exact shape is fetched: a frame's
// content digest and its Project. A browser keeps it no longer than a link lives.
import { type NextApiRequest, type NextApiResponse } from "next";
import { logger } from "@langfuse/shared/src/server";
import { getServerAuthSession } from "@/src/server/auth";

const THUMBNAIL_PATH =
  /^\/d\/catalog\/api\/experience\/thumbs\/[0-9a-f]{64}\?project_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const CACHE_S = 300;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET")
    return res.status(405).json({ message: "Method not allowed" });
  const session = await getServerAuthSession({ req, res });
  if (!session?.user) return res.status(401).json({ message: "Unauthorized" });

  const path = req.query.path;
  if (typeof path !== "string" || !THUMBNAIL_PATH.test(path))
    return res.status(400).json({ message: "Not a picture this serves" });
  const catalogUrl = process.env.SX_CATALOG_URL;
  const apiKey = process.env.SX_MEDIA_API_KEY;
  const projectId = process.env.SX_MEDIA_PROJECT_ID;
  if (!catalogUrl || !apiKey || !projectId)
    return res.status(503).json({ message: "Media links are not set up" });

  try {
    const response = await fetch(`${new URL(catalogUrl).origin}${path}`, {
      headers: { "x-api-key": apiKey, "x-sx-project-id": projectId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 403)
      return res.status(404).json({ message: "Not allowed" });
    if (!response.ok)
      return res.status(502).json({ message: "Could not load the picture" });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_PICTURE_BYTES)
      return res.status(502).json({ message: "Picture too large" });
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ?? "image/jpeg",
    );
    // No longer than a reference's links live, so a revoked grant stops showing.
    res.setHeader("Cache-Control", `private, max-age=${CACHE_S}`);
    return res.status(200).send(body);
  } catch (error) {
    logger.warn("sx picture fetch failed", { error });
    return res.status(502).json({ message: "Could not load the picture" });
  }
}
