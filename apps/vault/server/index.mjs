import express from "express"
import { randomBytes, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createIdentity } from "./identity.mjs"
import { identityDatabase } from "./identity-db.mjs"
import { authorizeVault } from "./access.mjs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { z } from "zod"
import { loadConfig } from "./config.mjs"
import { openStore } from "./store.mjs"
import { AppError, validateComponent } from "./model.mjs"
import { analyze, readRegistry } from "./importer.mjs"
import { makePreview } from "./preview.mjs"
import { planExport, promptFor } from "./exporter.mjs"
import { examples } from "./examples.mjs"
import { archiveTask } from "./tasks.mjs"

const config = loadConfig()
const store = openStore(config.dataDir)
const app = express()
const hash = (value) => createHash("sha256").update(value).digest("hex")
store.db.exec("CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)")
store.db.exec(readFileSync(new URL("../drizzle/0001_identity.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""))
const identity = createIdentity({ db: identityDatabase(store.db), config })
await identity.ensureBootstrap()
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
app.disable("x-powered-by")
app.use((req, res, next) => {
  req.requestId = randomBytes(8).toString("hex")
  res.set({
    "X-Request-Id": req.requestId,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  })
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.headers.origin !== config.origin
  )
    return res.status(403).json({
      error: "请求来源不匹配，请检查 VAULT_ORIGIN",
      requestId: req.requestId,
    })
  next()
})
app.use(
  "/api/import/zip",
  express.raw({ type: "application/zip", limit: config.maxBytes }),
)
app.use(express.json({ limit: config.maxBytes }))
app.get("/api/health", (_req, res) => {
  store.db.prepare("SELECT 1").get()
  res.json({ status: "ok", version: "0.1.0" })
})
// 认证核心只接收套接字地址，忽略客户端伪造的转发头。
app.use(asyncRoute(async (req, res, next) => {
  if (!req.path.startsWith("/api/")) return next()
  const headers = new Headers()
  for (const name of ["cookie", "origin", "content-type"])
    if (req.headers[name]) headers.set(name, String(req.headers[name]))
  headers.set("cf-connecting-ip", req.socket.remoteAddress || "unknown")
  headers.set("user-agent", String(req.headers["user-agent"] || "").slice(0, 500))
  const authPath = req.path === "/api/session" || req.path === "/api/login" || req.path === "/api/logout" || req.path.startsWith("/api/account/") || req.path.startsWith("/api/admin/") || req.path.startsWith("/api/auth/")
  const request = new Request(new URL(req.originalUrl, config.origin), {
    method: req.method,
    headers,
    ...(authPath && !["GET", "HEAD"].includes(req.method) ? { body: JSON.stringify(req.body || {}) } : {}),
  })
  const response = await identity.handle(request)
  if (response) {
    res.status(response.status)
    for (const [name, value] of response.headers) res.setHeader(name, value)
    return res.send(Buffer.from(await response.arrayBuffer()))
  }
  const user = await identity.getSession(request)
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  const readerToken = !!(req.method === "GET" && bearer && store.db.prepare("SELECT id FROM api_tokens WHERE token_hash=?").get(hash(bearer)))
  authorizeVault(user, req.path, req.method, readerToken)
  next()
}))
app.get("/api/components", (req, res) => {
  const query = z
    .object({
      q: z.string().max(200).default(""),
      category: z.string().max(20).default(""),
      framework: z.enum(["", "react", "html"]).default(""),
      page: z.coerce.number().int().min(1).max(1000).default(1),
      size: z.coerce.number().int().min(1).max(config.maxPageSize).default(12),
    })
    .parse(req.query)
  res.json(store.list({ ...query, query: query.q }))
})
app.get("/api/components/:id", (req, res) => {
  const revision = req.query.revision
    ? z.coerce.number().int().min(1).parse(req.query.revision)
    : undefined
  res.json(store.get(req.params.id, revision))
})
app.get("/api/components/:id/versions", (req, res) =>
  res.json(store.versions(req.params.id)),
)
app.post("/api/analyze", (req, res) =>
  res.json(analyze(z.string().max(config.maxBytes).parse(req.body.code))),
)
app.post("/api/components", (req, res) => {
  const doc = validateComponent(req.body, config.maxBytes)
  res.status(201).json(store.createMany([doc])[0])
})
app.put("/api/components/:id", (req, res) => {
  const doc = validateComponent(req.body, config.maxBytes)
  const expected = z.number().int().min(1).parse(req.body.expectedRevision)
  res.json(store.update(req.params.id, doc, expected))
})
app.post(
  "/api/import/zip",
  asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body))
      throw new AppError("请上传 application/zip 格式文件")
    const docs = await archiveTask({ kind: "import", bytes: req.body }, config)
    res.status(201).json({ items: store.createMany(docs) })
  }),
)
let importing = false
app.post(
  "/api/import/registry",
  asyncRoute(async (req, res) => {
    if (importing) throw new AppError("另一个导入任务正在运行，请稍后重试", 429)
    importing = true
    try {
      const input = z
        .object({
          url: z.string().max(2000),
          name: z.string().max(100).optional(),
          slug: z.string().max(100).optional(),
          category: z.string().optional(),
        })
        .parse(req.body)
      const { url, ...meta } = input
      const doc = await readRegistry(url, config, meta)
      res.status(201).json(store.createMany([doc])[0])
    } finally {
      importing = false
    }
  }),
)
app.post("/api/examples", (_req, res) => {
  const docs = examples.filter(
    (doc) =>
      !store.db.prepare("SELECT id FROM components WHERE slug=?").get(doc.slug),
  )
  res.json({
    items: store.createMany(
      docs.map((doc) => validateComponent(doc, config.maxBytes)),
    ),
  })
})
let previews = 0
const previewCache = new Map()
app.post(
  "/api/preview",
  asyncRoute(async (req, res) => {
    const doc = req.body.id
      ? store.get(
          z.string().parse(req.body.id),
          req.body.revision
            ? z.number().int().min(1).parse(req.body.revision)
            : undefined,
        )
      : validateComponent(req.body, config.maxBytes)
    const key = doc.id ? `${doc.id}:${doc.revision}` : ""
    const now = Date.now()
    for (const [cacheKey, value] of previewCache)
      if (now - value.createdAt > config.previewCacheTtl)
        previewCache.delete(cacheKey)
    if (key && previewCache.has(key))
      return res.json({ html: previewCache.get(key).html })
    if (previews >= config.previewConcurrency)
      throw new AppError("预览编译繁忙，请稍后重试", 429)
    previews++
    try {
      const html = await makePreview(doc, config.previewTimeout)
      if (key) {
        const bytes = Buffer.byteLength(html)
        if (bytes <= config.previewCacheBytes) {
          while (
            previewCache.size &&
            (previewCache.size >= config.previewCacheSize ||
              [...previewCache.values()].reduce(
                (sum, value) => sum + value.bytes,
                0,
              ) +
                bytes >
                config.previewCacheBytes)
          )
            previewCache.delete(previewCache.keys().next().value)
          previewCache.set(key, { html, bytes, createdAt: now })
        }
      }
      res.json({ html })
    } finally {
      previews--
    }
  }),
)
function selected(input) {
  const selection = z
    .array(
      z.object({
        id: z.string(),
        revision: z.number().int().min(1).optional(),
      }),
    )
    .min(1)
    .max(config.maxSelection)
    .parse(input)
  if (new Set(selection.map((i) => i.id)).size !== selection.length)
    throw new AppError("组件选择重复")
  const docs = selection.map((i) => store.get(i.id, i.revision))
  if (Buffer.byteLength(JSON.stringify(docs)) > config.maxBytes * 2)
    throw new AppError("所选源码超过单次导出大小上限，请分批导出", 413)
  return docs
}
app.post("/api/export/check", (req, res) =>
  res.json(planExport(selected(req.body.selection))),
)
app.post(
  "/api/export",
  asyncRoute(async (req, res) => {
    const docs = selected(req.body.selection)
    const purpose = z.string().max(8000).default("").parse(req.body.purpose)
    if (req.body.format === "prompt")
      return res.json({ text: promptFor(docs, purpose) })
    const zip = await archiveTask(
      { kind: "export", documents: docs, purpose },
      config,
    )
    res
      .set({
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="selected-ui-kit.zip"',
      })
      .send(Buffer.from(zip))
  }),
)
app.get("/api/kits", (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1)
    .parse(req.query.page)
  res.json(store.kits(page))
})
app.get("/api/kits/:id", (req, res) => res.json(store.kit(req.params.id)))
app.post("/api/kits", (req, res) => {
  const name = z.string().trim().min(1).max(100).parse(req.body.name)
  const docs = selected(req.body.selection)
  res.status(201).json(
    store.saveKit(
      name,
      docs.map((d) => ({ id: d.id, revision: d.revision })),
    ),
  )
})
app.get("/api/registry/:id", (req, res) => {
  const doc = store.get(req.params.id)
  if (doc.framework !== "react") throw new AppError("HTML 组件请使用源码包导出")
  if (doc.files.some((file) => file.encoding === "base64"))
    throw new AppError("包含二进制资源的组件请使用源码包导出", 422)
  res.json({
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: doc.slug,
    type: "registry:component",
    title: doc.name,
    description: doc.description,
    license: doc.license,
    dependencies: Object.entries(doc.dependencies).map(([n, v]) => `${n}@${v}`),
    registryDependencies: [],
    files: doc.files.map((f) => ({
      path: f.path,
      type: "registry:component",
      target: f.path,
      content: f.content,
    })),
  })
})
app.get("/api/tokens", (_req, res) =>
  res.json(
    store.db
      .prepare(
        "SELECT id,name,created_at FROM api_tokens ORDER BY created_at DESC LIMIT 20",
      )
      .all(),
  ),
)
app.post("/api/tokens", (_req, res) => {
  if (store.db.prepare("SELECT count(*) AS n FROM api_tokens").get().n >= 20)
    throw new AppError("Token 已达 20 个，请先撤销旧 Token")
  const token = randomBytes(32).toString("hex")
  const id = randomBytes(8).toString("hex")
  store.db
    .prepare("INSERT INTO api_tokens VALUES(?,?,?,?)")
    .run(id, hash(token), "Agent 只读访问", new Date().toISOString())
  res.status(201).json({ id, token })
})
app.delete("/api/tokens/:id", (req, res) => {
  store.db.prepare("DELETE FROM api_tokens WHERE id=?").run(req.params.id)
  res.json({ success: true })
})
app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }))

const root = fileURLToPath(new URL("../", import.meta.url))
let vite
if (process.argv.includes("--production")) {
  app.use(
    express.static(path.join(root, "dist"), {
      etag: true,
      maxAge: "1h",
      setHeaders(res) {
        res.setHeader("Cache-Control", "private,max-age=3600")
      },
    }),
  )
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  )
} else {
  const { createServer } = await import("vite")
  vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: false },
  })
  app.use(vite.middlewares)
}
app.use((error, req, res, _next) => {
  const status =
    error instanceof z.ZodError
      ? 400
      : error.status || (error.type === "entity.too.large" ? 413 : 500)
  const message =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")
      : status >= 500 && !(error instanceof AppError)
        ? "服务处理失败，请根据请求编号查看日志"
        : error.message
  console.error(
    JSON.stringify({
      event: "request_failed",
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status,
      errorType: error.name,
    }),
  )
  res.status(status).json({ error: message, requestId: req.requestId })
})
if (config.seed && !store.list({ size: 1 }).total)
  store.createMany(examples.map((d) => validateComponent(d, config.maxBytes)))
const server = app.listen(config.port, config.host, () =>
  console.log(`拾 UI 已启动 ${config.origin}`),
)
function shutdown() {
  server.close(async () => {
    await vite?.close()
    store.db.close()
    process.exit(0)
  })
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
