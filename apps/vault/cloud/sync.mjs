import { Buffer } from "node:buffer"
import { z } from "zod"
import { AppError, validateComponent } from "../server/model.mjs"
import { analyze } from "../server/importer.mjs"
import { fetchAllowedText } from "./remote.mjs"
import catalog from "../generated/cloud-catalog.json" with { type: "json" }

export async function documentHash(document) {
  const normalized = validateComponent(document, 1048576)
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)))).toString("hex")
}
const locations = {
  "shadcn-ui/ui": { directory: "apps/v4/registry/new-york-v4/ui", prefix: "shadcn" },
  "magicuidesign/magicui": { directory: "apps/www/registry/magicui", prefix: "magic" },
  "ibelick/motion-primitives": { directory: "components/core", prefix: "motion" },
}
const packageVersions = { react: "19.1.0", "react-dom": "19.1.0", clsx: "2.1.1", "tailwind-merge": "2.6.0", "lucide-react": "0.468.0", motion: "12.23.24", "@radix-ui/react-slot": "1.2.3", "class-variance-authority": "0.7.1" }

async function github(path, config, env) {
  const response = await fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(config.fetchTimeout), headers: { Accept: "application/vnd.github+json", "User-Agent": "Personal-UI-Vault", ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) } })
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`GitHub 返回 HTTP ${response.status}`, 502) }
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new AppError("GitHub 响应超过上限", 413)
  return JSON.parse(text)
}

export async function syncSources(store, config, env) {
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  const lease = String(Date.now() + 300000)
  // D1 原子租约避免云任务重试与手动执行重叠，超时后可恢复。
  const lock = await store.statement("INSERT INTO sync_state(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(sync_state.value AS INTEGER)<?", lease, Date.now()).run()
  if (!lock.meta.changes) throw new AppError("同步任务正在运行", 409)
  const summary = { discovered: 0, sources: [], failures: [] }
  await store.statement("INSERT INTO sync_runs VALUES(?,?,NULL,'running','{}')", runId, now).run()
  try {
    for (const source of catalog.sources.sources) {
      try {
        const location = locations[source.repository]
        const metadata = await github(`/repos/${source.repository}`, config, env)
        if (metadata.license?.spdx_id !== "MIT") throw new AppError("来源当前许可证需要重新核对", 422)
        const commits = await github(`/repos/${source.repository}/commits?path=${encodeURIComponent(location.directory)}&per_page=1`, config, env)
        if (!commits.length) continue
        const commit = await github(`/repos/${source.repository}/commits/${commits[0].sha}`, config, env)
        const candidates = (commit.files || []).filter(file => file.status !== "removed" && file.filename.startsWith(location.directory + "/") && file.filename.endsWith(".tsx")).slice(0, config.syncBatchSize)
        for (const item of candidates) {
          const key = `${source.repository}:${item.filename}:${commit.sha}`
          const existing = await store.statement("SELECT id FROM sync_candidates WHERE repository=? AND source_path=? AND commit_sha=?", source.repository, item.filename, commit.sha).first()
          if (existing) continue
          const content = await fetchAllowedText(`https://raw.githubusercontent.com/${source.repository}/${commit.sha}/${item.filename}`, { ...config, registryHosts: ["raw.githubusercontent.com"] })
          const known = catalog.sources.components.find(component => component.repository === source.repository && component.path === item.filename)
          const baseline = known ? catalog.documents.find(document => document.slug === known.slug) : null
          const slug = baseline?.slug || `${location.prefix}-${item.filename.split("/").pop().replace(/\.tsx$/, "")}`
          const document = validateComponent({
            ...(baseline || {}), name: baseline?.name || `${source.repository.split("/")[1]} · ${slug}`, slug,
            category: baseline?.category || "其他", framework: "react", description: baseline?.description || `来源 ${source.repository}，源码更新 ${commit.commit.committer.date}`,
            source: `https://github.com/${source.repository}/blob/${commit.sha}/${item.filename}`, license: source.license,
            entry: "component.tsx", demo: baseline?.demo || "",
            tags: [...new Set([...(baseline?.tags || []), "自动采集"])],
            dependencies: Object.fromEntries(Object.entries(analyze(content).dependencies).map(([name, version]) => [name, packageVersions[name] || version])),
            files: [
              { path: "component.tsx", content },
              ...(baseline?.files.filter(file => file.path !== "component.tsx") || [
                { path: "lib/utils.ts", content: 'import {clsx} from "clsx";import {twMerge} from "tailwind-merge";export function cn(...values:unknown[]){return twMerge(clsx(values))}' },
                { path: "LICENSE.txt", content: source.license },
              ]),
            ],
          }, config.maxBytes)
          await store.statement("INSERT OR IGNORE INTO sync_candidates VALUES(?,?,?,?,?,'pending','等待隔离编译验证',?)", key, source.repository, item.filename, commit.sha, JSON.stringify(document), now).run()
          summary.discovered++
        }
        const observed = { repository: source.repository, stars: metadata.stargazers_count, observedAt: now, commit: commit.sha, changedComponents: candidates.length }
        await store.statement("INSERT OR REPLACE INTO sync_state VALUES(?,?)", `source:${source.repository}`, JSON.stringify(observed)).run()
        summary.sources.push(observed)
      } catch (error) {
        summary.failures.push({ repository: source.repository, error: error instanceof AppError ? error.message : "来源处理失败" })
      }
    }
    const status = summary.failures.length ? "partial" : "complete"
    await store.statement("UPDATE sync_runs SET status=?,finished_at=?,summary=? WHERE id=?", status, new Date().toISOString(), JSON.stringify(summary), runId).run()
    return { runId, status, ...summary }
  } catch (error) {
    await store.statement("UPDATE sync_runs SET status='failed',finished_at=?,summary=? WHERE id=?", new Date().toISOString(), JSON.stringify({ error: "同步中断，可安全重试" }), runId).run()
    throw error
  } finally {
    await store.statement("DELETE FROM sync_state WHERE key='sync_lock' AND value=?", lease).run()
  }
}

export async function publishCandidate(body, store, config, env) {
  const input = z.object({ candidateId: z.string().max(500), previewGzip: z.string().max(1200000), document: z.unknown().optional() }).parse(body)
  const candidate = await store.statement("SELECT * FROM sync_candidates WHERE id=?", input.candidateId).first()
  if (!candidate) throw new AppError("候选组件不存在", 404)
  const original = validateComponent(JSON.parse(candidate.document), config.maxBytes)
  const document = validateComponent(input.document || original, config.maxBytes)
  if (document.slug !== original.slug || document.source !== original.source || document.license !== original.license)
    throw new AppError("适配代码需要保留原组件标识、来源与许可", 422)
  const previewStream = new Blob([Buffer.from(input.previewGzip, "base64")]).stream().pipeThrough(new DecompressionStream("gzip"))
  const reader = previewStream.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.length
      if (total > 4 * 1024 * 1024) throw new AppError("预览产物超过上限", 413)
      chunks.push(result.value)
    }
  } finally { await reader.cancel() }
  const preview = Buffer.concat(chunks).toString("utf8")
  if (!preview.startsWith("<!doctype html>") || !preview.includes('http-equiv="Content-Security-Policy"')) throw new AppError("预览产物缺少隔离策略", 422)
  const digest = await documentHash(document)
  const existing = await store.statement("SELECT id FROM components WHERE slug=?", document.slug).first()
  const current = existing ? await store.get(existing.id) : null
  if (current && await documentHash(current) === digest) return { status: "unchanged", id: current.id, revision: current.revision, readback: "verified" }
  if (current) {
    const previous = await store.statement("SELECT value FROM sync_state WHERE key=?", `managed:${current.id}`).first()
    if (!previous || previous.value !== await documentHash(current)) throw new AppError("组件已有用户修改，已保留当前内容并留在候选区", 409)
  }
  await env.BUCKET.put(`previews/${digest}.html`, preview, { httpMetadata: { contentType: "text/html; charset=utf-8" } })
  const saved = current ? await store.update(current.id, document, current.revision) : (await store.createMany([document]))[0]
  await store.db.batch([
    store.statement("INSERT OR REPLACE INTO sync_state VALUES(?,?)", `managed:${saved.id}`, digest),
    store.statement("UPDATE sync_candidates SET status='imported',reason='隔离编译与浏览器验证通过，已入库',document=?,updated_at=? WHERE id=?", JSON.stringify(document), new Date().toISOString(), input.candidateId),
  ])
  const persisted = await store.get(saved.id, saved.revision)
  if (await documentHash(persisted) !== digest) throw new AppError("写入读回校验失败", 500)
  return { status: "imported", id: persisted.id, revision: persisted.revision, readback: "verified" }
}

export async function handleMcp(body, store, config, env) {
  const tools = [
    { name: "vault_sync_sources", description: "检查三个认可的 MIT 来源，收集最近组件变更和仓库星数，形成待编译候选。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "vault_sync_status", description: "读取最新同步结果与候选概况。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ]
  const result = value => Response.json({ jsonrpc: "2.0", id: body.id, result: value })
  if (body.method === "server/discover") return result({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } })
  if (body.method === "tools/list") return result({ tools })
  if (body.method === "tools/call") {
    try {
      let value
      if (body.params?.name === "vault_sync_sources") value = await syncSources(store, config, env)
      else if (body.params?.name === "vault_sync_status") value = (await store.statement("SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 10").all()).results
      else throw new AppError("工具不存在", 404)
      return result({ content: [{ type: "text", text: JSON.stringify(value) }] })
    } catch (error) { return result({ isError: true, content: [{ type: "text", text: error.status ? error.message : "同步工具执行失败" }] }) }
  }
  return Response.json({ jsonrpc: "2.0", id: body.id || null, error: { code: -32601, message: "Method not found" } })
}
