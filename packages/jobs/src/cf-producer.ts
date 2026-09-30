import { logger } from "@formbricks/logger";
import type { BackgroundJobProducer, EnqueuedJob, JobExecutionContext } from "./contracts";
import { getBackgroundJobDefinition } from "./definitions";
import type { TResponsePipelineJobData } from "./types";

const createJobContext = (jobName: string): JobExecutionContext => ({
  attempt: 1,
  jobId: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  jobName,
  maxAttempts: 1,
  queueName: "formbricks-jobs",
});

const runJob = async <TData>(jobName: string, data: TData): Promise<EnqueuedJob> => {
  const definition = getBackgroundJobDefinition(jobName);
  if (!definition) {
    throw new Error(`Unknown job: ${jobName}`);
  }

  const context = createJobContext(jobName);

  try {
    await definition.handle(data, context);
  } catch (error) {
    logger.error({ error, jobName, jobId: context.jobId }, "Job execution failed");
    throw error;
  }

  return {
    jobId: context.jobId,
    jobName,
    queueName: context.queueName,
  };
};

export const cfJobProducer: BackgroundJobProducer = {
  enqueueResponsePipeline: async (data: TResponsePipelineJobData): Promise<EnqueuedJob> => {
    return runJob("response-pipeline", data);
  },
};
