import { gzipSync } from "node:zlib"
import { makePreview } from "../server/preview.mjs"
import { validateComponent } from "../server/model.mjs"
import { chromium } from "@playwright/test"

const origin = new URL(process.env.VAULT_SITE_URL).origin
const token = process.env.VAULT_SITE_SERVICE_TOKEN
const maxAttempts = Number(process.env.VAULT_SYNC_MAX_ATTEMPTS || 60)
if (!Number.isInteger(maxAttempts) || maxAttempts < 9 || maxAttempts > 100) throw new Error("VAULT_SYNC_MAX_ATTEMPTS 必须是 9–100 的整数")
if (!token) throw new Error("缺少 VAULT_SITE_SERVICE_TOKEN")
if (!origin.startsWith("https://")) throw new Error("VAULT_SITE_URL 必须使用 HTTPS")
async function api(path, method = "GET", body) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(120000), headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${token}`, "X-Vault-Service-Token": token }, body: body === undefined ? undefined : JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw new Error(`${path} HTTP ${response.status}，站点服务访问失败`) }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${value.error || "请求失败"}`)
  return value
}
// 每日维护只写候选区，由管理员在网页确认后入库。
const discovery = await api("/api/sync/run", "POST", { githubToken: process.env.GITHUB_TOKEN })
console.log(JSON.stringify({ event: "discovered", ...discovery }))
let processed = 0
let failed = 0
let prepared = 0
let skipped = 0
const preparedBySource = Object.fromEntries(discovery.sources.map(source => [source.repository, 0]))
const attempted = []
const sourceFailures = discovery.failures.length
const demos = {
  "magic-animated-circular-progress-bar": 'import {AnimatedCircularProgressBar} from "./component";export default function Demo(){return <AnimatedCircularProgressBar max={100} min={0} value={65} gaugePrimaryColor="#171717" gaugeSecondaryColor="#e5e5e5"/>}',
  "motion-infinite-slider": 'import {InfiniteSlider} from "./component";export default function Demo(){return <InfiniteSlider><div className="rounded-xl bg-neutral-100 p-8">设计</div><div className="rounded-xl bg-neutral-900 p-8 text-white">组件</div><div className="rounded-xl bg-neutral-100 p-8">复用</div></InfiniteSlider>}',
  "motion-in-view": 'import {InView} from "./component";export default function Demo(){return <InView><div className="rounded-xl bg-neutral-100 p-8">进入视口，内容渐入</div></InView>}',
  "motion-progressive-blur": 'import {ProgressiveBlur} from "./component";export default function Demo(){return <div style={{position:"relative",width:320,height:160}}><p className="p-6 text-xl">渐进模糊，让内容自然过渡。</p><ProgressiveBlur className="absolute inset-0"/></div>}',
  "motion-text-effect": 'import {TextEffect} from "./component";export default function Demo(){return <TextEffect per="char" preset="fade-in-blur">为下一个项目，留下好设计。</TextEffect>}',
  "magic-cool-mode": 'import {CoolMode} from "./component";export default function Demo(){return <CoolMode><button className="rounded-lg bg-neutral-900 px-6 py-3 text-white">点击释放粒子</button></CoolMode>}',
}
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
if (discovery.candidateIds.length) {
  const items = []
  for (let offset = 0; offset < discovery.candidateIds.length; offset += 10) {
    const query = new URLSearchParams(discovery.candidateIds.slice(offset, offset + 10).map(id => ["id", id]))
    items.push(...(await api(`/api/sync/candidates?${query}`)).items)
  }
  if (items.length !== discovery.candidateIds.length) throw new Error("本轮候选读取不完整，请检查同步状态")
  for (const candidate of items) {
    if (processed >= maxAttempts) break
    processed++
    attempted.push(candidate.id)
    try {
      const document = validateComponent(JSON.parse(candidate.document), 1048576)
      // shadcn 源仓库以工作区包 cn 提供工具函数，导出包使用现有本地工具文件。
      if (candidate.id.startsWith("shadcn-ui/ui:")) {
        document.files = document.files.map(file => file.path === "component.tsx" ? { ...file, content: file.content.replace(/from (["'])cn\1/g, 'from "@/lib/utils"') } : file)
        delete document.dependencies.cn
        document.dependencies.clsx = "2.1.1"
        document.dependencies["tailwind-merge"] = "2.6.0"
      }
      document.demo ||= demos[document.slug] || ""
      const html = await makePreview(document, 30000)
      await verifyPreview(html)
      const result = await api("/api/sync/prepare", "POST", { candidateId: candidate.id, document, previewGzip: gzipSync(html).toString("base64") })
      if (result.status === "prepared") {
        prepared++
        preparedBySource[candidate.id.split(":")[0]]++
      }
      else skipped++
      // 正常读取入口校验已写入的版本，服务更新边界另提供读回工具。
      console.log(JSON.stringify({ event: "prepared", slug: document.slug, ...result }))
    } catch (error) {
      failed++
      await api("/api/sync/reject", "POST", { candidateId: candidate.id, reason: error.message.slice(0, 1000) })
      console.error(JSON.stringify({ event: "candidate_failed", candidate: candidate.id, error: error.message }))
    }
  }
}
await browser.close()
const unprocessed = discovery.candidateIds.filter(id => !attempted.includes(id)).length
await api("/api/sync/report", "POST", { runId: discovery.runId, processed, prepared, failed, sourceFailures, skipped, unprocessed })
const readback = await api("/api/sync/status")
console.log(JSON.stringify({ processed, prepared, preparedBySource, skipped, failed, sources: discovery.sources, latestRun: readback.runs[0]?.id }))
// 候选数量不足允许成功，依赖故障、预览失败和验证预算耗尽仍须显式失败。
if (sourceFailures || failed || unprocessed) process.exitCode = 1
