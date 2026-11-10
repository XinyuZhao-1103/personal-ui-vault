import { Buffer } from "node:buffer"
import { z } from "zod"
import { AppError, validateComponent } from "../server/model.mjs"
import { analyze } from "../server/importer.mjs"
import { fetchAllowedText } from "./remote.mjs"
import { syncPolicy, reviewedComponent } from "./sync-policy.mjs"

export async function documentHash(document) {
  const normalized = validateComponent(document, 1048576)
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)))).toString("hex")
}
const packageVersions = { react: "19.1.0", "react-dom": "19.1.0", clsx: "2.1.1", "tailwind-merge": "2.6.0", "lucide-react": "0.468.0", motion: "12.23.24", "@radix-ui/react-slot": "1.2.3", "class-variance-authority": "0.7.1", "react-use-measure": "2.1.7" }

async function github(path, config, env) {
  if (config.deadline && Date.now() >= config.deadline) throw new AppError("采集达到总时限，请检查本轮未补足来源", 504)
  const response = await fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(Math.min(config.fetchTimeout, config.deadline ? Math.max(1, config.deadline - Date.now()) : config.fetchTimeout)), headers: { Accept: "application/vnd.github+json", "User-Agent": "Personal-UI-Vault", ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) } })
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`GitHub 返回 HTTP ${response.status}`, 502) }
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new AppError("GitHub 响应超过上限", 413)
  return JSON.parse(text)
}

// 固定快照后逐文件检查精选清单，避免目录没有近期提交时漏采历史优质组件。
async function* recentComponents(source, config, env, observed) {
  const snapshots = await github(`/repos/${source.repository}/commits?per_page=1`, config, env)
  if (!snapshots.length) { observed.exhausted = true; return }
  observed.commit = snapshots[0].sha
  const entries = Object.entries(source.reviews)
  const components = []
  for (const [filename, review] of entries.slice(0, config.syncMaxCommits)) {
    const sourcePath = `${source.directory}/${filename}`
    const commits = await github(`/repos/${source.repository}/commits?path=${encodeURIComponent(sourcePath)}&sha=${observed.commit}&per_page=1`, config, env)
    observed.scannedCommits++
    if (!commits.length) continue
    components.push({ item: { filename: sourcePath }, commit: commits[0], review })
  }
  components.sort((a, b) => b.commit.commit.committer.date.localeCompare(a.commit.commit.committer.date) || a.item.filename.localeCompare(b.item.filename))
  observed.reviewedAvailable = components.length
  observed.scanLimited = entries.length > config.syncMaxCommits
  for (const component of components) yield component
  observed.exhausted = !observed.scanLimited
}

async function collectedComponent(store, slug, repository, sourcePath) {
  const suffix = `/${sourcePath}`
  // D1 限制 LIKE 模式长度，来源路径改用精确前后缀比较。
  return store.statement(`SELECT c.id FROM components c JOIN revisions r ON r.component_id=c.id AND r.revision=c.revision
    WHERE c.slug=? OR ((instr(json_extract(r.document,'$.source'),?)=1 OR instr(json_extract(r.document,'$.source'),?)=1)
      AND substr(json_extract(r.document,'$.source'),?)=?) LIMIT 1`,
  slug, `https://github.com/${repository}/blob/`, `https://raw.githubusercontent.com/${repository}/`, -suffix.length, suffix).first()
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
    for (const source of syncPolicy.sources.filter(source => source.enabled)) {
      const observed = { repository: source.repository, observedAt: now, target: Math.min(config.syncBatchSize, options.sourceLimits?.[source.repository] ?? config.syncBatchSize), selected: 0, skippedExisting: 0, scannedCommits: 0, exhausted: false }
      summary.sources.push(observed)
      if (!observed.target) continue
      try {
        const metadata = await github(`/repos/${source.repository}`, config, env)
        if (metadata.license?.spdx_id !== "MIT") throw new AppError("来源当前许可证需要重新核对", 422)
        observed.stars = metadata.stargazers_count
        let licenseText
        for await (const { item, commit, review } of recentComponents(source, config, env, observed)) {
          const key = `${source.repository}:${item.filename}:${commit.sha}`
          if (options.excludeCandidateIds?.includes(key)) continue
          const slug = `${source.prefix}-${item.filename.split("/").pop().replace(/\.tsx$/, "")}`
          if (await collectedComponent(store, slug, source.repository, item.filename)) { observed.skippedExisting++; continue }
          const existing = await store.statement("SELECT id FROM sync_candidates WHERE repository=? AND source_path=? AND commit_sha=?", source.repository, item.filename, commit.sha).first()
          licenseText ||= await fetchAllowedText(`https://raw.githubusercontent.com/${source.repository}/${observed.commit}/${source.licensePath}`, { ...config, registryHosts: ["raw.githubusercontent.com"] })
          if (Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(licenseText))).toString("hex") !== source.licenseSha256) throw new AppError("来源许可正文发生变化，需要人工核对", 422)
          const content = await fetchAllowedText(`https://raw.githubusercontent.com/${source.repository}/${observed.commit}/${item.filename}`, { ...config, registryHosts: ["raw.githubusercontent.com"] })
          const document = validateComponent({
            name: review.name, slug,
            category: review.category, framework: "react", description: `${review.reason} 来源 ${source.repository}，源码最近更新 ${commit.commit.committer.date}`,
            source: `https://github.com/${source.repository}/blob/${observed.commit}/${item.filename}`, license: licenseText,
            entry: "component.tsx", demo: review.demo,
            tags: ["特色精选", source.prefix, "自动采集"],
            dependencies: Object.fromEntries(Object.entries(analyze(content).dependencies).map(([name, version]) => [name, packageVersions[name] || version])),
            files: [
              { path: "component.tsx", content },
              { path: "lib/utils.ts", content: 'import {clsx} from "clsx";import {twMerge} from "tailwind-merge";export function cn(...values:unknown[]){return twMerge(clsx(values))}' },
              ...(review.css ? [{ path: "preview.css", content: review.css }] : []),
              { path: "LICENSE.txt", content: licenseText },
              { path: "upstream/component.tsx.txt", content },
              { path: "PROVENANCE.json", content: JSON.stringify({ repository: source.repository, path: item.filename, commit: observed.commit, lastModifiedCommit: commit.sha, modifiedAt: commit.commit.committer.date, collectedAt: now, selectionReason: review.reason, adaptations: review.css ? ["附带演示与 Tailwind 3 兼容 CSS，原始源码保存在 upstream/"] : ["补充独立演示，保留原始源码"], policy: "curated-v1" }, null, 2) },
            ],
          }, config.maxBytes)
          await store.statement("INSERT INTO sync_candidates VALUES(?,?,?,?,?,'pending','等待隔离编译验证',?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at WHERE sync_candidates.status<>'imported'", key, source.repository, item.filename, commit.sha, JSON.stringify(document), now).run()
          if (!existing) summary.discovered++
          summary.candidateIds.push(key)
          observed.selected++
          if (observed.selected >= observed.target) break
        }
        observed.shortfall = Math.max(0, observed.target - observed.selected)
        observed.limit = observed.target
        observed.remainingCapacity = observed.shortfall
        if (observed.scanLimited) throw new AppError("达到精选文件检查上限，请提高 VAULT_SYNC_MAX_COMMITS", 422)
        await store.statement("INSERT OR REPLACE INTO sync_state VALUES(?,?)", `source:${source.repository}`, JSON.stringify(observed)).run()
      } catch (error) {
        console.error(JSON.stringify({ event: "sync_source_failed", repository: source.repository, errorType: error.name, message: error.message?.slice(0, 1000) }))
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
  const review = reviewedComponent(candidate.repository, candidate.source_path)
  if (!review)
    throw new AppError("候选未通过当前精选策略，请先补充筛选说明和演示", 422)
  const original = validateComponent(JSON.parse(candidate.document), config.maxBytes)
  const source = syncPolicy.sources.find(source => source.repository === candidate.repository)
  if (Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original.license))).toString("hex") !== source.licenseSha256)
    throw new AppError("候选许可与当前精选策略不一致，需要重新采集", 422)
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
    { name: "vault_sync_sources", description: "检查许可与精选清单，按最近修改排序，每来源最多三个候选，允许无新增。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
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
