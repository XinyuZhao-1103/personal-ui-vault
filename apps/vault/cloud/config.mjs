import { z } from "zod"

export function cloudConfig(env) {
  const integer = (value, min, max) => z.coerce.number().int().min(min).max(max).default(value)
  const values = z.object({
    VAULT_IMPORT_BYTES: integer(1048576, 65536, 1048576),
    VAULT_MAX_PAGE_SIZE: integer(48, 12, 100),
    VAULT_MAX_SELECTION: integer(50, 1, 100),
    VAULT_FETCH_TIMEOUT_MS: integer(10000, 1000, 30000),
    VAULT_REGISTRY_HOSTS: z.string().default("ui.shadcn.com,magicui.design,motion-primitives.com,raw.githubusercontent.com"),
    VAULT_SYNC_BATCH_SIZE: integer(5, 1, 10),
    VAULT_LOCAL_DEV: z.enum(["true", "false"]).default("false"),
  }).parse(env)
  return {
    maxBytes: values.VAULT_IMPORT_BYTES,
    maxPageSize: values.VAULT_MAX_PAGE_SIZE,
    maxSelection: values.VAULT_MAX_SELECTION,
    fetchTimeout: values.VAULT_FETCH_TIMEOUT_MS,
    registryHosts: values.VAULT_REGISTRY_HOSTS.split(",").map(value => value.trim()).filter(Boolean),
    syncBatchSize: values.VAULT_SYNC_BATCH_SIZE,
    localDev: values.VAULT_LOCAL_DEV === "true",
  }
}
