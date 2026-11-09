import { gzipSync } from "node:zlib"
import { makePreview } from "../server/preview.mjs"
import { validateComponent } from "../server/model.mjs"
import { chromium } from "@playwright/test"

const origin = new URL(process.env.VAULT_SITE_URL).origin
const token = process.env.VAULT_SITE_SERVICE_TOKEN
if (!token) throw new Error("缺少 VAULT_SITE_SERVICE_TOKEN")
if (!origin.startsWith("https://")) throw new Error("VAULT_SITE_URL 必须使用 HTTPS")
async function api(path, method = "GET", body) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(120000), headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}`, "X-Vault-Service-Token": token }, body: body === undefined ? undefined : JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw new Error(`${path} HTTP ${response.status}，站点服务访问失败`) }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${value.error || "请求失败"}`)
  return value
}
console.log(JSON.stringify({ event: "bootstrap", ...await api("/api/catalog/bootstrap", "POST", {}) }))
let discovery = await api("/api/sync/run", "POST", { githubToken: process.env.GITHUB_TOKEN })
console.log(JSON.stringify({ event: "discovered", ...discovery }))
let processed = 0
let failed = 0
let imported = 0
let skipped = 0
const importedBySource = Object.fromEntries(discovery.sources.map(source => [source.repository, 0]))
const targets = Object.fromEntries(discovery.sources.map(source => [source.repository, source.target]))
const attempted = []
let sourceFailures = discovery.failures.length
const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : "chrome" })
async function verifyPreview(html) {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.exposeFunction("recordPreviewError", message => errors.push(String(message)))
  try {
    await page.setContent('<iframe sandbox="allow-scripts" style="width:1000px;height:600px;border:0"></iframe>')
    await page.evaluate(html => {
      window.addEventListener("message", event => { if (event.data?.type === "vault-preview-error") window.recordPreviewError(event.data.message) })
      document.querySelector("iframe").srcdoc = html
    }, html)
    const root = page.frameLocator("iframe").locator("#root")
    await root.locator(":scope > *").first().waitFor({ state: "visible", timeout: 10000 })
    await page.waitForTimeout(1500)
    if (errors.length) throw new Error(`浏览器运行失败 ${errors[0]}`)
    if (/\b(NaN|undefined)\b/.test(await root.innerText())) throw new Error("演示数据不完整，请补充组件参数")
  } finally { await page.close() }
}
// 只处理本轮按新到旧选择的候选，旧积压不占各来源的名额。
while (discovery.candidateIds.length && processed < 30) {
  const query = new URLSearchParams(discovery.candidateIds.map(id => ["id", id]))
  const { items } = await api(`/api/sync/candidates?${query}`)
  if (items.length !== discovery.candidateIds.length) throw new Error("本轮候选读取不完整，请检查同步状态")
  for (const candidate of items) {
    if (processed >= 30) break
    processed++
    attempted.push(candidate.id)
    try {
      const document = validateComponent(JSON.parse(candidate.document), 1048576)
      if (!document.demo && document.slug === "magic-animated-circular-progress-bar")
        document.demo = 'import {AnimatedCircularProgressBar} from "./component";export default function Demo(){return <AnimatedCircularProgressBar max={100} min={0} value={65} gaugePrimaryColor="#171717" gaugeSecondaryColor="#e5e5e5"/>}'
      if (!document.demo && document.slug === "motion-infinite-slider")
        document.demo = 'import {InfiniteSlider} from "./component";export default function Demo(){return <InfiniteSlider><div className="rounded-xl bg-neutral-100 p-8">设计</div><div className="rounded-xl bg-neutral-900 p-8 text-white">组件</div><div className="rounded-xl bg-neutral-100 p-8">复用</div></InfiniteSlider>}'
      const html = await makePreview(document, 30000)
      await verifyPreview(html)
      const result = await api("/api/sync/publish", "POST", { candidateId: candidate.id, document, previewGzip: gzipSync(html).toString("base64") })
      if (result.status === "imported") {
        imported++
        importedBySource[candidate.id.split(":")[0]]++
      }
      else skipped++
      // 正常读取入口校验已写入的版本，服务更新边界另提供读回工具。
      console.log(JSON.stringify({ event: "published", slug: document.slug, ...result }))
    } catch (error) {
      failed++
      await api("/api/sync/reject", "POST", { candidateId: candidate.id, reason: error.message.slice(0, 1000) })
      console.error(JSON.stringify({ event: "candidate_failed", candidate: candidate.id, error: error.message }))
    }
  }
  const sourceLimits = Object.fromEntries(Object.entries(targets).map(([repository, target]) => [repository, Math.max(0, target - importedBySource[repository])]))
  if (processed >= 30 || Object.values(sourceLimits).every(remaining => remaining === 0)) break
  discovery = await api("/api/sync/run", "POST", { githubToken: process.env.GITHUB_TOKEN, sourceLimits, excludeCandidateIds: attempted })
  sourceFailures += discovery.failures.length
  console.log(JSON.stringify({ event: "refill", ...discovery }))
}
const readback = await api("/api/sync/status")
await browser.close()
const shortfall = Object.fromEntries(Object.entries(targets).map(([repository, target]) => [repository, Math.max(0, target - importedBySource[repository])]))
console.log(JSON.stringify({ processed, imported, importedBySource, skipped, failed, shortfall, sources: discovery.sources, latestRun: readback.runs[0]?.id }))
if (sourceFailures || Object.values(shortfall).some(remaining => remaining > 0)) process.exitCode = 1
