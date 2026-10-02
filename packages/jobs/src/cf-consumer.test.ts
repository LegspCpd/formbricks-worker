import { beforeEach, describe, expect, test, vi } from "vitest";
import { type CloudflareQueueBatch, consumeQueueBatch } from "./cf-consumer";
import { JOB_NAMES } from "./constants";
import type { JobHandlerOverrides } from "./contracts";
import { UnrecoverableError } from "./errors";

const { mockLoggerDebug, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@formbricks/logger", () => ({
  logger: {
    debug: mockLoggerDebug,
    error: mockLoggerError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const createMessage = (body: unknown, attempts = 1) => {
  const ack = vi.fn();
  const retry = vi.fn();

  return { ack, attempts, body, id: `msg-${String(attempts)}`, retry };
};

const createBatch = (messages: ReturnType<typeof createMessage>[]): CloudflareQueueBatch => ({
  messages,
  queue: "formbricks-jobs",
});

const responsePipelineData = {
  event: "responseCreated" as const,
  response: {
    contact: null,
    contactAttributes: null,
    createdAt: "2026-04-07T10:00:00.000Z",
    data: {},
    displayId: null,
    endingId: null,
    finished: false,
    id: "cm8cmpnjj000108jfdr9dfqe6",
    language: null,
    meta: {},
    singleUseId: null,
    surveyId: "cm8cmpnjj000108jfdr9dfqe7",
    tags: [],
    updatedAt: "2026-04-07T10:00:00.000Z",
    variables: {},
  },
  surveyId: "cm8cmpnjj000108jfdr9dfqe7",
  workspaceId: "cm8cmpnjj000108jfdr9dfqe8",
};

describe("consumeQueueBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("dispatches a known job through the handler override and acks it", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const overrides: JobHandlerOverrides = { [JOB_NAMES.responsePipeline]: handler };
    const message = createMessage({
      data: responsePipelineData,
      jobId: "cf-job-1",
      jobName: JOB_NAMES.responsePipeline,
    });

    await consumeQueueBatch(createBatch([message]), overrides);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ surveyId: "cm8cmpnjj000108jfdr9dfqe7" }),
      expect.objectContaining({ jobId: "cf-job-1", jobName: JOB_NAMES.responsePipeline })
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("parses a JSON-string body", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const message = createMessage(
      JSON.stringify({ data: responsePipelineData, jobId: "cf-job-2", jobName: JOB_NAMES.responsePipeline })
    );

    await consumeQueueBatch(createBatch([message]), { [JOB_NAMES.responsePipeline]: handler });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  test("acks an unparseable body instead of retrying it forever", async () => {
    const message = createMessage("not-json");

    await consumeQueueBatch(createBatch([message]), {});

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: "formbricks-jobs" }),
      "Dropping unparseable job message"
    );
  });

  test("retries a retryable failure", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const message = createMessage({
      data: responsePipelineData,
      jobId: "cf-job-3",
      jobName: JOB_NAMES.responsePipeline,
    });

    await consumeQueueBatch(createBatch([message]), { [JOB_NAMES.responsePipeline]: handler });

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  // An explicit permanent failure must not consume the queue's retry budget.
  test("acks an UnrecoverableError instead of retrying it", async () => {
    const handler = vi.fn().mockRejectedValue(new UnrecoverableError("survey deleted"));
    const message = createMessage({
      data: responsePipelineData,
      jobId: "cf-job-4",
      jobName: JOB_NAMES.responsePipeline,
    });

    await consumeQueueBatch(createBatch([message]), { [JOB_NAMES.responsePipeline]: handler });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: JOB_NAMES.responsePipeline }),
      "Permanent job failure; acknowledging without retry"
    );
  });

  // Cloudflare re-delivers the whole batch on a throw, so one failure must not prevent its batch-mates
  // from being acked.
  test("keeps processing the rest of the batch after one message fails", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(undefined);
    const failing = createMessage({
      data: responsePipelineData,
      jobId: "cf-fail",
      jobName: JOB_NAMES.responsePipeline,
    });
    const succeeding = createMessage({
      data: responsePipelineData,
      jobId: "cf-ok",
      jobName: JOB_NAMES.responsePipeline,
    });

    await consumeQueueBatch(createBatch([failing, succeeding]), {
      [JOB_NAMES.responsePipeline]: handler,
    });

    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(succeeding.ack).toHaveBeenCalledTimes(1);
  });

  // ENG-2235: an unknown name is dropped with a warning, not retried forever.
  test("drops an unknown job name without retrying", async () => {
    const message = createMessage({ data: { some: "payload" }, jobId: "cf-unknown", jobName: "unknown.job" });

    await consumeQueueBatch(createBatch([message]), {});

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });
});
