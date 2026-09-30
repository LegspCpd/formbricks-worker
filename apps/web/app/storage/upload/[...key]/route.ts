import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@formbricks/logger";
import { responses } from "@/app/lib/api/response";
import { ENCRYPTION_KEY } from "@/lib/constants";

// node:crypto and the R2 binding both require the Node runtime; the URL is presigned, so the route
// must never be statically optimised or cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type R2BucketLike = {
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
};

const computeSignature = (key: string, expires: number, secret: string): string =>
  createHmac("sha256", secret).update(`${key}|${expires}`).digest("hex");

const signaturesMatch = (expected: string, provided: string): boolean => {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");

  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
};

// Next.js has already decoded the route params once, but a proxy may have left `%2F` in place. Decoding
// here (with a fallback) yields the raw key in either case so it can be checked against the form field.
const resolveUrlKey = (segments: string[]): string | null => {
  const joined = segments.join("/");
  if (!joined) {
    return null;
  }

  try {
    return decodeURIComponent(joined);
  } catch {
    return joined;
  }
};

const getStorageBucket = async (): Promise<R2BucketLike | null> => {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const env = getCloudflareContext().env as unknown as { STORAGE_R2?: R2BucketLike };

  return env.STORAGE_R2 ?? null;
};

export const POST = async (
  request: Request,
  context: { params: Promise<{ key: string[] }> }
): Promise<Response> => {
  if (!ENCRYPTION_KEY) {
    logger.error({}, "ENCRYPTION_KEY is not set; cannot verify storage upload URL");
    return responses.internalServerErrorResponse("File storage is not configured correctly");
  }

  const searchParams = new URL(request.url).searchParams;
  const expiresParam = searchParams.get("expires");
  const signature = searchParams.get("sig");
  if (!expiresParam || !signature) {
    return responses.badRequestResponse("Missing upload token");
  }

  const expires = Number(expiresParam);
  if (!Number.isFinite(expires)) {
    return responses.badRequestResponse("Invalid upload token");
  }

  const { key: keySegments } = await context.params;
  const urlKey = resolveUrlKey(keySegments ?? []);
  if (!urlKey) {
    return responses.badRequestResponse("Invalid upload key");
  }

  if (!signaturesMatch(computeSignature(urlKey, expires, ENCRYPTION_KEY), signature)) {
    return responses.forbiddenResponse("Invalid upload signature");
  }

  if (Date.now() > expires) {
    return responses.forbiddenResponse("Upload token expired");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return responses.badRequestResponse("Invalid multipart form data");
  }

  const formKey = formData.get("key");
  if (typeof formKey !== "string" || !formKey) {
    return responses.badRequestResponse("Missing key field");
  }

  if (formKey !== urlKey) {
    return responses.forbiddenResponse("Key does not match the upload token");
  }

  const declaredContentType = formData.get("Content-Type");
  if (typeof declaredContentType !== "string" || !declaredContentType) {
    return responses.badRequestResponse("Missing Content-Type field");
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return responses.badRequestResponse("Missing file");
  }

  if (file.type && file.type !== declaredContentType) {
    return responses.badRequestResponse("Content-Type does not match the uploaded file");
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return responses.badRequestResponse("File exceeds the maximum allowed size");
  }

  let bucket: R2BucketLike | null;
  try {
    bucket = await getStorageBucket();
  } catch (error) {
    logger.error({ error }, "Failed to resolve the R2 storage binding");
    return responses.internalServerErrorResponse("File storage is not configured correctly");
  }

  if (!bucket) {
    return responses.internalServerErrorResponse("File storage is not configured correctly");
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return responses.badRequestResponse("Could not read the uploaded file");
  }

  try {
    await bucket.put(urlKey, bytes, { httpMetadata: { contentType: declaredContentType } });
  } catch (error) {
    logger.error({ error, key: urlKey }, "Failed to store the uploaded file in R2");
    return responses.internalServerErrorResponse("Failed to store the uploaded file");
  }

  return Response.json(
    { data: { key: urlKey } },
    { status: 201, headers: { "Cache-Control": "private, no-store" } }
  );
};
