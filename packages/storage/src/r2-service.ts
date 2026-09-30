import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@formbricks/logger";
import type { FileStreamResult } from "./service";
import { type Result, type StorageError, StorageErrorCode, err, ok } from "./types/error";

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload>;
}

interface R2ObjectBody {
  key: string;
  size: number;
  etag: string;
  httpMetadata?: Record<string, unknown>;
  body: ReadableStream;
  writeHttpMetadata(headers: Headers): Promise<void>;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

interface R2PutOptions {
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
}

interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

interface R2MultipartOptions {
  httpMetadata?: Record<string, unknown>;
}

interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | string): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
}

interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

const getR2Bucket = (): R2Bucket | null => {
  try {
    const g = globalThis as unknown as { __cloudflareR2?: R2Bucket };
    if (g.__cloudflareR2) {
      return g.__cloudflareR2;
    }
  } catch {
    // not on Cloudflare
  }
  return null;
};

export const setR2Bucket = (bucket: R2Bucket): void => {
  (globalThis as unknown as { __cloudflareR2?: R2Bucket }).__cloudflareR2 = bucket;
};

const UPLOAD_URL_TTL_MS = 2 * 60 * 1000;

export const createUploadSignature = (key: string, expires: number, secret: string): string =>
  createHmac("sha256", secret).update(`${key}|${expires}`).digest("hex");

export const verifyUploadSignature = (
  signature: string,
  key: string,
  expires: number,
  secret: string
): boolean => {
  const expected = Buffer.from(createUploadSignature(key, expires, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");

  return expected.length === provided.length && timingSafeEqual(expected, provided);
};

export const getSignedUploadUrl = (
  fileName: string,
  contentType: string,
  filePath: string,
  _maxSize: number = 1024 * 1024 * 10
): Promise<Result<{ signedUrl: string; presignedFields: PresignedPost["fields"] }, StorageError>> => {
  try {
    const bucket = getR2Bucket();
    if (!bucket) {
      return Promise.resolve(err({ code: StorageErrorCode.S3ClientError }));
    }

    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
      logger.error({ fileName, filePath }, "ENCRYPTION_KEY is not set; cannot sign R2 upload URL");
      return Promise.resolve(err({ code: StorageErrorCode.S3CredentialsError }));
    }

    const key = `${filePath}/${fileName}`;
    const expires = Date.now() + UPLOAD_URL_TTL_MS;
    const signature = createUploadSignature(key, expires, secret);
    const url = `/storage/upload/${encodeURIComponent(key)}?expires=${expires}&sig=${signature}`;

    return Promise.resolve(
      ok({
        signedUrl: url,
        presignedFields: {
          key,
          "Content-Type": contentType,
        },
      })
    );
  } catch (error) {
    logger.error({ error, fileName, filePath }, "Failed to get R2 signed upload URL");
    return Promise.resolve(err({ code: StorageErrorCode.S3ClientError }));
  }
};

export const getSignedDownloadUrl = (
  filePath: string,
  _expiresIn: number = 3600
): Promise<Result<string, StorageError>> => {
  try {
    const bucket = getR2Bucket();
    if (!bucket) {
      return Promise.resolve(err({ code: StorageErrorCode.S3ClientError }));
    }

    return Promise.resolve(ok(`/storage/download/${encodeURIComponent(filePath)}`));
  } catch (error) {
    logger.error({ error, filePath }, "Failed to get R2 signed download URL");
    return Promise.resolve(err({ code: StorageErrorCode.S3ClientError }));
  }
};

export const deleteFile = async (filePath: string): Promise<Result<void, StorageError>> => {
  try {
    const bucket = getR2Bucket();
    if (!bucket) {
      return err({ code: StorageErrorCode.S3ClientError });
    }

    await bucket.delete(filePath);
    return ok(undefined);
  } catch (error) {
    logger.error({ error, filePath }, "Failed to delete file from R2");
    return err({ code: StorageErrorCode.S3ClientError });
  }
};

export const deleteFilesByPrefix = async (prefix: string): Promise<Result<void, StorageError>> => {
  try {
    const bucket = getR2Bucket();
    if (!bucket) {
      return err({ code: StorageErrorCode.S3ClientError });
    }

    const listResult = await bucket.list({ prefix });
    if (listResult.objects.length > 0) {
      await bucket.delete(listResult.objects.map((obj) => obj.key));
    }
    return ok(undefined);
  } catch (error) {
    logger.error({ error, prefix }, "Failed to delete files by prefix from R2");
    return err({ code: StorageErrorCode.S3ClientError });
  }
};

export const getFileStream = async (filePath: string): Promise<Result<FileStreamResult, StorageError>> => {
  try {
    const bucket = getR2Bucket();
    if (!bucket) {
      return err({ code: StorageErrorCode.S3ClientError });
    }

    const object = await bucket.get(filePath);
    if (!object) {
      return err({ code: StorageErrorCode.FileNotFoundError });
    }

    return ok({
      body: object.body as ReadableStream<Uint8Array>,
      contentType: (object.httpMetadata?.["content-type"] as string) || "application/octet-stream",
      contentLength: object.size,
    });
  } catch (error) {
    logger.error({ error, filePath }, "Failed to get file stream from R2");
    return err({ code: StorageErrorCode.S3ClientError });
  }
};
