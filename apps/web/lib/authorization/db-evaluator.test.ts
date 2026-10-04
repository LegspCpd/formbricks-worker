import { beforeEach, describe, expect, test, vi } from "vitest";
import { dbEvaluator } from "./db-evaluator";
import {
  getFeedbackDirectoryAssignmentAuthorizationScope,
  getFeedbackDirectoryAuthorizationScope,
} from "./resolvers";
import { resolveAuthorizationScope } from "./source-scope";

const membershipFindUnique = vi.fn();
const teamUserFindUnique = vi.fn();
const teamUserFindMany = vi.fn();
const membershipFindMany = vi.fn();
const workspaceTeamFindMany = vi.fn();
const apiKeyFindUnique = vi.fn();
const apiKeyWorkspaceFindUnique = vi.fn();

vi.mock("@formbricks/database", () => ({
  prisma: {
    apiKey: { findUnique: (...args: unknown[]) => apiKeyFindUnique(...args) },
    apiKeyWorkspace: { findUnique: (...args: unknown[]) => apiKeyWorkspaceFindUnique(...args) },
    membership: {
      findMany: (...args: unknown[]) => membershipFindMany(...args),
      findUnique: (...args: unknown[]) => membershipFindUnique(...args),
    },
    teamUser: {
      findMany: (...args: unknown[]) => teamUserFindMany(...args),
      findUnique: (...args: unknown[]) => teamUserFindUnique(...args),
    },
    workspaceTeam: { findMany: (...args: unknown[]) => workspaceTeamFindMany(...args) },
  },
}));

vi.mock("@/lib/constants", () => ({ USER_MANAGEMENT_MINIMUM_ROLE: "manager" }));
vi.mock("./source-scope", () => ({ resolveAuthorizationScope: vi.fn() }));
vi.mock("./resolvers", () => ({
  getFeedbackDirectoryAssignmentAuthorizationScope: vi.fn(),
  getFeedbackDirectoryAuthorizationScope: vi.fn(),
}));

const user = { type: "user", id: "user-1" } as const;
const apiKey = { type: "apiKey", id: "key-1" } as const;

const scopeTo = (organizationId: string, type: string, id: string): void => {
  vi.mocked(resolveAuthorizationScope).mockResolvedValue({
    actorValid: true,
    organizationId,
    permissionResource: { id, type: type as never },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  membershipFindUnique.mockResolvedValue(null);
  teamUserFindUnique.mockResolvedValue(null);
  teamUserFindMany.mockResolvedValue([]);
  membershipFindMany.mockResolvedValue([]);
  workspaceTeamFindMany.mockResolvedValue([]);
  apiKeyFindUnique.mockResolvedValue(null);
  apiKeyWorkspaceFindUnique.mockResolvedValue(null);
});

describe("dbEvaluator organization ladder", () => {
  test("owner may write the organization but manager may not", async () => {
    scopeTo("org-1", "organization", "org-1");
    membershipFindUnique.mockResolvedValueOnce({ role: "owner" });
    await expect(
      dbEvaluator.can(user, "organization.write", { type: "organization", id: "org-1" })
    ).resolves.toBe(true);

    membershipFindUnique.mockResolvedValueOnce({ role: "manager" });
    await expect(
      dbEvaluator.can(user, "organization.write", { type: "organization", id: "org-1" })
    ).resolves.toBe(false);
  });

  test("manager may manage the organization", async () => {
    scopeTo("org-1", "organization", "org-1");
    membershipFindUnique.mockResolvedValue({ role: "manager" });
    await expect(
      dbEvaluator.can(user, "organization.manage_access", { type: "organization", id: "org-1" })
    ).resolves.toBe(true);
  });

  test("member may read the organization but not manage access", async () => {
    scopeTo("org-1", "organization", "org-1");
    membershipFindUnique.mockResolvedValue({ role: "member" });
    await expect(
      dbEvaluator.can(user, "organization.read", { type: "organization", id: "org-1" })
    ).resolves.toBe(true);
    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    await expect(
      dbEvaluator.can(user, "organization.manage_access", { type: "organization", id: "org-1" })
    ).resolves.toBe(false);
  });

  test("an api key with write organization access may manage access", async () => {
    scopeTo("org-1", "organization", "org-1");
    apiKeyFindUnique.mockResolvedValue({
      organizationAccess: { accessControl: { write: true } },
      organizationId: "org-1",
    });
    await expect(
      dbEvaluator.can(apiKey, "organization.manage_access", { type: "organization", id: "org-1" })
    ).resolves.toBe(true);
  });

  test("a read-only api key may not manage access", async () => {
    scopeTo("org-1", "organization", "org-1");
    apiKeyFindUnique.mockResolvedValue({
      organizationAccess: { accessControl: { read: true } },
      organizationId: "org-1",
    });
    await expect(
      dbEvaluator.can(apiKey, "organization.manage_access", { type: "organization", id: "org-1" })
    ).resolves.toBe(false);
  });
});

describe("dbEvaluator workspace ladder", () => {
  test("owner holds every workspace permission through organization->manage", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    membershipFindUnique.mockResolvedValue({ role: "owner" });
    await expect(dbEvaluator.can(user, "workspace.manage", { type: "workspace", id: "ws-1" })).resolves.toBe(
      true
    );
  });

  test("billing member gets no product access even with a team grant", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    membershipFindUnique.mockResolvedValue({ role: "billing" });
    teamUserFindMany.mockResolvedValue([{ team: { organizationId: "org-1" }, teamId: "team-1" }]);
    membershipFindMany.mockResolvedValue([{ organizationId: "org-1", role: "billing" }]);

    await expect(dbEvaluator.can(user, "workspace.read", { type: "workspace", id: "ws-1" })).resolves.toBe(
      false
    );
    expect(workspaceTeamFindMany).not.toHaveBeenCalled();
  });

  test("a readWrite team grant allows write but not manage", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    teamUserFindMany.mockResolvedValue([{ team: { organizationId: "org-1" }, teamId: "team-1" }]);
    membershipFindMany.mockResolvedValue([{ organizationId: "org-1", role: "member" }]);
    workspaceTeamFindMany.mockResolvedValue([{ permission: "readWrite" }]);

    await expect(dbEvaluator.can(user, "workspace.write", { type: "workspace", id: "ws-1" })).resolves.toBe(
      true
    );

    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    await expect(dbEvaluator.can(user, "workspace.manage", { type: "workspace", id: "ws-1" })).resolves.toBe(
      false
    );
  });

  test("a read team grant allows read but not write", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    teamUserFindMany.mockResolvedValue([{ team: { organizationId: "org-1" }, teamId: "team-1" }]);
    membershipFindMany.mockResolvedValue([{ organizationId: "org-1", role: "member" }]);
    workspaceTeamFindMany.mockResolvedValue([{ permission: "read" }]);

    await expect(dbEvaluator.can(user, "workspace.read", { type: "workspace", id: "ws-1" })).resolves.toBe(
      true
    );

    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    await expect(dbEvaluator.can(user, "workspace.write", { type: "workspace", id: "ws-1" })).resolves.toBe(
      false
    );
  });

  test("an api key uses its ApiKeyWorkspace grant", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    apiKeyWorkspaceFindUnique.mockResolvedValue({ permission: "write" });
    await expect(dbEvaluator.can(apiKey, "workspace.write", { type: "workspace", id: "ws-1" })).resolves.toBe(
      true
    );
    await expect(
      dbEvaluator.can(apiKey, "workspace.manage", { type: "workspace", id: "ws-1" })
    ).resolves.toBe(false);
  });

  test("survey permissions derive from the owning workspace", async () => {
    scopeTo("org-1", "workspace", "ws-1");
    membershipFindUnique.mockResolvedValue({ role: "member" });
    await expect(dbEvaluator.can(user, "survey.read", { type: "survey", id: "survey-1" })).resolves.toBe(
      false
    );
  });
});

describe("dbEvaluator team and feedback-directory ladders", () => {
  test("a team admin may manage the team", async () => {
    scopeTo("org-1", "team", "team-1");
    membershipFindUnique.mockResolvedValue({ role: "member" });
    teamUserFindUnique.mockResolvedValue({ role: "admin" });
    await expect(dbEvaluator.can(user, "team.manage", { type: "team", id: "team-1" })).resolves.toBe(true);
  });

  test("deleting a team requires organization manage access", async () => {
    scopeTo("org-1", "team", "team-1");
    membershipFindUnique.mockResolvedValue({ role: "manager" });
    await expect(dbEvaluator.can(user, "team.delete", { type: "team", id: "team-1" })).resolves.toBe(true);
  });

  test("a directory administrator may manage a feedback directory", async () => {
    scopeTo("org-1", "feedbackDirectory", "dir-1");
    membershipFindUnique.mockResolvedValue({ role: "owner" });
    vi.mocked(getFeedbackDirectoryAuthorizationScope).mockResolvedValue({
      isArchived: false,
      organizationId: "org-1",
      workspaceIds: [],
    });
    await expect(
      dbEvaluator.can(user, "feedbackDirectory.manage", { type: "feedbackDirectory", id: "dir-1" })
    ).resolves.toBe(true);
  });

  test("a workspace grant on an assignment allows read but not manage", async () => {
    scopeTo("org-1", "feedbackDirectoryAssignment", "fdwa_x");
    vi.mocked(getFeedbackDirectoryAssignmentAuthorizationScope).mockResolvedValue({
      assignmentId: "fdwa_x",
      organizationId: "org-1",
      workspaceId: "ws-1",
    });
    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    teamUserFindMany.mockResolvedValue([{ team: { organizationId: "org-1" }, teamId: "team-1" }]);
    membershipFindMany.mockResolvedValue([{ organizationId: "org-1", role: "member" }]);
    workspaceTeamFindMany.mockResolvedValue([{ permission: "read" }]);

    await expect(
      dbEvaluator.can(user, "feedbackDirectoryAssignment.read", {
        feedbackDirectoryId: "dir-1",
        type: "feedbackDirectoryAssignment",
        workspaceId: "ws-1",
      })
    ).resolves.toBe(true);

    membershipFindUnique.mockResolvedValueOnce({ role: "member" });
    await expect(
      dbEvaluator.can(user, "feedbackDirectoryAssignment.manage", {
        feedbackDirectoryId: "dir-1",
        type: "feedbackDirectoryAssignment",
        workspaceId: "ws-1",
      })
    ).resolves.toBe(false);
  });
});

describe("dbEvaluator actor validity", () => {
  test("denies when the actor is invalid", async () => {
    vi.mocked(resolveAuthorizationScope).mockResolvedValue({
      actorValid: false,
      organizationId: "org-1",
      permissionResource: { id: "ws-1", type: "workspace" },
    });
    await expect(dbEvaluator.can(user, "workspace.read", { type: "workspace", id: "ws-1" })).resolves.toBe(
      false
    );
  });

  test("denies when the resource cannot be resolved", async () => {
    vi.mocked(resolveAuthorizationScope).mockResolvedValue(null);
    await expect(dbEvaluator.can(user, "workspace.read", { type: "workspace", id: "ws-1" })).resolves.toBe(
      false
    );
  });
});
