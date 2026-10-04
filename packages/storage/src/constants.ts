export const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
export const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
export const S3_REGION = process.env.S3_REGION;
export const S3_ENDPOINT_URL = process.env.S3_ENDPOINT_URL;
export const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === "1";
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const isR2Endpoint = S3_ENDPOINT_URL?.includes(".r2.cloudflarestorage.com") ?? false;

export const S3_UPLOAD_METHOD: "PUT" | "POST" =
  process.env.S3_FORCE_PUT_UPLOAD === "1" || isR2Endpoint ? "PUT" : "POST";
