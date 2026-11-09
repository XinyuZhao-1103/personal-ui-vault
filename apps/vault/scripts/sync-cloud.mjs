import { gzipSync } from "node:zlib"
import { makePreview } from "../server/preview.mjs"
import { validateComponent } from "../server/model.mjs"

const origin = new URL(process.env.VAULT_SITE_URL).origin
const token = process.env.VAULT_SITE_SERVICE_TOKEN
if (!token) throw new Error("缺少 VAULT_SITE_SERVICE_TOKEN")
if (!origin.startsWith("https://")) throw new Error("VAULT_SITE_URL 必须使用 HTTPS")
async function api(path, method = "GET", body) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(120000), headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${value.error || "请求失败"}`)
  return value
}
const discovery = await api("/api/sync/run", "POST", {})
console.log(JSON.stringify({ event: "discovered", ...discovery }))
let cursor = ""
let processed = 0
let failed = 0
// 每次最多处理 30 个候选，避免积压使单次任务无限增长。
while (processed < 30) {
  const { items } = await api(`/api/sync/candidates?after=${encodeURIComponent(cursor)}`)
  if (!items.length) break
  for (const candidate of items) {
    cursor = candidate.id
    processed++
    try {
      const document = validateComponent(JSON.parse(candidate.document), 1048576)
      const html = await makePreview(document, 30000)
      const result = await api("/api/sync/publish", "POST", { candidateId: candidate.id, previewGzip: gzipSync(html).toString("base64") })
      // 正常读取入口校验已写入的版本，服务更新边界另提供读回工具。
      console.log(JSON.stringify({ event: "published", slug: document.slug, ...result }))
    } catch (error) {
      failed++
      await api("/api/sync/reject", "POST", { candidateId: candidate.id, reason: error.message.slice(0, 1000) })
      console.error(JSON.stringify({ event: "candidate_failed", candidate: candidate.id, error: error.message }))
    }
    if (processed >= 30) break
  }
}
const readback = await api("/api/sync/status")
console.log(JSON.stringify({ processed, failed, latestRun: readback.runs[0]?.id }))
if (discovery.failures.length || failed) process.exitCode = 1
