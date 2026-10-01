import "server-only";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { Prisma } from "@formbricks/database/prisma";
import { ZString } from "@formbricks/types/common";
import {
  AuthenticationError,
  DatabaseError,
  OperationNotAllowedError,
  UnknownError,
} from "@formbricks/types/errors";
import {
  TIntegrationGoogleSheets,
  ZIntegrationGoogleSheets,
} from "@formbricks/types/integration/google-sheet";
import {
  GOOGLE_SHEETS_CLIENT_ID,
  GOOGLE_SHEETS_CLIENT_SECRET,
  GOOGLE_SHEETS_REDIRECT_URL,
  GOOGLE_SHEET_MESSAGE_LIMIT,
} from "@/lib/constants";
import {
  GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_PERMISSION,
  GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_SCOPES,
  GOOGLE_SHEET_INTEGRATION_INVALID_GRANT,
} from "@/lib/googleSheet/constants";
import { createOrUpdateIntegration } from "@/lib/integration/service";
import { truncateText } from "../utils/strings";
import { validateInputs } from "../utils/validate";

const SHEETS_API_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Extracts Google's human-readable error message from a failed Sheets API response so the same error
 * taxonomy (scope vs. permission vs. everything else) can be applied to it. Falls back to the HTTP
 * status line when the body is not the expected JSON envelope.
 */
const readGoogleErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body?.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Not a JSON error envelope — fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
};

const getAccessTokenOrThrow = async (authClient: OAuth2Client): Promise<string> => {
  const { token } = await authClient.getAccessToken();
  if (!token) {
    throw new AuthenticationError(GOOGLE_SHEET_INTEGRATION_INVALID_GRANT);
  }
  return token;
};

/**
 * ENG-2250: the write must reject the promise the caller awaits. The previous implementation bridged
 * googleapis' node-style callback into a promise for exactly this reason — a `throw` raised inside the
 * callback escaped `writeData`'s own `try/catch`, so the pipeline recorded a success while the sheet
 * silently stopped receiving responses. Fetch keeps the failure on the awaited path.
 */
const sendSheetsWrite = async (
  authClient: OAuth2Client,
  url: string,
  init: { method: "PUT" | "POST"; body: unknown }
): Promise<void> => {
  const accessToken = await getAccessTokenOrThrow(authClient);
  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(init.body),
  });

  if (!response.ok) {
    throw new UnknownError(`Error while appending data: ${await readGoogleErrorMessage(response)}`);
  }
};

export const writeData = async (
  integrationData: TIntegrationGoogleSheets,
  spreadsheetId: string,
  responses: string[],
  elements: string[]
) => {
  validateInputs(
    [integrationData, ZIntegrationGoogleSheets],
    [spreadsheetId, ZString],
    [responses, z.array(ZString)],
    [elements, z.array(ZString)]
  );

  try {
    const authClient = await authorize(integrationData);
    const responsesMapped = {
      values: [
        responses.map((response) =>
          response.length > GOOGLE_SHEET_MESSAGE_LIMIT
            ? truncateText(response, GOOGLE_SHEET_MESSAGE_LIMIT)
            : response
        ),
      ],
    };

    const element = { values: [elements] };

    await sendSheetsWrite(
      authClient,
      `${SHEETS_API_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/A1?valueInputOption=RAW`,
      { method: "PUT", body: element }
    );

    await sendSheetsWrite(
      authClient,
      `${SHEETS_API_BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/A2:append?valueInputOption=RAW`,
      { method: "POST", body: responsesMapped }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }
    throw error;
  }
};

export const validateGoogleSheetsConnection = async (
  googleSheetIntegrationData: TIntegrationGoogleSheets
): Promise<void> => {
  validateInputs([googleSheetIntegrationData, ZIntegrationGoogleSheets]);
  const integrationData = structuredClone(googleSheetIntegrationData);
  integrationData.config.data.forEach((data) => {
    data.createdAt = new Date(data.createdAt);
  });
  await authorize(integrationData);
};

export const getSpreadsheetNameById = async (
  googleSheetIntegrationData: TIntegrationGoogleSheets,
  spreadsheetId: string
): Promise<string> => {
  validateInputs([googleSheetIntegrationData, ZIntegrationGoogleSheets]);

  try {
    const authClient = await authorize(googleSheetIntegrationData);
    const accessToken = await getAccessTokenOrThrow(authClient);

    const response = await fetch(
      `${SHEETS_API_BASE_URL}/${encodeURIComponent(spreadsheetId)}?fields=properties.title`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      const message = await readGoogleErrorMessage(response);
      const msg = message.toLowerCase();
      // The stored grant lacks the Sheets scope (e.g. the box was unticked on Google's consent
      // screen). Google phrases this without the word "permission", and the way out is to
      // reconnect, not to share the spreadsheet, so it gets its own code.
      const isScopeError = msg.includes("insufficient authentication scopes");
      const isPermissionError =
        msg.includes("permission") ||
        msg.includes("caller does not have") ||
        msg.includes("insufficient permission") ||
        msg.includes("access denied");
      if (isScopeError) {
        throw new OperationNotAllowedError(GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_SCOPES);
      }
      if (isPermissionError) {
        throw new OperationNotAllowedError(GOOGLE_SHEET_INTEGRATION_INSUFFICIENT_PERMISSION);
      }
      throw new UnknownError(`Error while fetching spreadsheet data: ${message}`);
    }

    const data = (await response.json()) as { properties?: { title?: string | null } | null };
    const spreadsheetTitle = data.properties?.title;
    if (!spreadsheetTitle) {
      throw new UnknownError("Error while fetching spreadsheet data: no title on the response");
    }
    return spreadsheetTitle;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }
    throw error;
  }
};

const isInvalidGrantError = (error: unknown): boolean => {
  const err = error as { message?: string; response?: { data?: { error?: string } } };
  return (
    typeof err?.message === "string" &&
    err.message.toLowerCase().includes(GOOGLE_SHEET_INTEGRATION_INVALID_GRANT)
  );
};

/** Buffer in ms before expiry_date to consider token near-expired (5 minutes). */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const GOOGLE_TOKENINFO_URL = "https://www.googleapis.com/oauth2/v1/tokeninfo";

/**
 * Verifies that the access token is still valid and not revoked (e.g. user removed app access).
 * Returns true if token is valid, false if invalid/revoked.
 */
const isAccessTokenValid = async (accessToken: string): Promise<boolean> => {
  try {
    const res = await fetch(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
    return res.ok;
  } catch {
    return false;
  }
};

const authorize = async (googleSheetIntegrationData: TIntegrationGoogleSheets): Promise<OAuth2Client> => {
  const client_id = GOOGLE_SHEETS_CLIENT_ID;
  const client_secret = GOOGLE_SHEETS_CLIENT_SECRET;
  const redirect_uri = GOOGLE_SHEETS_REDIRECT_URL;
  const oAuth2Client = new OAuth2Client({
    clientId: client_id,
    clientSecret: client_secret,
    redirectUri: redirect_uri,
  });
  const key = googleSheetIntegrationData.config.key;

  const hasStoredCredentials =
    key.access_token && key.expiry_date && key.expiry_date > Date.now() + TOKEN_EXPIRY_BUFFER_MS;

  if (hasStoredCredentials && (await isAccessTokenValid(key.access_token))) {
    oAuth2Client.setCredentials(key);
    return oAuth2Client;
  }

  // Without a refresh token there is nothing to refresh, and the client surfaces that as a bare
  // "No refresh token is set." which reaches the user as a raw toast. Treat it as the reconnect case
  // instead, which is the only way out of it. `ZGoogleCredential` types both tokens as `z.string()`,
  // so an empty string is schema-valid and has to be checked for here.
  if (!key.refresh_token) {
    throw new AuthenticationError(GOOGLE_SHEET_INTEGRATION_INVALID_GRANT);
  }

  oAuth2Client.setCredentials({ refresh_token: key.refresh_token });

  try {
    const { credentials } = await oAuth2Client.refreshAccessToken();
    const mergedCredentials = {
      scope: credentials.scope ?? key.scope,
      token_type: "Bearer" as const,
      expiry_date: credentials.expiry_date ?? key.expiry_date,
      access_token: credentials.access_token ?? key.access_token,
      refresh_token: credentials.refresh_token ?? key.refresh_token,
    };
    await createOrUpdateIntegration(googleSheetIntegrationData.workspaceId, {
      type: "googleSheets",
      config: {
        data: googleSheetIntegrationData.config?.data ?? [],
        email: googleSheetIntegrationData.config?.email ?? "",
        key: mergedCredentials,
      },
    });

    oAuth2Client.setCredentials(mergedCredentials);
    return oAuth2Client;
  } catch (error) {
    if (isInvalidGrantError(error)) {
      throw new AuthenticationError(GOOGLE_SHEET_INTEGRATION_INVALID_GRANT);
    }
    throw error;
  }
};
