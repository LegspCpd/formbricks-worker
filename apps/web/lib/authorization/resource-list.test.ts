import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTHZED_ERROR_CODES } from "@/lib/authzed/errors";
import { getAuthorizationSurface, recordAuthorizationCheckIssued } from "./context";
import { recordAuthorizationDecision } from "./metrics";
import { lookupAuthorizedOrganizationIds, lookupAuthorizedWorkspaceIds } from "./resource-list";

const membershipFindMany = vi.fn();
const apiKeyFindUnique = vi.fn();
const apiKeyWorkspaceFindMany = vi.fn();
const teamUserFindMany = vi.fn();
const workspaceFindMany = vi.fn();
const workspaceTeamFindMany = vi.fn();

vi.mock("@formbricks/database", () => ({
  prisma: {
    apiKey: { findUnique: (...args: unknown[]) => apiKeyFindUnique(...args) },
    apiKeyWorkspace: { findMany: (...args: unknown[]) => apiKeyWorkspaceFindMany(...args) },
    membership: { findMany: (...args: unknown[]) => membershipFindMany(...args) },
    teamUser: { findMany: (...args: unknown[]) => teamUserFindMany(...args) },
    workspace: { findMany: (...args: unknown[]) => workspaceFindMany(...args) },
    workspaceTeam: { findMany: (...args: unknown[]) => workspaceTeamFindMany(...args) },
  },
}));

vi.mock("./context", () => ({
  getAuthorizationSurface: vi.fn(() => "unscoped"),
  recordAuthorizationCheckIssued: vi.fn(),
}));
vi.mock("./metrics", () => ({ recordAuthorizationDecision: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  membershipFindMany.mockResolvedValue([]);
  apiKeyFindUnique.mockResolvedValue(null);
  apiKeyWorkspaceFindMany.mockResolvedValue([]);
  teamUserFindMany.mockResolvedValue([]);
  workspaceFindMany.mockResolvedValue([]);
  workspaceTeamFindMany.mockResolvedValue([]);
});

describe("authoritative resource lists", () => {
  test("lists the organizations a user is a member of", async () => {
    membershipFindMany.mockResolvedValue([{ organizationId: "organization-1", role: "member" }]);

    await expect(lookupAuthorizedOrganizationIds({ type: "user", id: "user-1" })).resolves.toEqual([
      "organization-1",
    ]);

    expect(recordAuthorizationCheckIssued).toHaveBeenCalledOnce();
    expect(recordAuthorizationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.read",
        actorType: "user",
        outcome: "allow",
        resourceType: "organization",
        surface: "unscoped",
      })
    );
  });

  test("lists the organizations an API key may read", async () => {
    apiKeyFindUnique.mockResolvedValue({
      organizationAccess: { accessControl: { read: true } },
      organizationId: "organization-1",
    });

    await expect(lookupAuthorizedOrganizationIds({ type: "apiKey", id: "key-1" })).resolves.toEqual([
      "organization-1",
    ]);
  });

  test.each(["read", "write"] as const)("lists the %s workspaces an API key holds", async (permission) => {
    apiKeyWorkspaceFindMany.mockResolvedValue([
      { permission: "manage", workspaceId: "workspace-1" },
      { permission: "read", workspaceId: "workspace-2" },
    ]);

    await expect(lookupAuthorizedWorkspaceIds({ type: "apiKey", id: "key-1" }, permission)).resolves.toEqual(
      permission === "read" ? ["workspace-1", "workspace-2"] : ["workspace-1"]
    );
  });

  test("lists every workspace for an organization owner", async () => {
    membershipFindMany.mockResolvedValue([{ organizationId: "organization-1", role: "owner" }]);
    workspaceFindMany.mockResolvedValue([{ id: "workspace-1" }, { id: "workspace-2" }]);

    await expect(lookupAuthorizedWorkspaceIds({ type: "user", id: "user-1" })).resolves.toEqual([
      "workspace-1",
      "workspace-2",
    ]);
  });

  test("lists team-granted workspaces for a non-billing member", async () => {
    membershipFindMany.mockResolvedValue([{ organizationId: "organization-1", role: "member" }]);
    teamUserFindMany.mockResolvedValue([{ team: { organizationId: "organization-1" }, teamId: "team-1" }]);
    workspaceTeamFindMany.mockResolvedValue([
      { permission: "readWrite", workspaceId: "workspace-1" },
      { permission: "read", workspaceId: "workspace-2" },
    ]);

    await expect(lookupAuthorizedWorkspaceIds({ type: "user", id: "user-1" }, "write")).resolves.toEqual([
      "workspace-1",
    ]);
  });

  test("fails closed on an operational database error", async () => {
    membershipFindMany.mockRejectedValue(new Error("database unavailable"));

    await expect(lookupAuthorizedWorkspaceIds({ type: "user", id: "user-1" })).rejects.toMatchObject({
      code: AUTHZED_ERROR_CODES.INTERNAL,
      operation: "authorization_list",
    });
    expect(recordAuthorizationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: AUTHZED_ERROR_CODES.INTERNAL, outcome: "operational_error" })
    );
  });

  test("records an empty list as an aggregate deny on the active surface", async () => {
    vi.mocked(getAuthorizationSurface).mockReturnValueOnce("mcp");

    await expect(lookupAuthorizedWorkspaceIds({ type: "apiKey", id: "key-1" })).resolves.toEqual([]);

    expect(recordAuthorizationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "deny", surface: "mcp" })
    );
  });
});
