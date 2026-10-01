import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthenticationError, OperationNotAllowedError, UnknownError } from "@formbricks/types/errors";
import { TIntegrationGoogleSheets } from "@formbricks/types/integration/google-sheet";
import {
  GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_PERMISSION,
  GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_SCOPES,
  GOOGLE_SHEET_INTEGRATION_INVALID_GRANT,
} from "@/lib/googleSheet/constants";

vi.mock("@/lib/integration/service", () => ({ createOrUpdateIntegration: vi.fn() }));

vi.mock("@/lib/constants", () => ({
  GOOGLE_SHEETS_CLIENT_ID: "client-id",
  GOOGLE_SHEETS_CLIENT_SECRET: "client-secret",
  GOOGLE_SHEETS_REDIRECT_URL: "https://example.com/callback",
  GOOGLE_SHEET_MESSAGE_LIMIT: 50000,
}));

// The service drives Google through `google-auth-library` for the token and plain `fetch` for the
// Sheets REST calls — the old `googleapis` client (~190 MB of sources) is gone, and googleapis' huge
// bundle was what pushed the Worker over the size limit. Both surfaces are mocked here.
const oauthClientMock = vi.hoisted(() => ({
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    setCredentials = oauthClientMock.setCredentials;
    getAccessToken = oauthClientMock.getAccessToken;
    refreshAccessToken = oauthClientMock.refreshAccessToken;
  },
}));

const { getSpreadsheetNameById, writeData } = await import("@/lib/googleSheet/service");

const TOKENINFO_URL = "https://www.googleapis.com/oauth2/v1/tokeninfo";

const jsonResponse = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body,
  }) as Response;

/**
 * Routes the three ways the service reaches Google: the tokeninfo validity check `authorize` runs for
 * a still-current stored token, the spreadsheet metadata GET, and the two write calls. `write`
 * receives the HTTP method so a test can make the header `PUT` and the append `POST` disagree.
 */
const stubGoogleFetch = (
  handlers: { spreadsheet?: () => Response; write?: (method: string) => Response } = {}
) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(TOKENINFO_URL)) {
      return jsonResponse({});
    }
    const method = init?.method ?? "GET";
    if (method === "PUT" || method === "POST") {
      return handlers.write?.(method) ?? jsonResponse({});
    }
    return handlers.spreadsheet?.() ?? jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/**
 * The shape the integration has once ENG-2078's redaction has blanked `config.key`: schema-valid,
 * because `ZGoogleCredential` types both tokens as `z.string()`, but unusable for auth.
 */
const redactedIntegration = {
  id: "integration1",
  type: "googleSheets",
  workspaceId: "ws1",
  config: {
    email: "owner@example.com",
    data: [],
    key: {
      scope: "https://www.googleapis.com/auth/spreadsheets",
      token_type: "Bearer",
      expiry_date: 0,
      access_token: "",
      refresh_token: "",
    },
  },
} as TIntegrationGoogleSheets;

/** An integration whose stored access token is still valid, so `authorize` never has to refresh. */
const authorizedIntegration = {
  id: "integration1",
  type: "googleSheets",
  workspaceId: "ws1",
  config: {
    email: "owner@example.com",
    data: [],
    key: {
      scope: "https://www.googleapis.com/auth/spreadsheets",
      token_type: "Bearer",
      expiry_date: Date.now() + 60 * 60 * 1000,
      access_token: "access-token",
      refresh_token: "refresh-token",
    },
  },
} as TIntegrationGoogleSheets;

// ENG-2303: a blank refresh token reached the Google client, which surfaced it as a bare "No refresh
// token is set." straight into a user-facing toast. It has to fail as the reconnect case instead,
// which the modal maps to a real message. Nothing here touches the network: the guard short-circuits
// before any Google call, which is also what keeps this test hermetic.
describe("getSpreadsheetNameById", () => {
  beforeEach(() => {
    oauthClientMock.setCredentials.mockReset();
    oauthClientMock.getAccessToken.mockReset().mockResolvedValue({ token: "access-token" });
    oauthClientMock.refreshAccessToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("throws an invalid_grant AuthenticationError when the stored refresh token is blank", async () => {
    stubGoogleFetch();

    await expect(getSpreadsheetNameById(redactedIntegration, "sheet1")).rejects.toThrow(
      new AuthenticationError(GOOGLE_SHEET_INTEGRATION_INVALID_GRANT)
    );
  });

  // ENG-2807: Google's scope rejection never says "permission", so it slipped past the permission guard
  // and reached the user as a raw English Google string. It needs its own code, because the fix is to
  // reconnect and grant the Sheets scope, not to share the spreadsheet.
  describe("when Google rejects the spreadsheet fetch", () => {
    const rejectWith = (message: string) =>
      stubGoogleFetch({ spreadsheet: () => jsonResponse({ error: { message } }, false) });

    test("maps a missing OAuth scope to the insufficient_scopes code", async () => {
      rejectWith("Request had insufficient authentication scopes.");

      await expect(getSpreadsheetNameById(authorizedIntegration, "sheet1")).rejects.toThrow(
        new OperationNotAllowedError(GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_SCOPES)
      );
    });

    test("keeps mapping a sharing problem to the insufficient_permission code", async () => {
      rejectWith("The caller does not have permission");

      await expect(getSpreadsheetNameById(authorizedIntegration, "sheet1")).rejects.toThrow(
        new OperationNotAllowedError(GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_PERMISSION)
      );
    });

    test("wraps any other Google error in an UnknownError", async () => {
      rejectWith("Requested entity was not found.");

      await expect(getSpreadsheetNameById(authorizedIntegration, "sheet1")).rejects.toThrow(UnknownError);
    });
  });
});

// ENG-2250: both writes used to `throw` from inside the node-style googleapis callback, so the error
// escaped `writeData`'s own `try/catch` and surfaced as an unhandled rejection while `writeData` itself
// resolved — the pipeline recorded a success and the customer's sheet quietly stopped filling up. The
// fetch rewrite keeps the failure on the awaited path; these tests pin that it stays there.
describe("writeData", () => {
  beforeEach(() => {
    oauthClientMock.setCredentials.mockReset();
    oauthClientMock.getAccessToken.mockReset().mockResolvedValue({ token: "access-token" });
    oauthClientMock.refreshAccessToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("rejects with an UnknownError when the append call reports an error", async () => {
    stubGoogleFetch({
      write: (method) =>
        method === "POST"
          ? jsonResponse({ error: { message: "The caller does not have permission" } }, false)
          : jsonResponse({}),
    });

    await expect(writeData(authorizedIntegration, "sheet1", ["answer"], ["question"])).rejects.toThrow(
      new UnknownError("Error while appending data: The caller does not have permission")
    );
  });

  test("rejects with an UnknownError when the header update call reports an error", async () => {
    const fetchMock = stubGoogleFetch({
      write: () => jsonResponse({ error: { message: "Requested entity was not found" } }, false),
    });

    await expect(writeData(authorizedIntegration, "sheet1", ["answer"], ["question"])).rejects.toThrow(
      new UnknownError("Error while appending data: Requested entity was not found")
    );

    const writeCalls = fetchMock.mock.calls.filter(([, init]) => {
      const method = (init as RequestInit | undefined)?.method;
      return method === "PUT" || method === "POST";
    });
    expect(writeCalls).toHaveLength(1);
    expect((writeCalls[0][1] as RequestInit).method).toBe("PUT");
  });

  test("resolves only after both writes have completed", async () => {
    const completed: string[] = [];
    stubGoogleFetch({
      write: (method) => {
        completed.push(method === "PUT" ? "update" : "append");
        return jsonResponse({});
      },
    });

    await writeData(authorizedIntegration, "sheet1", ["answer"], ["question"]);

    expect(completed).toEqual(["update", "append"]);
  });
});
