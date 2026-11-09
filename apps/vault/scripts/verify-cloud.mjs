import assert from "node:assert/strict"
import { chromium, expect } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.VAULT_TEST_URL || "http://127.0.0.1:14320"
const api = async (path, method = "GET", body, headers = {}) => {
  const response = await fetch(base + path, { method, headers: { Origin: base, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, value: await response.json() }
}
assert.equal((await api("/api/health")).status, 200)
const seed = await api("/api/catalog/bootstrap", "POST", {})
assert.ok(seed.value.total >= 10)
assert.equal((await api("/api/catalog/bootstrap", "POST", {})).value.imported, 0)
assert.equal((await api("/api/components?size=101")).status, 400)
const source = (await api("/api/components?q=shadcn-button")).value.items.find(item => item.slug === "shadcn-button")
const original = (await api(`/api/components/${source.id}`)).value
const document = { ...original, slug: `cloud-probe-${Date.now()}`, name: "云端编译验证", demo: "import {Button} from './component';export default function Demo(){return <Button className='bg-green-600 text-white' onClick={e=>e.currentTarget.textContent='已验证'}>云端按钮</Button>}" }
const created = (await api("/api/components", "POST", document)).value
assert.equal((await api("/api/components", "POST", document)).status, 409)
assert.equal((await api("/api/components", "POST", { ...document, slug: document.slug + "-origin" }, { Origin: "https://invalid.test" })).status, 403)
const kit = (await api("/api/kits", "POST", { name: "云端快照验证", selection: [{ id: created.id, revision: 1 }] })).value
const updated = { ...document, description: "并发更新验证", expectedRevision: 1 }
const races = await Promise.all([api(`/api/components/${created.id}`, "PUT", updated), api(`/api/components/${created.id}`, "PUT", updated)])
assert.deepEqual(races.map(result => result.status).sort(), [200, 409])
assert.equal((await api(`/api/kits/${kit.id}`)).value.items[0].revision, 1)
assert.equal((await api(`/api/components/${created.id}/versions`)).value.length, 2)
assert.ok((await api("/api/export", "POST", { selection: [{ id: created.id }], format: "prompt" })).value.text.includes("云端编译验证"))
const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(base)
  await page.getByLabel("搜索组件", { exact: true }).fill(document.slug)
  await expect(page.locator(".component-card")).toHaveCount(1)
  await page.getByRole("button", { name: "预览云端编译验证", exact: true }).click()
  const frame = page.frameLocator('iframe[title="云端编译验证实时预览"]')
  await expect(frame.getByRole("button", { name: "云端按钮", exact: true })).toBeVisible({ timeout: 45000 })
  await expect(frame.getByRole("button", { name: "云端按钮", exact: true })).toHaveCSS("background-color", "oklch(0.627 0.194 149.214)", { timeout: 10000 })
  await frame.getByRole("button", { name: "云端按钮", exact: true }).click()
  await expect(frame.getByRole("button", { name: "已验证", exact: true })).toBeVisible()
  await mkdir("work/cloud-verification", { recursive: true })
  await page.screenshot({ path: "work/cloud-verification/browser.png" })
  assert.deepEqual(errors, [])
  await writeFile("work/cloud-verification/result.json", JSON.stringify({ database: "passed", concurrency: "passed", fixedKitRevision: "passed", browserCompiler: "passed", interactions: "passed", errors }, null, 2))
  console.log("云端持久化、重复导入、分页上限、来源校验、版本并发、快照、提示词和浏览器编译交互通过")
} finally { await browser.close() }
