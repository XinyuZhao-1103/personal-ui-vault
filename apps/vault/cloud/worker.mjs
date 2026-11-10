import { Buffer } from "node:buffer"
import { z } from "zod"
import { AppError, validateComponent } from "../server/model.mjs"
import { analyze, readRegistry, readZip } from "../server/importer.mjs"
import { planExport, promptFor, exportZip } from "../server/exporter.mjs"
import { examples } from "../server/examples.mjs"
import { cloudConfig } from "./config.mjs"
import { cloudStore } from "./store.mjs"
import { createIdentity } from "../server/identity.mjs"
import { authorizeVault } from "../server/access.mjs"
import { handleMcp, syncSources, publishCandidate, documentHash } from "./sync.mjs"
import { syncRepositories } from "./sync-policy.mjs"
import catalog from "../generated/cloud-catalog.json" with { type: "json" }

const json = (value, status = 200) => Response.json(value, { status })
const hash = async value => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex")
const revisionSchema = z.coerce.number().int().min(1).max(1000000)

async function selected(input, store, config) {
  const selection = z.array(z.object({ id: z.string().max(100), revision: revisionSchema.optional() })).min(1).max(config.maxSelection).parse(input)
  if (new Set(selection.map(item => item.id)).size !== selection.length) throw new AppError("组件选择重复")
  const docs = []
  let bytes = 0
  for (const item of selection) {
    const doc = await store.get(item.id, item.revision)
    bytes += Buffer.byteLength(JSON.stringify(doc))
    if (bytes > 8 * 1024 * 1024) throw new AppError("所选源码超过单次导出上限，请分批导出", 413)
    docs.push(doc)
  }
  return docs
}

async function route(request, env, config) {
  const url = new URL(request.url)
  const path = url.pathname
  const store = cloudStore(env.DB)
  const identity = createIdentity({ db: env.DB, config })
  await identity.ensureBootstrap()
  const authResponse = await identity.handle(request)
  if (authResponse) return authResponse
  const user = await identity.getSession(request)
  const servicePath = path === "/mcp" || path.startsWith("/api/sync/") || path === "/api/catalog/bootstrap"
  const browserIdentity = user?.role === "admin"
  // Dispatch 会消费其服务头，因此应用层使用独立头再次验证服务密钥。
  const serviceHeader = request.headers.get("x-vault-service-token")
  const serviceAuthorized = !!(servicePath && config.serviceToken && serviceHeader && await hash(serviceHeader) === await hash(config.serviceToken))
  let readerToken = false
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
  if (bearer && request.method === "GET")
    readerToken = !!await store.statement("SELECT id FROM api_tokens WHERE token_hash=?", await hash(bearer)).first()
  if (path === "/api/health") {
    await store.statement("SELECT 1 FROM components LIMIT 1").all()
    return json({ status: "ok", version: "0.2.0", runtime: "sites" })
  }
  if (!serviceAuthorized) authorizeVault(user, path, request.method, readerToken)
  if (!["GET", "HEAD"].includes(request.method) && !serviceAuthorized && request.headers.get("origin") !== url.origin)
    throw new AppError("请求来源不匹配", 403)
  let body = {}
  if (!["GET", "HEAD"].includes(request.method)) {
    const declared = Number(request.headers.get("content-length") || 0)
    if (declared > config.maxBytes) throw new AppError("请求超过大小上限", 413)
    const reader = request.body?.getReader()
    const chunks = []
    let length = 0
    if (reader) {
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          length += result.value.length
          if (length > config.maxBytes) throw new AppError("请求超过大小上限", 413)
          chunks.push(result.value)
        }
      } finally { await reader.cancel() }
    }
    const bytes = Buffer.concat(chunks)
    if (path === "/api/import/zip") body = bytes
    else {
      try { body = bytes.length ? JSON.parse(bytes.toString()) : {} }
      catch { throw new AppError("JSON 格式无效") }
    }
  }
  if (path === "/mcp") return handleMcp(body, store, config, env)
  if (path === "/api/sync/run" && request.method === "POST") {
    const input = z.object({
      githubToken: z.string().min(20).max(1000).optional(),
      sourceLimits: z.record(z.enum(syncRepositories), z.number().int().min(0).max(config.syncBatchSize)).optional(),
      excludeCandidateIds: z.array(z.string().min(1).max(500)).max(100).optional(),
    }).parse(body)
    // Actions 临时只读凭据仅用于本次公开来源访问，不保存到数据库或日志。
    return json(await syncSources(store, config, { ...env, GITHUB_TOKEN: input.githubToken || env.GITHUB_TOKEN }, input))
  }
  if (path === "/api/sync/publish" && request.method === "POST") return json(await publishCandidate(body, store, config, env))
  if (path === "/api/sync/candidates" && request.method === "GET") {
    const ids = z.array(z.string().min(1).max(500)).max(30).parse(url.searchParams.getAll("id"))
    if (ids.length) return json({ items: (await store.statement(`SELECT id,document FROM sync_candidates WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY updated_at DESC,id`, ...ids).all()).results })
    const after = z.string().max(500).default("").parse(url.searchParams.get("after") || undefined)
    return json({ items: (await store.statement("SELECT id,document FROM sync_candidates WHERE (status IN ('pending','failed') OR (status='imported' AND json_extract(document,'$.demo')='')) AND id>? ORDER BY id LIMIT ?", after, config.syncBatchSize).all()).results })
  }
  if (path === "/api/sync/reject" && request.method === "POST") {
    const input = z.object({ candidateId: z.string().max(500), reason: z.string().max(1000) }).parse(body)
    await store.statement("UPDATE sync_candidates SET status='failed',reason=?,updated_at=? WHERE id=? AND status<>'imported'", input.reason, new Date().toISOString(), input.candidateId).run()
    return json({ success: true })
  }
  if (path === "/api/catalog/bootstrap" && request.method === "POST") {
    let imported = 0
    for (const doc of catalog.documents) {
      if (!await store.statement("SELECT id FROM components WHERE slug=?", doc.slug).first()) {
        try { await store.createMany([validateComponent(doc, config.maxBytes)]); imported++ }
        catch (error) { if (error.status !== 409) throw error }
      }
      const row = await store.statement("SELECT id FROM components WHERE slug=?", doc.slug).first()
      const current = await store.get(row.id)
      if (await documentHash(current) === await documentHash(doc))
        await store.statement("INSERT OR IGNORE INTO sync_state VALUES(?,?)", `managed:${current.id}`, await documentHash(doc)).run()
    }
    for (const source of catalog.sources.sources) {
      const kitId = `catalog-${source.repository.replaceAll("/", "-")}`
      if (await store.statement("SELECT id FROM kits WHERE id=?", kitId).first()) continue
      const docs = []
      for (const item of catalog.sources.components.filter(item => item.repository === source.repository)) {
        const row = await store.statement("SELECT id,revision FROM components WHERE slug=?", item.slug).first()
        if (row) docs.push(row)
      }
      try { await store.saveKit(`首批精选 · ${source.repository}`, docs, kitId) }
      catch (error) { if (!/UNIQUE constraint/.test(error.message)) throw error }
    }
    return json({ imported, total: (await store.list({ size: 1 })).total })
  }
  if (path === "/api/analyze" && request.method === "POST") return json(analyze(z.string().max(config.maxBytes).parse(body.code)))
  if (path === "/api/components") {
    if (request.method === "POST") return json((await store.createMany([validateComponent(body, config.maxBytes)]))[0], 201)
    if (request.method === "GET") {
      const query = z.object({ q: z.string().max(200).default(""), category: z.string().max(20).default(""), framework: z.enum(["", "react", "html"]).default(""), page: z.coerce.number().int().min(1).max(1000).default(1), size: z.coerce.number().int().min(1).max(config.maxPageSize).default(12) }).parse(Object.fromEntries(url.searchParams))
      return json(await store.list({ ...query, query: query.q }))
    }
  }
  const component = path.match(/^\/api\/components\/([^/]+)(\/versions)?$/)
  if (component) {
    if (component[2] && request.method === "GET") return json(await store.versions(component[1]))
    if (!component[2] && request.method === "GET") return json(await store.get(component[1], url.searchParams.has("revision") ? revisionSchema.parse(url.searchParams.get("revision")) : undefined))
    if (!component[2] && request.method === "PUT") return json(await store.update(component[1], validateComponent(body, config.maxBytes), revisionSchema.parse(body.expectedRevision)))
  }
  if (path === "/api/import/zip" && request.method === "POST") return json({ items: await store.createMany(readZip(body, config)) }, 201)
  if (path === "/api/import/registry" && request.method === "POST") {
    const input = z.object({ url: z.string().url().max(2000), name: z.string().max(100).optional(), slug: z.string().max(100).optional(), category: z.string().optional() }).parse(body)
    const { url: address, ...meta } = input
    return json((await store.createMany([await readRegistry(address, config, meta)]))[0], 201)
  }
  if (path === "/api/examples" && request.method === "POST") {
    const docs = []
    for (const doc of examples) if (!await store.statement("SELECT id FROM components WHERE slug=?", doc.slug).first()) docs.push(validateComponent(doc, config.maxBytes))
    return json({ items: docs.length ? await store.createMany(docs) : [] })
  }
  if (path === "/api/preview" && request.method === "POST") {
    const doc = body.id ? await store.get(z.string().parse(body.id), body.revision ? revisionSchema.parse(body.revision) : undefined) : validateComponent(body, config.maxBytes)
    const stored = await env.BUCKET.get(`previews/${await documentHash(doc)}.html`)
    if (stored) return json({ html: await stored.text() })
    const original = catalog.documents.find(item => item.slug === doc.slug)
    if (original && await documentHash(original) === await documentHash(doc)) {
      const response = await env.ASSETS.fetch(new Request(new URL(`/previews/${doc.slug}.html`, request.url)))
      if (response.ok) return json({ html: await response.text() })
    }
    return json({ document: doc, compiler: "browser" })
  }
  if (path === "/api/export/check" && request.method === "POST") return json(planExport(await selected(body.selection, store, config)))
  if (path === "/api/export" && request.method === "POST") {
    const docs = await selected(body.selection, store, config)
    const purpose = z.string().max(8000).default("").parse(body.purpose)
    if (body.format === "prompt") return json({ text: promptFor(docs, purpose) })
    return new Response(exportZip(docs, purpose), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="selected-ui-kit.zip"' } })
  }
  if (path === "/api/kits") {
    if (request.method === "GET") return json(await store.kits(z.coerce.number().int().min(1).max(1000).default(1).parse(url.searchParams.get("page") || undefined)))
    if (request.method === "POST") return json(await store.saveKit(z.string().trim().min(1).max(100).parse(body.name), await selected(body.selection, store, config)), 201)
  }
  const kit = path.match(/^\/api\/kits\/([^/]+)$/)
  if (kit && request.method === "GET") return json(await store.kit(kit[1]))
  const registry = path.match(/^\/api\/registry\/([^/]+)$/)
  if (registry && request.method === "GET") {
    const doc = await store.get(registry[1])
    if (doc.framework !== "react" || doc.files.some(file => file.encoding === "base64")) throw new AppError("此组件请使用源码包导出", 422)
    return json({ $schema: "https://ui.shadcn.com/schema/registry-item.json", name: doc.slug, type: "registry:component", title: doc.name, description: doc.description, license: doc.license, dependencies: Object.entries(doc.dependencies).map(([name, version]) => `${name}@${version}`), registryDependencies: [], files: doc.files.map(file => ({ path: file.path, type: "registry:component", target: file.path, content: file.content })) })
  }
  if (path === "/api/tokens") {
    if (!browserIdentity) throw new AppError("只有登录用户可以管理 Token", 403)
    if (request.method === "GET") return json((await store.statement("SELECT id,name,created_at FROM api_tokens ORDER BY created_at DESC,id DESC LIMIT 20").all()).results)
    if (request.method === "POST") {
      const token = crypto.randomUUID() + crypto.randomUUID()
      const id = crypto.randomUUID()
      const result = await store.statement("INSERT INTO api_tokens SELECT ?,?,?,? WHERE (SELECT count(*) FROM api_tokens)<20", id, await hash(token), "Agent 只读访问", new Date().toISOString()).run()
      if (!result.meta.changes) throw new AppError("Token 已达 20 个，请先撤销旧 Token")
      return json({ id, token }, 201)
    }
  }
  const token = path.match(/^\/api\/tokens\/([^/]+)$/)
  if (token && request.method === "DELETE") { await store.statement("DELETE FROM api_tokens WHERE id=?", token[1]).run(); return json({ success: true }) }
  if (path === "/api/sync/status" && request.method === "GET") return json({ runs: (await store.statement("SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 20").all()).results, candidates: (await store.statement("SELECT id,repository,source_path,commit_sha,status,reason,updated_at FROM sync_candidates ORDER BY updated_at DESC,id DESC LIMIT 20").all()).results })
  throw new AppError("接口不存在", 404)
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID()
    try {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/previews/")) {
        const config = cloudConfig(env, url.origin)
        const identity = createIdentity({ db: env.DB, config })
        authorizeVault(await identity.getSession(request), "/api/components", "GET")
        const response = await env.ASSETS.fetch(request)
        const headers = new Headers(response.headers)
        headers.set("Cache-Control", "no-store")
        return new Response(response.body, { status: response.status, headers })
      }
      if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") return env.ASSETS.fetch(request)
      const response = await route(request, env, cloudConfig(env, url.origin))
      response.headers.set("Cache-Control", "no-store")
      response.headers.set("X-Content-Type-Options", "nosniff")
      response.headers.set("X-Request-Id", requestId)
      return response
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error.status || 500
      console.error(JSON.stringify({ event: "cloud_request_failed", requestId, path: new URL(request.url).pathname, status, errorType: error.name }))
      return json({ error: status >= 500 ? "云端处理失败，请根据请求编号查看日志" : error.message, requestId }, status)
    }
  },
}
