import path from "node:path"
import { z } from "zod"
import { identityConfig } from "./identity-config.mjs"

const integer = (fallback, min, max) =>
  z.coerce.number().int().min(min).max(max).default(fallback)
export function loadConfig(env = process.env) {
  const result = z
    .object({
      VAULT_PASSWORD: z.string().min(12).max(256),
      VAULT_ORIGIN: z.string().url().default("http://localhost:4310"),
      VAULT_HOST: z.string().default("127.0.0.1"),
      VAULT_PORT: integer(4310, 1024, 65535),
      VAULT_DATA_DIR: z.string().min(1).default("./data"),
      VAULT_IMPORT_MB: integer(8, 1, 64),
      VAULT_MAX_PAGE_SIZE: integer(48, 12, 100),
      VAULT_MAX_SELECTION: integer(50, 1, 100),
      VAULT_PREVIEW_TIMEOUT_MS: integer(15000, 1000, 60000),
      VAULT_PREVIEW_CONCURRENCY: integer(2, 1, 4),
      VAULT_PREVIEW_CACHE_SIZE: integer(24, 1, 64),
      VAULT_PREVIEW_CACHE_MB: integer(16, 1, 64),
      VAULT_PREVIEW_CACHE_TTL_SECONDS: integer(300, 30, 3600),
      VAULT_FETCH_TIMEOUT_MS: integer(10000, 1000, 30000),
      VAULT_SEED_EXAMPLES: z.enum(["true", "false"]).default("false"),
    })
    .safeParse(env)
  if (!result.success)
    throw new Error(
      `配置错误 ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`,
    )
  const v = result.data
  const origin = new URL(v.VAULT_ORIGIN)
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== v.VAULT_ORIGIN
  )
    throw new Error("VAULT_ORIGIN 必须为不带路径和末尾斜杠的 HTTP(S) 来源")
  return {
    ...identityConfig(env, origin.origin),
    password: v.VAULT_PASSWORD,
    origin: origin.origin,
    secureCookie: origin.protocol === "https:",
    host: v.VAULT_HOST,
    port: v.VAULT_PORT,
    dataDir: path.resolve(v.VAULT_DATA_DIR),
    maxBytes: v.VAULT_IMPORT_MB * 1024 * 1024,
    maxPageSize: v.VAULT_MAX_PAGE_SIZE,
    maxSelection: v.VAULT_MAX_SELECTION,
    previewTimeout: v.VAULT_PREVIEW_TIMEOUT_MS,
    previewConcurrency: v.VAULT_PREVIEW_CONCURRENCY,
    previewCacheSize: v.VAULT_PREVIEW_CACHE_SIZE,
    previewCacheBytes: v.VAULT_PREVIEW_CACHE_MB * 1024 * 1024,
    previewCacheTtl: v.VAULT_PREVIEW_CACHE_TTL_SECONDS * 1000,
    fetchTimeout: v.VAULT_FETCH_TIMEOUT_MS,
    seed: v.VAULT_SEED_EXAMPLES === "true",
  }
}
