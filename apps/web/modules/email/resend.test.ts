import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `sendEmail`'s Resend branch.
 *
 * Resend exists here for the runtimes that cannot dial an SMTP server — a Cloudflare Worker has no
 * outbound socket — so a deployment can be fully configured and still send nothing if this branch is
 * broken. Two things are pinned: that a Resend deployment never touches the SMTP transport, and that
 * a rejection from the API is raised rather than reported as a successful send (callers treat `false`
 * and a throw differently, see ENG-2091).
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  sendMail: vi.fn(async () => ({ messageId: "smtp-1" })),
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  IS_RESEND_CONFIGURED: true,
  IS_EMAIL_CONFIGURED: true,
  IS_SMTP_CONFIGURED: false,
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_key",
  MAIL_FROM: "noreply@example.com",
  MAIL_FROM_NAME: "Formbricks",
}));
vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: mocks.sendMail, verify: vi.fn(async () => true), close: vi.fn() }),
}));
vi.mock("@/lib/jwt", () => ({
  createToken: vi.fn(),
  createEmailToken: vi.fn(),
  createInviteToken: vi.fn(),
  createTokenForLinkSurvey: vi.fn(),
  createEmailChangeToken: vi.fn(),
}));
vi.mock("@/lingodotdev/server", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@/lib/organization/service", () => ({ getOrganizationByWorkspaceId: vi.fn() }));

vi.stubGlobal("fetch", mocks.fetch);

const { sendEmail } = await import("./index");

describe("sendEmail over Resend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
  });

  test("posts to the Resend API with the configured key and never builds an SMTP transport", async () => {
    const sent = await sendEmail({
      to: "someone@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      replyTo: "reply@example.com",
      messageId: "<abc@example.com>",
    });

    expect(sent).toBe(true);
    expect(mocks.sendMail).not.toHaveBeenCalled();

    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      from: "Formbricks <noreply@example.com>",
      to: "someone@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      reply_to: "reply@example.com",
      headers: { "Message-ID": "<abc@example.com>" },
    });
  });

  test("omits the optional fields rather than sending them empty", async () => {
    await sendEmail({ to: "someone@example.com", subject: "Hello", html: "<p>hi</p>" });

    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
      from: "Formbricks <noreply@example.com>",
      to: "someone@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });
  });

  test("raises a rejected send instead of reporting success", async () => {
    mocks.fetch.mockResolvedValue(new Response("domain not verified", { status: 403 }));

    await expect(
      sendEmail({ to: "someone@example.com", subject: "Hello", html: "<p>hi</p>" })
    ).rejects.toThrow(/Incorrect Resend credentials/);
  });
});
