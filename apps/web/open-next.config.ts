import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  caching: {
    tagCacheKV: "tag-cache",
    memoryCacheKV: "memory-cache",
  },
});
