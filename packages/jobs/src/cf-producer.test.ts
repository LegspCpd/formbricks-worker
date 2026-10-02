import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CloudflareQueueBinding,
  createCloudflareJobProducer,
  enqueueWebhookDeliveryJob,
  enqueueWorkflowRunJob,
  getCloudflareQueueBinding,
  setCloudflareQueueBinding,
} from "./cf-producer";
import { JOB_NAMES } from "./constants";

const responsePipelineData = {
  event: "responseCreated" as const,
  response: {
    contact: null,
    contactAttributes: null,
    createdAt: new Date("2026-04-07T10:00:00.000Z"),
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
    updatedAt: new Date("2026-04-07T10:00:00.000Z"),
    variables: {},
  },
  surveyId: "cm8cmpnjj000108jfdr9dfqe7",
  workspaceId: "cm8cmpnjj000108jfdr9dfqe8",
};

const webhookDeliveryData = {
  event: "responseFinished" as const,
  response: responsePipelineData.response,
  survey: {
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    name: "Survey",
    status: "inProgress" as const,
    type: "link" as const,
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
  },
  surveyId: responsePipelineData.surveyId,
  webhookId: "cm8cmpnjj000108jfdr9whk01",
  webhookMessageId: "a".repeat(64),
  workspaceId: responsePipelineData.workspaceId,
};

const workflowRunData = {
  workflowId: "cm8cmpnjj000108jfdr9wflo1",
  workflowRunId: "cm8cmpnjj000108jfdr9wrun1",
  workspaceId: "cm8cmpnjj000108jfdr9wksp1",
};

afterEach(() => {
  setCloudflareQueueBinding(undefined);
});

describe("Cloudflare jobs producer", () => {
  test("throws when no queue binding is configured", async () => {
    const producer = createCloudflareJobProducer();

    await expect(producer.enqueueResponsePipeline(responsePipelineData)).rejects.toThrow(
      "Cloudflare JOBS_QUEUE binding is not configured"
    );
  });

  test("sends the response pipeline job with its name and a deterministic id", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCloudflareQueueBinding({ send });

    const producer = createCloudflareJobProducer();
    const result = await producer.enqueueResponsePipeline(responsePipelineData);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: JOB_NAMES.responsePipeline, data: responsePipelineData })
    );
    expect(result.jobName).toBe(JOB_NAMES.responsePipeline);
    expect(result.jobId).toContain(JOB_NAMES.responsePipeline);
  });

  test("uses the caller's deterministic jobId for webhook deliveries", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCloudflareQueueBinding({ send });

    const result = await enqueueWebhookDeliveryJob(webhookDeliveryData, { jobId: "whd-123" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobName: JOB_NAMES.webhookDelivery }));
    expect(result.jobId).toBe("whd-123");
  });

  test("mirrors the run id as the workflow run jobId", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCloudflareQueueBinding({ send });

    const result = await enqueueWorkflowRunJob(workflowRunData, { jobId: workflowRunData.workflowRunId });

    expect(result.jobId).toBe(workflowRunData.workflowRunId);
    expect(result.jobName).toBe(JOB_NAMES.workflowRun);
  });

  test("validates the payload before sending", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCloudflareQueueBinding({ send });

    await expect(
      enqueueWebhookDeliveryJob({ ...webhookDeliveryData, webhookMessageId: "not-a-sha256" }, { jobId: "x" })
    ).rejects.toThrow();

    expect(send).not.toHaveBeenCalled();
  });

  test("exposes the injected binding for engine detection", () => {
    expect(getCloudflareQueueBinding()).toBeUndefined();

    const binding: CloudflareQueueBinding = { send: vi.fn() };
    setCloudflareQueueBinding(binding);

    expect(getCloudflareQueueBinding()).toBe(binding);
  });
});
