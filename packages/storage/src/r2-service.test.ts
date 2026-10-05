import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createUploadSignature, getSignedUploadUrl, setR2Bucket, verifyUploadSignature } from "./r2-service";

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@formbricks/logger", () => ({
  logger: mockLogger,
}));

const SECRET = "test-encryption-key";
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const clearR2Bucket = (): void => {
  (globalThis as { __cloudflareR2?: unknown }).__cloudflareR2 = undefined;
};

const mockBucket = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  createMultipartUpload: vi.fn(),
};

describe("r2-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = SECRET;
    setR2Bucket(mockBucket);
  });

  afterEach(() => {
    if (ORIGINAL_ENCRYPTION_KEY === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    }
    clearR2Bucket();
  });

  describe("createUploadSignature / verifyUploadSignature", () => {
    test("signs HMAC-SHA256 over `${key}|${expires}`", async () => {
      const expires = 1_700_000_000_000;
      const expected = createHmac("sha256", SECRET).update(`a/b/c.txt|${expires}`).digest("hex");

      await expect(createUploadSignature("a/b/c.txt", expires, SECRET)).resolves.toBe(expected);
    });

    test("verifies a signature it produced", async () => {
      const expires = Date.now() + 60_000;
      const signature = await createUploadSignature("a/b/c.txt", expires, SECRET);

      await expect(verifyUploadSignature(signature, "a/b/c.txt", expires, SECRET)).resolves.toBe(true);
    });

    test("rejects a signature bound to a different key", async () => {
      const expires = Date.now() + 60_000;
      const signature = await createUploadSignature("a/b/c.txt", expires, SECRET);

      await expect(verifyUploadSignature(signature, "a/b/other.txt", expires, SECRET)).resolves.toBe(false);
    });

    test("rejects a signature bound to a different expiry", async () => {
      const expires = Date.now() + 60_000;
      const signature = await createUploadSignature("a/b/c.txt", expires, SECRET);

      await expect(verifyUploadSignature(signature, "a/b/c.txt", expires + 1, SECRET)).resolves.toBe(false);
    });

    test("rejects a signature produced with a different secret", async () => {
      const expires = Date.now() + 60_000;
      const signature = await createUploadSignature("a/b/c.txt", expires, "another-secret");

      await expect(verifyUploadSignature(signature, "a/b/c.txt", expires, SECRET)).resolves.toBe(false);
    });

    test("rejects a malformed signature without throwing", async () => {
      await expect(
        verifyUploadSignature("not-a-valid-signature", "a/b/c.txt", Date.now(), SECRET)
      ).resolves.toBe(false);
    });
  });

  describe("getSignedUploadUrl", () => {
    test("returns a relative upload URL carrying an expires + sig token", async () => {
      const result = await getSignedUploadUrl("report.pdf", "application/pdf", "ws/private/surveys/s1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { signedUrl, presignedFields, uploadMethod } = result.data;
      const key = "ws/private/surveys/s1/report.pdf";

      // The client switches on this to decide PUT-raw-body vs multipart POST; R2's proxy route only
      // accepts a PUT, so a POST here would fail the upload.
      expect(uploadMethod).toBe("PUT");
      expect(presignedFields).toEqual({ key, "Content-Type": "application/pdf" });

      const url = new URL(signedUrl, "https://app.example.com");
      expect(url.pathname).toBe(`/storage/upload/${encodeURIComponent(key)}`);

      const expiresParam = url.searchParams.get("expires");
      const signature = url.searchParams.get("sig") ?? "";
      const expires = Number(expiresParam);

      expect(expiresParam).not.toBeNull();
      expect(Number.isFinite(expires)).toBe(true);
      await expect(verifyUploadSignature(signature, key, expires, SECRET)).resolves.toBe(true);
    });

    test("returns an S3 client error when no bucket is configured", async () => {
      clearR2Bucket();

      const result = await getSignedUploadUrl("report.pdf", "application/pdf", "ws/private");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("s3_client_error");
      }
    });

    test("returns a credentials error when ENCRYPTION_KEY is missing", async () => {
      delete process.env.ENCRYPTION_KEY;

      const result = await getSignedUploadUrl("report.pdf", "application/pdf", "ws/private");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("s3_credentials_error");
      }
    });
  });
});
