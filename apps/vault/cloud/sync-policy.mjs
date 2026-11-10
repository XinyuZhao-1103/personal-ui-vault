import { z } from "zod"
import manifest from "../catalog/sync-policy.json" with { type: "json" }
import { safePath, componentSchema } from "../server/model.mjs"

const reviewSchema = z.object({
  name: z.string().min(1).max(100),
  category: componentSchema.shape.category,
  reason: z.string().min(10).max(1000),
  demo: z.string().min(20).max(200000),
  css: z.string().max(20000).default(""),
})
const sourceSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  directory: safePath,
  prefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
  licensePath: safePath,
  licenseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
  reviews: z.record(z.string().regex(/^[a-z0-9-]+\.tsx$/), reviewSchema),
})

export const syncPolicy = z.object({
  sources: z.array(sourceSchema).min(1).max(10),
}).superRefine(({ sources }, context) => {
  if (new Set(sources.map(source => source.repository)).size !== sources.length)
    context.addIssue({ code: "custom", message: "同步来源仓库重复" })
}).parse(manifest)

export const syncRepositories = syncPolicy.sources.map(source => source.repository)

export function reviewedComponent(repository, sourcePath) {
  const source = syncPolicy.sources.find(source => source.enabled && source.repository === repository)
  if (!source || !sourcePath.startsWith(source.directory + "/")) return null
  return source.reviews[sourcePath.slice(source.directory.length + 1)] || null
}
