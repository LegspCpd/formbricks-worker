export {
  deleteFile,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  deleteFilesByPrefix,
  getFileStream,
} from "./service";
export type { FileStreamResult } from "./service";
export { StorageErrorCode } from "./types/error";
export type { StorageError } from "./types/error";

// R2 service for Cloudflare Workers
export {
  getSignedUploadUrl as getR2SignedUploadUrl,
  getSignedDownloadUrl as getR2SignedDownloadUrl,
  deleteFile as deleteR2File,
  deleteFilesByPrefix as deleteR2FilesByPrefix,
  getFileStream as getR2FileStream,
  setR2Bucket,
} from "./r2-service";
