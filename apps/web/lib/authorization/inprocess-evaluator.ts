import "server-only";
import { prisma } from "@formbricks/database";
import type { TAuthorizationAction, TAuthorizationActor, TAuthorizationResourceForAction } from "./contract";
import type { AuthorizationEvaluator } from "./evaluator";

const ROLE_PERMISSIONS: Record<string, Record<string, string[]>> = {
  owner: {
    organization: ["read", "write", "manage", "manage_billing", "read_access", "manage_access", "manage_api_keys"],
    team: ["read", "manage", "delete"],
    workspace: ["read", "write", "manage", "share"],
    survey: ["read", "write", "manage", "delete", "publish", "response_read", "response_export"],
    dashboard: ["read", "write"],
    feedbackDirectory: ["read", "write", "manage"],
    feedbackDirectoryAssignment: ["read", "write", "manage"],
    response: ["read", "write", "manage", "export"],
    apiKey: ["read", "manage"],
  },
  manager: {
    organization: ["read", "write", "manage", "read_access", "manage_access", "manage_api_keys"],
    team: ["read", "manage"],
    workspace: ["read", "write", "manage", "share"],
    survey: ["read", "write", "manage", "delete", "publish", "response_read", "response_export"],
    dashboard: ["read", "write"],
    feedbackDirectory: ["read", "write", "manage"],
    feedbackDirectoryAssignment: ["read", "write", "manage"],
    response: ["read", "write", "manage", "export"],
    apiKey: ["read", "manage"],
  },
  member: {
    organization: ["read", "read_access"],
    team: ["read"],
    workspace: ["read"],
    survey: ["read", "response_read"],
    dashboard: ["read"],
    feedbackDirectory: ["read"],
    feedbackDirectoryAssignment: ["read"],
    response: ["read"],
    apiKey: ["read"],
  },
  admin: {
    organization: ["read", "write", "manage", "manage_billing", "read_access", "manage_access", "manage_api_keys"],
    team: ["read", "manage", "delete"],
    workspace: ["read", "write", "manage", "share"],
    survey: ["read", "write", "manage", "delete", "publish", "response_read", "response_export"],
    dashboard: ["read", "write"],
    feedbackDirectory: ["read", "write", "manage"],
    feedbackDirectoryAssignment: ["read", "write", "manage"],
    response: ["read", "write", "manage", "export"],
    apiKey: ["read", "manage"],
  },
};

const getRolePermissions = (role: string, resourceType: string): string[] => {
  const rolePerms = ROLE_PERMISSIONS[role];
  if (!rolePerms) return [];
  return rolePerms[resourceType] || [];
};

const getUserRoleInOrganization = async (userId: string, organizationId: string): Promise<string | null> => {
  try {
    const membership = await prisma.membership.findFirst({
      where: {
        userId,
        organizationId,
      },
      select: { role: true },
    });
    return membership?.role ?? null;
  } catch {
    return null;
  }
};

const getUserRoleInWorkspace = async (userId: string, workspaceId: string): Promise<string | null> => {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: {
        team: {
          select: {
            organization: {
              select: {
                memberships: {
                  where: { userId },
                  select: { role: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    return workspace?.team?.organization?.memberships[0]?.role ?? null;
  } catch {
    return null;
  }
};

const getOrganizationIdForResource = async (
  resource: { type: string; id: string } & Record<string, string>
): Promise<string | null> => {
  try {
    switch (resource.type) {
      case "organization":
        return resource.id;
      case "team": {
        const team = await prisma.team.findFirst({
          where: { id: resource.id },
          select: { organizationId: true },
        });
        return team?.organizationId ?? null;
      }
      case "workspace": {
        const workspace = await prisma.workspace.findFirst({
          where: { id: resource.id },
          select: { team: { select: { organizationId: true } } },
        });
        return workspace?.team?.organizationId ?? null;
      }
      case "survey": {
        const survey = await prisma.survey.findFirst({
          where: { id: resource.id },
          select: { workspace: { select: { team: { select: { organizationId: true } } } } },
        });
        return survey?.workspace?.team?.organizationId ?? null;
      }
      case "dashboard": {
        const dashboard = await prisma.dashboard.findFirst({
          where: { id: resource.id },
          select: { workspace: { select: { team: { select: { organizationId: true } } } } },
        });
        return dashboard?.workspace?.team?.organizationId ?? null;
      }
      case "feedbackDirectory": {
        const fd = await prisma.feedbackDirectory.findFirst({
          where: { id: resource.id },
          select: { workspace: { select: { team: { select: { organizationId: true } } } } },
        });
        return fd?.workspace?.team?.organizationId ?? null;
      }
      case "feedbackDirectoryAssignment": {
        const fda = await prisma.feedbackDirectoryAssignment.findFirst({
          where: { id: resource.id },
          select: { feedbackDirectory: { select: { workspace: { select: { team: { select: { organizationId: true } } } } } } },
        });
        return fda?.feedbackDirectory?.workspace?.team?.organizationId ?? null;
      }
      case "response": {
        const response = await prisma.response.findFirst({
          where: { id: resource.id },
          select: { survey: { select: { workspace: { select: { team: { select: { organizationId: true } } } } } } },
        });
        return response?.survey?.workspace?.team?.organizationId ?? null;
      }
      case "apiKey": {
        const apiKey = await prisma.apiKey.findFirst({
          where: { id: resource.id },
          select: { organizationId: true },
        });
        return apiKey?.organizationId ?? null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
};

const parseAction = (action: string): { resourceType: string; permission: string } | null => {
  const parts = action.split(".");
  if (parts.length !== 2) return null;
  return { resourceType: parts[0], permission: parts[1] };
};

export const inProcessEvaluator: AuthorizationEvaluator = {
  async can<TAction extends TAuthorizationAction>(
    actor: TAuthorizationActor,
    action: TAction,
    resource: TAuthorizationResourceForAction<NoInfer<TAction>>
  ): Promise<boolean> {
    if (actor.type === "apiKey") {
      const parsedAction = parseAction(action);
      if (!parsedAction) return false;
      const perms = getRolePermissions("admin", parsedAction.resourceType);
      return perms.includes(parsedAction.permission);
    }

    const parsedAction = parseAction(action);
    if (!parsedAction) return false;

    const resourceWithId = resource as { type: string; id: string };
    const organizationId = await getOrganizationIdForResource(resourceWithId);

    if (!organizationId) return false;

    const userRole = await getUserRoleInOrganization(actor.id, organizationId);
    if (!userRole) return false;

    const permissions = getRolePermissions(userRole, parsedAction.resourceType);
    return permissions.includes(parsedAction.permission);
  },
};
