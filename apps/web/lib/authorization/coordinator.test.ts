import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTHZED_ERROR_CODES, AuthzedError } from "@/lib/authzed/errors";
import { getAuthorizationSurface } from "./context";
import { authorizationCoordinator } from "./coordinator";
import { dbEvaluator } from "./db-evaluator";
import { recordAuthorizationDecision } from "./metrics";

vi.mock("./context", () => ({ getAuthorizationSurface: vi.fn(() => "unscoped") }));
vi.mock("./metrics", () => ({ recordAuthorizationDecision: vi.fn() }));
vi.mock("./db-evaluator", () => ({ dbEvaluator: { can: vi.fn() } }));

const actor = { type: "user", id: "user-1" } as const;
const resource = { type: "survey", id: "survey-1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authorizationCoordinator", () => {
  test("uses the PostgreSQL evaluator for an unscoped central authorization call", async () => {
    vi.mocked(dbEvaluator.can).mockResolvedValue(true);

    await expect(authorizationCoordinator.can(actor, "survey.read", resource)).resolves.toBe(true);

    expect(dbEvaluator.can).toHaveBeenCalledExactlyOnceWith(actor, "survey.read", resource);
    expect(recordAuthorizationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "survey.read",
        actorType: "user",
        outcome: "allow",
        resourceType: "survey",
        surface: "unscoped",
      })
    );
  });

  test("returns a genuine denial", async () => {
    vi.mocked(dbEvaluator.can).mockResolvedValue(false);

    await expect(authorizationCoordinator.can(actor, "survey.read", resource)).resolves.toBe(false);
    expect(recordAuthorizationDecision).toHaveBeenCalledWith(expect.objectContaining({ outcome: "deny" }));
  });

  test("preserves stable AuthZed failures without exposing the original error", async () => {
    const outage = new AuthzedError({
      attempts: 3,
      code: AUTHZED_ERROR_CODES.UNAVAILABLE,
      grpcStatus: 14,
      operation: "check_permission",
      retryable: true,
    });
    vi.mocked(dbEvaluator.can).mockRejectedValue(outage);

    const thrown = await authorizationCoordinator
      .can(actor, "survey.read", resource)
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      attempts: 3,
      code: AUTHZED_ERROR_CODES.UNAVAILABLE,
      grpcStatus: 14,
      operation: "authorization",
      retryable: true,
    });
    expect(thrown).not.toHaveProperty("cause", outage);
    expect(recordAuthorizationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: AUTHZED_ERROR_CODES.UNAVAILABLE,
        outcome: "operational_error",
      })
    );
  });

  test("normalizes resolver failures into a fail-closed operational error", async () => {
    vi.mocked(dbEvaluator.can).mockRejectedValue(new Error("database unavailable"));

    await expect(authorizationCoordinator.can(actor, "survey.read", resource)).rejects.toMatchObject({
      attempts: 1,
      code: AUTHZED_ERROR_CODES.INTERNAL,
      operation: "authorization",
      retryable: false,
    });
  });

  test("records the active bounded request surface", async () => {
    vi.mocked(getAuthorizationSurface).mockReturnValueOnce("api_v3");
    vi.mocked(dbEvaluator.can).mockResolvedValue(true);

    await authorizationCoordinator.can(actor, "survey.read", resource);

    expect(recordAuthorizationDecision).toHaveBeenCalledWith(expect.objectContaining({ surface: "api_v3" }));
  });
});
