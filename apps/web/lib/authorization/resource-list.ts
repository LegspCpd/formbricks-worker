import "server-only";
import { performance } from "node:perf_hooks";
import { cache as reactCache } from "react";
import { prisma } from "@formbricks/database";
import { getAuthorizationSurface, recordAuthorizationCheckIssued } from "./context";
import type { TAuthorizationAction, TAuthorizationActor } from "./contract";
import { recordAuthorizationDecision } from "./metrics";
import { normalizeAuthorizationOperationalError } from "./operational-error";

type TCurrentListResource = "organization" | "workspace";
type TCurrentListPermission = "read" | "write";

const WORKSPACE_PERMISSION_LEVEL = { read: 1, write: 2 } as const;
const WORKSPACE_TEAM_PERMISSION_LEVEL = { manage: 3, read: 1, readWrite: 2 } as const;
const API_KEY_WORKSPACE_PERMISSION_LEVEL = { manage: 3, read: 1, write: 2 } as const;

const PRODUCT_MEMBER_ROLES: ReadonlyArray<string> = ["owner", "manager", "member"];

const lookupAuthorizedOrganizationIdsFromDatabase = async (
  actor: TAuthorizationActor
): Promise<ReadonlyArray<string>> => {
  if (actor.type === "user") {
    // `organization#read` includes every membership role, including `billing`.
    const memberships = await prisma.membership.findMany({
      where: { userId: actor.id },
      select: { organizationId: true },
      orderBy: { organizationId: "asc" },
    });
    return memberships.map(({ organizationId }) => organizationId);
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { id: actor.id },
    select: { organizationAccess: true, organizationId: true },
  });
  if (!apiKey) return [];

  const accessControl =
    typeof apiKey.organizationAccess === "object" && apiKey.organizationAccess !== null
      ? (apiKey.organizationAccess as Record<string, unknown>).accessControl
      : undefined;
  const record =
    typeof accessControl === "object" && accessControl !== null
      ? (accessControl as Record<string, unknown>)
      : {};
  const hasReadAccess = record.read === true || record.write === true;
  return hasReadAccess ? [apiKey.organizationId] : [];
};

const lookupAuthorizedWorkspaceIdsFromDatabase = async (
  actor: TAuthorizationActor,
  permission: TCurrentListPermission
): Promise<ReadonlyArray<string>> => {
  const minimumLevel = WORKSPACE_PERMISSION_LEVEL[permission];
  const authorized = new Set<string>();

  if (actor.type === "apiKey") {
    const grants = await prisma.apiKeyWorkspace.findMany({
      where: { apiKeyId: actor.id },
      select: { permission: true, workspaceId: true },
    });
    for (const grant of grants) {
      if (API_KEY_WORKSPACE_PERMISSION_LEVEL[grant.permission] >= minimumLevel) {
        authorized.add(grant.workspaceId);
      }
    }
    return [...authorized].sort((left, right) => left.localeCompare(right));
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: actor.id },
    select: { organizationId: true, role: true },
  });

  // Organization owners and managers hold `organization->manage`, which grants every workspace.
  const organizationWideIds = memberships
    .filter(({ role }) => role === "owner" || role === "manager")
    .map(({ organizationId }) => organizationId);
  if (organizationWideIds.length > 0) {
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId: { in: organizationWideIds } },
      select: { id: true },
    });
    for (const workspace of workspaces) authorized.add(workspace.id);
  }

  // Team-derived access: only teams whose organization the user is a non-billing member of.
  const productMemberOrganizationIds = memberships
    .filter(({ role }) => (PRODUCT_MEMBER_ROLES as ReadonlyArray<string>).includes(role))
    .map(({ organizationId }) => organizationId);

  if (productMemberOrganizationIds.length > 0) {
    const teamUsers = await prisma.teamUser.findMany({
      where: { userId: actor.id },
      select: { team: { select: { organizationId: true } }, teamId: true },
    });
    const eligibleTeamIds = teamUsers
      .filter(({ team }) => productMemberOrganizationIds.includes(team.organizationId))
      .map(({ teamId }) => teamId);

    if (eligibleTeamIds.length > 0) {
      const grants = await prisma.workspaceTeam.findMany({
        where: { teamId: { in: eligibleTeamIds } },
        select: { permission: true, workspaceId: true },
      });
      for (const grant of grants) {
        if (WORKSPACE_TEAM_PERMISSION_LEVEL[grant.permission] >= minimumLevel) {
          authorized.add(grant.workspaceId);
        }
      }
    }
  }

  return [...authorized].sort((left, right) => left.localeCompare(right));
};

const lookupAuthorizationResourceIds = reactCache(
  async (
    actorType: TAuthorizationActor["type"],
    actorId: string,
    resourceType: TCurrentListResource,
    permission: TCurrentListPermission
  ): Promise<ReadonlyArray<string>> => {
    recordAuthorizationCheckIssued();
    const startedAt = performance.now();
    const action = `${resourceType}.${permission}` as TAuthorizationAction;
    const metric = {
      action,
      actorType,
      resourceType,
      surface: getAuthorizationSurface(),
    } as const;

    try {
      const actor: TAuthorizationActor =
        actorType === "user" ? { type: "user", id: actorId } : { type: "apiKey", id: actorId };
      const resourceIds =
        resourceType === "organization"
          ? await lookupAuthorizedOrganizationIdsFromDatabase(actor)
          : await lookupAuthorizedWorkspaceIdsFromDatabase(actor, permission);

      recordAuthorizationDecision({
        ...metric,
        durationMs: performance.now() - startedAt,
        // For a list operation, an empty authorized set is the aggregate equivalent of a deny.
        outcome: resourceIds.length > 0 ? "allow" : "deny",
      });
      return resourceIds;
    } catch (error) {
      const normalized = normalizeAuthorizationOperationalError(error, "authorization_list");
      recordAuthorizationDecision({
        ...metric,
        durationMs: performance.now() - startedAt,
        errorCode: normalized.code,
        outcome: "operational_error",
      });
      throw normalized;
    }
  }
);

export const lookupAuthorizedOrganizationIds = (actor: TAuthorizationActor): Promise<ReadonlyArray<string>> =>
  lookupAuthorizationResourceIds(actor.type, actor.id, "organization", "read");

export const lookupAuthorizedWorkspaceIds = (
  actor: TAuthorizationActor,
  permission: TCurrentListPermission = "read"
): Promise<ReadonlyArray<string>> =>
  lookupAuthorizationResourceIds(actor.type, actor.id, "workspace", permission);
