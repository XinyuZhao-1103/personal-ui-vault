import path from "node:path"
import { Buffer } from "node:buffer"
import { z } from "zod"

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
export const safePath = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    return (
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every((p) => p && p !== "." && p !== ".." && !p.startsWith("."))
    )
  }, "文件路径必须为安全的相对路径，不能含隐藏目录或上级目录")
const fileSchema = z.object({
  path: safePath,
  content: z.string().max(2 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
})
const dependencySchema = z.record(
  z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
  z
    .string()
    .max(80)
    .regex(/^[a-zA-Z0-9.*^~<>=| +\-]+$/, "依赖仅允许 npm 版本号或版本范围"),
)
export const componentSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100),
    description: z.string().max(2000).default(""),
    category: z
      .enum(["按钮", "表格", "分页", "表单", "导航", "卡片", "反馈", "其他"])
      .default("其他"),
    framework: z.enum(["react", "html"]).default("react"),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    source: z.string().max(1000).default(""),
    license: z.string().max(4000).default("待核对"),
    files: z.array(fileSchema).min(1).max(100),
    entry: safePath,
    demo: z.string().max(200000).default(""),
    dependencies: dependencySchema.default({}),
  })
  .superRefine((value, ctx) => {
    const paths = value.files.map((f) => f.path)
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: "custom", path: ["files"], message: "文件路径重复" })
    if (!paths.includes(value.entry))
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "入口文件不存在",
      })
    if (value.framework === "html" && !value.entry.endsWith(".html"))
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "HTML 组件入口必须为 .html",
      })
    if (value.framework === "react" && !/\.[jt]sx?$/.test(value.entry))
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "React 组件入口必须为 JS/TS 文件",
      })
  })
export function validateComponent(input, maxBytes) {
  const parsed = componentSchema.safeParse(input)
  if (!parsed.success)
    throw new AppError(
      parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("；"),
    )
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > maxBytes)
    throw new AppError("组件超过导入大小上限", 413)
  return parsed.data
}
export function resolveFile(files, request, importer = "") {
  const base = request.startsWith("@/")
    ? request.slice(2)
    : path.posix.join(path.posix.dirname(importer), request)
  const candidates = [
    base,
    ...[
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".css",
      ".json",
      "/index.tsx",
      "/index.ts",
      "/index.jsx",
      "/index.js",
    ].map((ext) => base + ext),
  ]
  return candidates.find((p) => Object.hasOwn(files, p))
}
