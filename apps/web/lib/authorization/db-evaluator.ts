import "server-only";
import { prisma } from "@formbricks/database";
import { Prisma } from "@formbricks/database/prisma";
import type { OrganizationRole } from "@formbricks/database/prisma";
import { DatabaseError } from "@formbricks/types/errors";
import { USER_MANAGEMENT_MINIMUM_ROLE } from "@/lib/constants";
import {
  AUTHORIZATION_PERMISSION_MAP,
  type TAuthorizationAction,
  type TAuthorizationActor,
  type TAuthorizationResourceForAction,
  type TAuthorizationResourceType,
} from "./contract";
import type { AuthorizationEvaluator } from "./evaluator";
import {
  getFeedbackDirectoryAssignmentAuthorizationScope,
  getFeedbackDirectoryAuthorizationScope,
} from "./resolvers";
import { resolveAuthorizationScope } from "./source-scope";

const rethrowAsDatabaseError = (error: unknown): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    throw new DatabaseError(error.message);
  }
  throw error;
};

const parseAction = (
  action: TAuthorizationAction
): Readonly<{ permission: string; resourceType: TAuthorizationResourceType }> => {
  const separator = action.indexOf(".");
  return {
    permission: action.slice(separator + 1),
    resourceType: action.slice(0, separator) as TAuthorizationResourceType,
  };
};

const WORKSPACE_PERMISSION_FOR_DERIVED_ACTION = {
  "dashboard.read": "read",
  "dashboard.write": "write",
  "response.export": "read",
  "response.manage": "manage",
  "response.read": "read",
  "response.write": "write",
  "survey.delete": "write",
  "survey.manage": "manage",
  "survey.publish": "write",
  "survey.read": "read",
  "survey.response_export": "read",
  "survey.response_read": "read",
  "survey.write": "write",
} as const satisfies Partial<Record<TAuthorizationAction, "manage" | "read" | "write">>;

const getPermission = (
  actor: TAuthorizationActor,
  action: TAuthorizationAction,
  resourceType: TAuthorizationResourceType
): string | null => {
  const parsed = parseAction(action);
  if (
    parsed.resourceType !== resourceType ||
    !(AUTHORIZATION_PERMISSION_MAP[resourceType] as readonly string[]).includes(parsed.permission)
  ) {
    throw new Error(`Invalid authorization action/resource combination`);
  }

  if (actor.type === "user" && action === "organization.manage_access") {
    switch (USER_MANAGEMENT_MINIMUM_ROLE) {
      case "disabled":
        return null;
      case "owner":
        return "write";
      case "manager":
        return "manage_access";
    }
  }

  if (action in WORKSPACE_PERMISSION_FOR_DERIVED_ACTION) {
    return WORKSPACE_PERMISSION_FOR_DERIVED_ACTION[
      action as keyof typeof WORKSPACE_PERMISSION_FOR_DERIVED_ACTION
    ];
  }

  return parsed.permission;
};

const ORGANIZATION_ROLE_PERMISSIONS = {
  billing: ["read", "manage_billing"],
  manager: ["read", "manage", "manage_billing", "read_access", "manage_access", "manage_api_keys"],
  member: ["read", "read_access"],
  owner: ["read", "write", "manage", "manage_billing", "read_access", "manage_access", "manage_api_keys"],
} as const satisfies Record<OrganizationRole, ReadonlyArray<string>>;

const PRODUCT_MEMBER_ROLES: ReadonlyArray<OrganizationRole> = ["owner", "manager", "member"];

const WORKSPACE_PERMISSION_LEVEL = {
  manage: 3,
  read: 1,
  share: 3,
  write: 2,
} as const;

const requiredWorkspaceLevel = (permission: string): number | null =>
  (WORKSPACE_PERMISSION_LEVEL as Record<string, number>)[permission] ?? null;

const API_KEY_WORKSPACE_PERMISSION_LEVEL = { manage: 3, read: 1, write: 2 } as const;

const WORKSPACE_TEAM_PERMISSION_LEVEL = { manage: 3, read: 1, readWrite: 2 } as const;

type TApiKeyActorContext = Readonly<{
  organizationId: string;
  read: boolean;
  write: boolean;
}>;

const normalizeAccessControl = (value: unknown): Readonly<{ read: boolean; write: boolean }> => {
  if (typeof value !== "object" || value === null) return { read: false, write: false };
  const accessControl = (value as Record<string, unknown>).accessControl;
  if (typeof accessControl !== "object" || accessControl === null) return { read: false, write: false };
  const record = accessControl as Record<string, unknown>;
  return { read: record.read === true, write: record.write === true };
};

const getUserOrganizationRole = async (
  userId: string,
  organizationId: string
): Promise<OrganizationRole | null> => {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { organizationId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
};

const getApiKeyActorContext = async (apiKeyId: string): Promise<TApiKeyActorContext | null> => {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: apiKeyId },
    select: { organizationAccess: true, organizationId: true },
  });
  if (!apiKey) return null;
  const access = normalizeAccessControl(apiKey.organizationAccess);
  return { organizationId: apiKey.organizationId, read: access.read, write: access.write };
};

const getTeamUserRole = async (userId: string, teamId: string): Promise<string | null> => {
  const teamUser = await prisma.teamUser.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  return teamUser?.role ?? null;
};

const getUserWorkspaceLevel = async (
  userId: string,
  workspaceId: string,
  workspaceOrganizationId: string
): Promise<number> => {
  const [membership, teamUsers] = await Promise.all([
    prisma.membership.findUnique({
      where: { userId_organizationId: { organizationId: workspaceOrganizationId, userId } },
      select: { role: true },
    }),
    prisma.teamUser.findMany({
      where: { userId },
      select: { team: { select: { organizationId: true } }, teamId: true },
    }),
  ]);

  const role = membership?.role ?? null;
  if (role === "owner" || role === "manager") return 3;

  if (teamUsers.length === 0) return 0;

  const teamOrganizationIds = [...new Set(teamUsers.map((teamUser) => teamUser.team.organizationId))];
  const memberships = await prisma.membership.findMany({
    where: { organizationId: { in: teamOrganizationIds }, userId },
    select: { organizationId: true, role: true },
  });
  const productMemberOrganizations = new Set(
    memberships
      .filter((entry) => (PRODUCT_MEMBER_ROLES as ReadonlyArray<string>).includes(entry.role))
      .map((entry) => entry.organizationId)
  );

  const eligibleTeamIds = teamUsers
    .filter((teamUser) => productMemberOrganizations.has(teamUser.team.organizationId))
    .map((teamUser) => teamUser.teamId);

  if (eligibleTeamIds.length === 0) return 0;

  const grants = await prisma.workspaceTeam.findMany({
    where: { teamId: { in: eligibleTeamIds }, workspaceId },
    select: { permission: true },
  });

  let best = 0;
  for (const grant of grants) {
    best = Math.max(best, WORKSPACE_TEAM_PERMISSION_LEVEL[grant.permission]);
  }
  return best;
};

const getApiKeyWorkspaceLevel = async (apiKeyId: string, workspaceId: string): Promise<number> => {
  const grant = await prisma.apiKeyWorkspace.findUnique({
    where: { apiKeyId_workspaceId: { apiKeyId, workspaceId } },
    select: { permission: true },
  });
  return grant ? API_KEY_WORKSPACE_PERMISSION_LEVEL[grant.permission] : 0;
};

const getWorkspaceLevel = async (
  actor: TAuthorizationActor,
  workspaceId: string,
  workspaceOrganizationId: string
): Promise<number> =>
  actor.type === "user"
    ? getUserWorkspaceLevel(actor.id, workspaceId, workspaceOrganizationId)
    : getApiKeyWorkspaceLevel(actor.id, workspaceId);

const hasOrganizationReadAccess = async (
  actor: TAuthorizationActor,
  organizationId: string
): Promise<boolean> => {
  if (actor.type === "user") {
    const role = await getUserOrganizationRole(actor.id, organizationId);
    return role !== null && (PRODUCT_MEMBER_ROLES as ReadonlyArray<string>).includes(role);
  }
  const context = await getApiKeyActorContext(actor.id);
  return context !== null && context.organizationId === organizationId && (context.read || context.write);
};

const hasOrganizationManageAccess = async (
  actor: TAuthorizationActor,
  organizationId: string
): Promise<boolean> => {
  if (actor.type === "user") {
    const role = await getUserOrganizationRole(actor.id, organizationId);
    return role === "owner" || role === "manager";
  }
  const context = await getApiKeyActorContext(actor.id);
  return context !== null && context.organizationId === organizationId && context.write;
};

const canActOnOrganization = async (
  actor: TAuthorizationActor,
  permission: string,
  organizationId: string
): Promise<boolean> => {
  if (actor.type === "user") {
    const role = await getUserOrganizationRole(actor.id, organizationId);
    return (
      role !== null && (ORGANIZATION_ROLE_PERMISSIONS[role] as ReadonlyArray<string>).includes(permission)
    );
  }

  const context = await getApiKeyActorContext(actor.id);
  if (context === null || context.organizationId !== organizationId) return false;

  const permissions = new Set<string>();
  if (context.read || context.write) permissions.add("read").add("read_access");
  if (context.write) permissions.add("manage_access");
  return permissions.has(permission);
};

const canActOnApiKey = async (actor: TAuthorizationActor, organizationId: string): Promise<boolean> => {
  // `api_key#read` and `api_key#manage` both expand to `organization->manage_api_keys`, which is a
  // user-only relation (organization owners and managers). An API-key principal therefore never
  // satisfies either permission.
  if (actor.type !== "user") return false;
  const role = await getUserOrganizationRole(actor.id, organizationId);
  return (
    role !== null &&
    (ORGANIZATION_ROLE_PERMISSIONS[role] as ReadonlyArray<string>).includes("manage_api_keys")
  );
};

const canActOnTeam = async (
  actor: TAuthorizationActor,
  permission: string,
  teamId: string,
  organizationId: string
): Promise<boolean> => {
  if (permission === "delete") {
    return hasOrganizationManageAccess(actor, organizationId);
  }

  if (permission === "manage") {
    if (actor.type === "user") {
      const teamRole = await getTeamUserRole(actor.id, teamId);
      if (teamRole === "admin") return true;
    }
    return hasOrganizationManageAccess(actor, organizationId);
  }

  if (permission === "read") {
    if (actor.type === "user") {
      const [teamRole, organizationRole] = await Promise.all([
        getTeamUserRole(actor.id, teamId),
        getUserOrganizationRole(actor.id, organizationId),
      ]);
      const isProductMember =
        organizationRole !== null &&
        (PRODUCT_MEMBER_ROLES as ReadonlyArray<string>).includes(organizationRole);
      if (teamRole !== null && isProductMember) return true;
    }
    return hasOrganizationReadAccess(actor, organizationId);
  }

  return false;
};

const canActOnWorkspace = async (
  actor: TAuthorizationActor,
  permission: string,
  workspaceId: string,
  organizationId: string
): Promise<boolean> => {
  const required = requiredWorkspaceLevel(permission);
  if (required === null) return false;
  return (await getWorkspaceLevel(actor, workspaceId, organizationId)) >= required;
};

const isOrganizationAdministrator = (
  actor: TAuthorizationActor,
  organizationId: string
): Promise<boolean> => {
  // `feedback_directory#administrator` is `organization->manage` typed `user`, so only organization
  // owners and managers qualify; an API key never does.
  if (actor.type !== "user") return Promise.resolve(false);
  return hasOrganizationManageAccess(actor, organizationId);
};

const canActOnFeedbackDirectory = async (
  actor: TAuthorizationActor,
  permission: string,
  organizationId: string,
  workspaceIds: ReadonlyArray<string>
): Promise<boolean> => {
  if (await isOrganizationAdministrator(actor, organizationId)) return true;

  const required = requiredWorkspaceLevel(permission);
  if (required === null) return false;

  for (const workspaceId of workspaceIds) {
    if ((await getWorkspaceLevel(actor, workspaceId, organizationId)) >= required) return true;
  }
  return false;
};

const canActOnFeedbackDirectoryAssignment = async (
  actor: TAuthorizationActor,
  permission: string,
  organizationId: string,
  workspaceId: string
): Promise<boolean> => {
  if (await isOrganizationAdministrator(actor, organizationId)) return true;

  const required = requiredWorkspaceLevel(permission);
  if (required === null) return false;

  return (await getWorkspaceLevel(actor, workspaceId, organizationId)) >= required;
};

/**
 * PostgreSQL-direct authorization evaluator.
 *
 * Formbricks v6 on Cloudflare Workers cannot reach a SpiceDB server (gRPC/TCP is unavailable in the
 * Worker runtime), so this evaluator answers every decision from the PostgreSQL source of truth. It
 * reproduces the permission expansions documented in `authzed/schema.zed` exactly — organization
 * roles, TeamUser, WorkspaceTeam, ApiKeyWorkspace and ApiKey.organizationAccess — so moving a check
 * here neither grants nor removes access.
 */
export const dbEvaluator: AuthorizationEvaluator = {
  async can<TAction extends TAuthorizationAction>(
    actor: TAuthorizationActor,
    action: TAction,
    resource: TAuthorizationResourceForAction<NoInfer<TAction>>
  ): Promise<boolean> {
    const permission = getPermission(actor, action, resource.type);
    if (!permission) return false;

    const scope = await resolveAuthorizationScope(actor, resource);
    if (!scope || !scope.actorValid) return false;

    try {
      switch (scope.permissionResource.type) {
        case "workspace":
          return await canActOnWorkspace(
            actor,
            permission,
            scope.permissionResource.id,
            scope.organizationId
          );
        case "organization":
          return await canActOnOrganization(actor, permission, scope.permissionResource.id);
        case "team":
          return await canActOnTeam(actor, permission, scope.permissionResource.id, scope.organizationId);
        case "apiKey":
          return await canActOnApiKey(actor, scope.organizationId);
        case "feedbackDirectory": {
          const directory = await getFeedbackDirectoryAuthorizationScope(scope.permissionResource.id);
          if (!directory) return false;
          return await canActOnFeedbackDirectory(
            actor,
            permission,
            directory.organizationId,
            directory.workspaceIds
          );
        }
        case "feedbackDirectoryAssignment": {
          const assignmentResource = resource as Readonly<{
            feedbackDirectoryId: string;
            workspaceId: string;
          }>;
          const assignment = await getFeedbackDirectoryAssignmentAuthorizationScope(
            assignmentResource.feedbackDirectoryId,
            assignmentResource.workspaceId
          );
          if (!assignment) return false;
          return await canActOnFeedbackDirectoryAssignment(
            actor,
            permission,
            assignment.organizationId,
            assignment.workspaceId
          );
        }
      }

      // `resolveAuthorizationScope` remaps survey, dashboard and response resources onto their owning
      // workspace, so no other permission-resource type can reach here. Fail closed if one ever does.
      return false;
    } catch (error) {
      return rethrowAsDatabaseError(error);
    }
  },
};
