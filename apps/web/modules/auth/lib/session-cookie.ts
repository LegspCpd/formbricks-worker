import { base64 } from "@better-auth/utils/base64";
import { AUTH_SECRET } from "@/lib/constants";

/**
 * Better Auth session cookie names — `cookiePrefix: "formbricks"` + `useSecureCookies: true`
 * (modules/auth/lib/auth.ts `advanced`) yield the browser-enforced `__Secure-` prefix on HTTPS; the
 * unprefixed form covers non-secure dev. (ENG-1054 cutover — replaces the NextAuth cookie names.)
 */
export const BETTER_AUTH_SESSION_COOKIE_NAMES = [
  "__Secure-formbricks.session_token",
  "formbricks.session_token",
] as const;

type TCookieStore = {
  get: (name: string) => { value: string } | undefined;
};

// ── HMAC-SHA256 ────────────────────────────────────────────────────────────────────────────────────
// This module runs in the Edge middleware bundle, so it cannot import `node:crypto` (or `@/lib/crypto`,
// which pulls in `node:crypto` too). The verification primitive has to be synchronous — the callers
// (proxy-session, the SSO recovery route) treat the extraction as sync, and Next's Edge runtime offers
// no synchronous WebCrypto — so it is implemented here in plain JS. `session-cookie.test.ts` pins the
// output to `createHmac("sha256", secret).update(token).digest("base64")` byte-for-byte.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

const sha256 = (message: Uint8Array): Uint8Array => {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = message.length;
  const bitLen = len * 8;
  const paddedLength = (((len + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[len] = 0x80;

  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000), false);
  paddedView.setUint32(paddedLength - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = paddedView.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, state[i], false);
  }
  return out;
};

const HMAC_BLOCK_SIZE = 64;

const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  // RFC 2104: keys longer than the block size are hashed; shorter keys are zero-padded.
  const normalizedKey = key.length > HMAC_BLOCK_SIZE ? sha256(key) : key;
  const paddedKey = new Uint8Array(HMAC_BLOCK_SIZE);
  paddedKey.set(normalizedKey);

  const inner = new Uint8Array(HMAC_BLOCK_SIZE + message.length);
  const outer = new Uint8Array(HMAC_BLOCK_SIZE + 32);
  for (let i = 0; i < HMAC_BLOCK_SIZE; i++) {
    inner[i] = paddedKey[i] ^ 0x36;
    outer[i] = paddedKey[i] ^ 0x5c;
  }
  inner.set(message, HMAC_BLOCK_SIZE);
  outer.set(sha256(inner), HMAC_BLOCK_SIZE);

  return sha256(outer);
};

const encoder = new TextEncoder();

/** `base64(HMAC-SHA256(message, key))`, standard alphabet with padding — matches better-call's signer. */
const sign = (message: string, key: string): string => {
  return base64.encode(hmacSha256(encoder.encode(key), encoder.encode(message)));
};

/**
 * Compare two secrets — MACs, signatures — without leaking how far the match got. The originals came
 * from `@/lib/crypto` + `node:crypto`; this Edge-safe twin mirrors those semantics: a length mismatch
 * (or an empty side) is not itself constant-time and returns `false`, and equal-length inputs are
 * compared byte-for-byte with no early exit. Only ever called on equal-width base64 digests.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
};

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/**
 * Verify Better Auth's signed cookie value and return the unsigned session token (the value stored
 * in `Session.sessionToken`), or `null` if absent or tampered with.
 *
 * Better Auth signs the cookie via better-call's `serializeSignedCookie`: the value is
 * `` `${token}.${signature}` `` where `signature = base64(HMAC-SHA256(token, BETTER_AUTH_SECRET))`
 * (standard base64; see better-call `crypto.mjs` `makeSignature`). We recompute that HMAC with the
 * same secret and constant-time-compare — so a raw `prisma.session.findUnique` can look the token up.
 * Fails closed: a missing secret or an invalid signature returns `null`.
 */
const verifyAndExtractSessionToken = (signedValue: string | null): string | null => {
  // The same resolved secret auth.ts hands Better Auth, so this verifies the cookies BA actually
  // signs — a mismatch rejects every session and loops the user between / and /auth/login. Fails
  // closed when no secret is set.
  const secret = AUTH_SECRET;
  if (!signedValue || !secret) {
    return null;
  }

  // The token is a cuid2 (no "."), the signature is standard base64 (no "."), so the single "."
  // cleanly separates them.
  const lastDot = signedValue.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === signedValue.length - 1) {
    return null;
  }

  const token = signedValue.slice(0, lastDot);
  const signature = signedValue.slice(lastDot + 1);

  if (!constantTimeEqual(sign(token, secret), signature)) {
    return null;
  }

  return token;
};

const getSignedCookieValueFromHeader = (cookieHeader: string, cookieName: string): string | null => {
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    if (!cookie.startsWith(`${cookieName}=`)) {
      continue;
    }

    const cookieValue = cookie.slice(cookieName.length + 1);
    return cookieValue.length > 0 ? decode(cookieValue) : null;
  }

  return null;
};

/** The verified, unsigned Better Auth session token from a cookie store, or null. */
export const getSessionTokenFromCookieStore = (cookieStore: TCookieStore): string | null => {
  // Try every known cookie name and return the first that VERIFIES — don't bail on a present-but-invalid
  // one (e.g. a stale `__Secure-` cookie from a prior secret/scheme sitting alongside a valid cookie),
  // which would otherwise wedge the session into a redirect loop.
  for (const cookieName of BETTER_AUTH_SESSION_COOKIE_NAMES) {
    const cookie = cookieStore.get(cookieName);
    if (!cookie?.value) continue;
    const token = verifyAndExtractSessionToken(decode(cookie.value));
    if (token) return token;
  }

  return null;
};

/** The verified, unsigned Better Auth session token from a `Cookie` header, or null. */
export const getSessionTokenFromCookieHeader = (cookieHeader: string | null): string | null => {
  if (!cookieHeader) {
    return null;
  }

  for (const cookieName of BETTER_AUTH_SESSION_COOKIE_NAMES) {
    const signedValue = getSignedCookieValueFromHeader(cookieHeader, cookieName);
    if (!signedValue) continue;
    const token = verifyAndExtractSessionToken(signedValue);
    if (token) return token;
  }

  return null;
};
