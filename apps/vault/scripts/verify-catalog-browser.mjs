import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, expect } from "@playwright/test"
import { loadConfig } from "../server/config.mjs"

const config = loadConfig()
const sourceData = JSON.parse(
  await readFile(new URL("../catalog/sources.json", import.meta.url), "utf8"),
)
const output = path.resolve("work/catalog-verification")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const results = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(config.origin)
  await page.getByLabel("管理员密码").fill(config.password)
  await page.getByRole("button", { name: "进入组件库", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  for (const selected of sourceData.components) {
    const slug = selected.slug
    const metadata = JSON.parse(
      await readFile(
        new URL(`../catalog/${slug}/component.json`, import.meta.url),
        "utf8",
      ),
    )
    await page.getByLabel("搜索组件", { exact: true }).fill(slug)
    await expect(page.locator(".component-card")).toHaveCount(1, {
      timeout: 20000,
    })
    await page
      .getByRole("button", { name: `预览${metadata.name}`, exact: true })
      .click()
    const frame = page.frameLocator(`iframe[title="${metadata.name}实时预览"]`)
    await expect(frame.locator("#root > *").first()).toBeVisible({
      timeout: 30000,
    })
    await expect(page.locator(".preview-well .error")).toHaveCount(0)
    if (slug === "shadcn-table") {
      await frame.getByRole("button", { name: /金额/ }).click()
      await expect(frame.getByRole("button", { name: "金额 ↓" })).toBeVisible()
    }
    if (slug === "shadcn-pagination") {
      await frame.getByRole("link", { name: "2", exact: true }).click()
      await expect(frame.getByText("演示数据 · 第 2 / 5 页")).toBeVisible()
    }
    if (slug === "magic-ripple-button") {
      await frame.getByRole("button", { name: "体验涟漪效果" }).click()
      await expect(
        frame.getByText("已点击 1 次 · 支持快速连续点击"),
      ).toBeVisible()
      await expect(frame.locator(".animate-rippling")).toHaveCount(1)
      await expect(frame.locator(".animate-rippling")).toHaveCount(0, {
        timeout: 3000,
      })
    }
    if (slug === "magic-subscribe-button") {
      await frame.getByRole("button", { name: "订阅组件更新 →" }).click()
      await expect(
        frame.getByRole("button", { name: "✓ 已订阅" }),
      ).toBeVisible()
    }
    if (slug === "motion-transition-panel") {
      await frame.getByRole("button", { name: "开发", exact: true }).click()
      await expect(
        frame.getByRole("heading", { name: "复用已经认可的源码" }),
      ).toBeVisible()
    }
    if (slug === "motion-text-scramble") {
      await expect(
        frame.getByText("Design with intention.", { exact: true }),
      ).toBeVisible({ timeout: 5000 })
      await frame.getByRole("button", { name: "重新播放" }).click()
      await expect(
        frame.getByText("Design with intention.", { exact: true }),
      ).toBeVisible({ timeout: 5000 })
    }
    if (slug === "magic-floating-particles") {
      await expect(frame.locator("canvas")).toBeVisible()
      expect(
        await frame
          .locator("canvas")
          .evaluate((canvas) => canvas.width > 0 && canvas.height > 0),
      ).toBe(true)
    }
    const canvases = await frame.locator("canvas").count()
    if (slug === "magic-dither-field")
      await frame.getByRole("button", { name: "glow", exact: true }).click()
    await page.screenshot({ path: path.join(output, `${slug}-browser.png`) })
    await page.getByRole("button", { name: "加入选择", exact: true }).click()
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    results.push({ slug, preview: "rendered", canvases })
    console.log(`浏览器通过 ${slug}`)
  }
  expect(errors).toEqual([])
  await expect(page.locator(".selection-bar")).toContainText("已选 10 个组件")
  await page.getByRole("button", { name: "导出给 Agent", exact: true }).click()
  const downloadEvent = page.waitForEvent("download")
  await page.getByRole("button", { name: "源码 ZIP" }).click()
  const download = await downloadEvent
  await download.saveAs(path.join(output, "website-curated-components.zip"))
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("button", { name: "组件集", exact: true }).click()
  await expect(page.locator(".kit-card")).toHaveCount(3)
  await page.screenshot({ path: path.join(output, "source-kits-browser.png") })
  await page.getByRole("button", { name: "全部组件", exact: true }).click()
  await page.getByLabel("搜索组件", { exact: true }).fill("")
  await expect(page.locator(".component-card")).toHaveCount(12)
  await page.screenshot({
    path: path.join(output, "curated-library-browser.png"),
    fullPage: true,
  })
  await writeFile(
    path.join(output, "browser-result.json"),
    JSON.stringify({ results, errors, export: "downloaded" }, null, 2),
  )
  console.log(
    JSON.stringify({
      rendered: results.length,
      errors: errors.length,
      sourceKits: 3,
      export: "downloaded",
    }),
  )
} finally {
  await browser.close()
}
