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
  if (config.deadline && Date.now() >= config.deadline) throw new AppError("采集达到总时限，请检查本轮未补足来源", 504)
  const response = await fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(Math.min(config.fetchTimeout, config.deadline ? Math.max(1, config.deadline - Date.now()) : config.fetchTimeout)), headers: { Accept: "application/vnd.github+json", "User-Agent": "Personal-UI-Vault", ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) } })
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`GitHub 返回 HTTP ${response.status}`, 502) }
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new AppError("GitHub 响应超过上限", 413)
  return JSON.parse(text)
}

// 固定本轮提交快照，分页向前扫描。删除和重命名旧路径也参与去重，避免捞回已删除文件。
async function* recentComponents(repository, directory, config, env, observed) {
  const seen = new Set()
  let anchor = ""
  const pageSize = 10
  for (let offset = 0; offset < config.syncMaxCommits; offset += pageSize) {
    const commits = await github(`/repos/${repository}/commits?path=${encodeURIComponent(directory)}&per_page=${pageSize}&page=${offset / pageSize + 1}${anchor ? `&sha=${anchor}` : ""}`, config, env)
    if (!commits.length) { observed.exhausted = true; return }
    anchor ||= commits[0].sha
    observed.commit = anchor
    for (const entry of commits.slice(0, config.syncMaxCommits - offset)) {
      observed.scannedCommits++
      // GitHub 单提交文件最多返回 3000 项，每页 100 项。
      for (let page = 1; page <= 30; page++) {
        const commit = await github(`/repos/${repository}/commits/${entry.sha}?per_page=100&page=${page}`, config, env)
        const files = commit.files || []
        for (const item of files.toSorted((a, b) => a.filename.localeCompare(b.filename))) {
          if (item.previous_filename) seen.add(item.previous_filename)
          if (seen.has(item.filename)) continue
          seen.add(item.filename)
          if (item.status !== "removed" && item.filename.startsWith(directory + "/") && item.filename.endsWith(".tsx"))
            yield { item, commit }
        }
        if (files.length < 100) break
        if (page === 30) throw new AppError("单提交文件超过 GitHub 可分页上限", 422)
      }
    }
    if (commits.length < pageSize) { observed.exhausted = true; return }
  }
}

async function collectedComponent(store, slug, repository, sourcePath) {
  const escaped = value => value.replace(/[\\%_]/g, character => `\\${character}`)
  return store.statement(`SELECT c.id FROM components c JOIN revisions r ON r.component_id=c.id AND r.revision=c.revision
    WHERE c.slug=? OR json_extract(r.document,'$.source') LIKE ? ESCAPE '\\' OR json_extract(r.document,'$.source') LIKE ? ESCAPE '\\' LIMIT 1`,
  slug, `https://github.com/${escaped(repository)}/blob/%/${escaped(sourcePath)}`, `https://raw.githubusercontent.com/${escaped(repository)}/%/${escaped(sourcePath)}`).first()
}

export async function syncSources(store, config, env, options = {}) {
  config = { ...config, deadline: Date.now() + config.syncTimeout }
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  const lease = String(Date.now() + 300000)
  // D1 原子租约避免云任务重试与手动执行重叠，超时后可恢复。
  const lock = await store.statement("INSERT INTO sync_state(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(sync_state.value AS INTEGER)<?", lease, Date.now()).run()
  if (!lock.meta.changes) throw new AppError("同步任务正在运行", 409)
  const summary = { discovered: 0, candidateIds: [], sources: [], failures: [] }
  try {
    await store.statement("INSERT INTO sync_runs VALUES(?,?,NULL,'running','{}')", runId, now).run()
    for (const source of catalog.sources.sources) {
      const observed = { repository: source.repository, observedAt: now, target: Math.min(config.syncBatchSize, options.sourceLimits?.[source.repository] ?? config.syncBatchSize), selected: 0, skippedExisting: 0, scannedCommits: 0, exhausted: false }
      summary.sources.push(observed)
      if (!observed.target) continue
      try {
        const location = locations[source.repository]
        const metadata = await github(`/repos/${source.repository}`, config, env)
        if (metadata.license?.spdx_id !== "MIT") throw new AppError("来源当前许可证需要重新核对", 422)
        observed.stars = metadata.stargazers_count
        let licenseText
        for await (const { item, commit } of recentComponents(source.repository, location.directory, config, env, observed)) {
          const key = `${source.repository}:${item.filename}:${commit.sha}`
          if (options.excludeCandidateIds?.includes(key)) continue
          const known = catalog.sources.components.find(component => component.repository === source.repository && component.path === item.filename)
          const baseline = known ? catalog.documents.find(document => document.slug === known.slug) : null
          const slug = baseline?.slug || `${location.prefix}-${item.filename.split("/").pop().replace(/\.tsx$/, "")}`
          if (await collectedComponent(store, slug, source.repository, item.filename)) { observed.skippedExisting++; continue }
          const existing = await store.statement("SELECT id FROM sync_candidates WHERE repository=? AND source_path=? AND commit_sha=?", source.repository, item.filename, commit.sha).first()
          if (existing) {
            summary.candidateIds.push(existing.id)
            observed.selected++
            if (observed.selected >= observed.target) break
            continue
          }
          licenseText ||= await fetchAllowedText(`https://raw.githubusercontent.com/${source.repository}/${observed.commit}/${source.licensePath}`, { ...config, registryHosts: ["raw.githubusercontent.com"] })
          if (!licenseText.includes("Permission is hereby granted")) throw new AppError("来源许可正文需要人工核对", 422)
          const content = await fetchAllowedText(`https://raw.githubusercontent.com/${source.repository}/${commit.sha}/${item.filename}`, { ...config, registryHosts: ["raw.githubusercontent.com"] })
          const document = validateComponent({
            ...(baseline || {}), name: baseline?.name || `${source.repository.split("/")[1]} · ${slug}`, slug,
            category: baseline?.category || "其他", framework: "react", description: `来源 ${source.repository}，源码最近更新 ${commit.commit.committer.date}`,
            source: `https://github.com/${source.repository}/blob/${commit.sha}/${item.filename}`, license: licenseText,
            entry: "component.tsx", demo: baseline?.demo || "",
            tags: [...new Set([...(baseline?.tags || []), "自动采集"])],
            dependencies: Object.fromEntries(Object.entries(analyze(content).dependencies).map(([name, version]) => [name, packageVersions[name] || version])),
            files: [
              { path: "component.tsx", content },
              ...(baseline?.files.filter(file => !["component.tsx", "LICENSE.txt", "PROVENANCE.json", "upstream/component.tsx.txt"].includes(file.path)) || [
                { path: "lib/utils.ts", content: 'import {clsx} from "clsx";import {twMerge} from "tailwind-merge";export function cn(...values:unknown[]){return twMerge(clsx(values))}' },
              ]),
              { path: "LICENSE.txt", content: licenseText },
              { path: "upstream/component.tsx.txt", content },
              { path: "PROVENANCE.json", content: JSON.stringify({ repository: source.repository, path: item.filename, commit: commit.sha, modifiedAt: commit.commit.committer.date, collectedAt: now }, null, 2) },
            ],
          }, config.maxBytes)
          await store.statement("INSERT OR IGNORE INTO sync_candidates VALUES(?,?,?,?,?,'pending','等待隔离编译验证',?)", key, source.repository, item.filename, commit.sha, JSON.stringify(document), now).run()
          summary.discovered++
          summary.candidateIds.push(key)
          observed.selected++
          if (observed.selected >= observed.target) break
        }
        observed.shortfall = Math.max(0, observed.target - observed.selected)
        if (observed.shortfall && !observed.exhausted) throw new AppError("达到提交扫描上限，仍未补足目标数量", 422)
        await store.statement("INSERT OR REPLACE INTO sync_state VALUES(?,?)", `source:${source.repository}`, JSON.stringify(observed)).run()
      } catch (error) {
        observed.shortfall = Math.max(0, observed.target - observed.selected)
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
  const provenance = JSON.parse(original.files.find(file => file.path === "PROVENANCE.json")?.content || "{}")
  const collected = await collectedComponent(store, document.slug, provenance.repository || candidate.repository, provenance.path || candidate.source_path)
  if (collected) {
    await store.statement("UPDATE sync_candidates SET status='imported',reason='组件已存在，跳过同步',updated_at=? WHERE id=?", new Date().toISOString(), input.candidateId).run()
    return { status: "skipped", id: collected.id, reason: "组件已存在" }
  }
  await env.BUCKET.put(`previews/${digest}.html`, preview, { httpMetadata: { contentType: "text/html; charset=utf-8" } })
  const saved = (await store.createMany([document]))[0]
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
    { name: "vault_sync_sources", description: "按最近修改顺序跳过已收录组件，每来源默认补足三个待验证候选。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
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
