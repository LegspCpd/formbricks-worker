import "server-only";

/**
 * gRPC status codes, inlined as numeric literals.
 *
 * `@grpc/grpc-js` is a TCP/HTTP2 client that cannot run inside a Cloudflare Worker, so the real
 * gRPC client is no longer reachable at runtime. The codes themselves are stable wire constants
 * (https://grpc.io/docs/guides/status-codes/), so the mapping keeps its exact behaviour without the
 * dependency — and without dragging the transport into the Worker bundle.
 */
const GRPC_STATUS = {
  ABORTED: 10,
  ALREADY_EXISTS: 6,
  CANCELLED: 1,
  DEADLINE_EXCEEDED: 4,
  FAILED_PRECONDITION: 9,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  OUT_OF_RANGE: 11,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAUTHENTICATED: 16,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
} as const;

export const AUTHZED_ERROR_CODES = {
  ABORTED: "authzed_aborted",
  CANCELLED: "authzed_cancelled",
  CONFLICT: "authzed_conflict",
  DISABLED: "authzed_disabled",
  FAILED_PRECONDITION: "authzed_failed_precondition",
  INTERNAL: "authzed_internal",
  INVALID_REQUEST: "authzed_invalid_request",
  LIMIT_EXCEEDED: "authzed_limit_exceeded",
  NOT_FOUND: "authzed_not_found",
  OVERLOADED: "authzed_overloaded",
  PERMISSION_DENIED: "authzed_permission_denied",
  PROJECTION_STALE: "authzed_projection_stale",
  SCHEMA_CHANGED: "authzed_schema_changed",
  SCHEMA_VERIFICATION_FAILED: "authzed_schema_verification_failed",
  TIMEOUT: "authzed_timeout",
  UNAUTHENTICATED: "authzed_unauthenticated",
  UNAVAILABLE: "authzed_unavailable",
  UNSUPPORTED: "authzed_unsupported",
} as const;

export type TAuthzedErrorCode = (typeof AUTHZED_ERROR_CODES)[keyof typeof AUTHZED_ERROR_CODES];

type TAuthzedErrorOptions = Readonly<{
  attempts: number;
  cause?: unknown;
  code: TAuthzedErrorCode;
  grpcStatus?: number;
  operation: string;
  retryable: boolean;
}>;

export class AuthzedError extends Error {
  readonly attempts: number;
  readonly cause?: unknown;
  readonly code: TAuthzedErrorCode;
  readonly grpcStatus?: number;
  readonly operation: string;
  readonly retryable: boolean;

  constructor({ attempts, cause, code, grpcStatus, operation, retryable }: TAuthzedErrorOptions) {
    super(code);
    this.name = "AuthzedError";
    this.attempts = attempts;
    this.cause = cause;
    this.code = code;
    this.grpcStatus = grpcStatus;
    this.operation = operation;
    this.retryable = retryable;
  }
}

const getGrpcStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "number" ? code : undefined;
};

const getErrorDescriptor = (
  grpcStatus: number | undefined
): Readonly<{ code: TAuthzedErrorCode; retryable: boolean }> => {
  switch (grpcStatus) {
    case GRPC_STATUS.DEADLINE_EXCEEDED:
      return { code: AUTHZED_ERROR_CODES.TIMEOUT, retryable: true };
    case GRPC_STATUS.UNAVAILABLE:
      return { code: AUTHZED_ERROR_CODES.UNAVAILABLE, retryable: true };
    case GRPC_STATUS.RESOURCE_EXHAUSTED:
      return { code: AUTHZED_ERROR_CODES.OVERLOADED, retryable: true };
    case GRPC_STATUS.ABORTED:
      return { code: AUTHZED_ERROR_CODES.ABORTED, retryable: true };
    case GRPC_STATUS.UNAUTHENTICATED:
      return { code: AUTHZED_ERROR_CODES.UNAUTHENTICATED, retryable: false };
    case GRPC_STATUS.PERMISSION_DENIED:
      return { code: AUTHZED_ERROR_CODES.PERMISSION_DENIED, retryable: false };
    case GRPC_STATUS.INVALID_ARGUMENT:
    case GRPC_STATUS.OUT_OF_RANGE:
      return { code: AUTHZED_ERROR_CODES.INVALID_REQUEST, retryable: false };
    case GRPC_STATUS.FAILED_PRECONDITION:
      return { code: AUTHZED_ERROR_CODES.FAILED_PRECONDITION, retryable: false };
    case GRPC_STATUS.NOT_FOUND:
      return { code: AUTHZED_ERROR_CODES.NOT_FOUND, retryable: false };
    case GRPC_STATUS.ALREADY_EXISTS:
      return { code: AUTHZED_ERROR_CODES.CONFLICT, retryable: false };
    case GRPC_STATUS.CANCELLED:
      return { code: AUTHZED_ERROR_CODES.CANCELLED, retryable: false };
    case GRPC_STATUS.UNIMPLEMENTED:
      return { code: AUTHZED_ERROR_CODES.UNSUPPORTED, retryable: false };
    default:
      return { code: AUTHZED_ERROR_CODES.INTERNAL, retryable: false };
  }
};

export const mapAuthzedError = (error: unknown, operation: string, attempts: number): AuthzedError => {
  if (error instanceof AuthzedError) {
    return new AuthzedError({
      attempts,
      cause: error.cause ?? error,
      code: error.code,
      grpcStatus: error.grpcStatus,
      operation,
      retryable: error.retryable,
    });
  }

  const grpcStatus = getGrpcStatus(error);
  const descriptor = getErrorDescriptor(grpcStatus);

  return new AuthzedError({
    attempts,
    cause: error,
    code: descriptor.code,
    grpcStatus,
    operation,
    retryable: descriptor.retryable,
  });
};
