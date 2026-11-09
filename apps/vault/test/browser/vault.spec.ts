import { test, expect } from "@playwright/test"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { unzipSync } from "fflate"

test("导入、真实预览、多选、组件集与两种导出", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto("/")
  await page.getByLabel("账号", { exact: true }).fill("admin")
  await page
    .getByLabel("密码", { exact: true })
    .fill("browser-test-password-123")
  await page.getByRole("button", { name: "进入组件库" }).click()
  await expect(
    page.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "添加内置示例", exact: true }).click()
  await expect(page.locator(".component-card")).toHaveCount(4)
  await expect(page.locator(".mini-preview iframe")).toHaveCount(4, {
    timeout: 20000,
  })
  await page.screenshot({
    path: "test-results/library-1440.png",
    fullPage: true,
  })
  const stylesheet = (await readdir("dist/assets")).find((file) =>
    file.endsWith(".css"),
  )!
  const css = await readFile(`dist/assets/${stylesheet}`, "utf8")
  const snapshot = (await page.content())
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, `<style>${css}</style>`)
  await writeFile("test-results/inspection.html", snapshot)
  await page
    .getByRole("button", { name: "预览紧凑数据表格", exact: true })
    .click()
  const frame = page.frameLocator('iframe[title="紧凑数据表格实时预览"]')
  await expect(frame.getByRole("table")).toBeVisible()
  await expect(frame.getByRole("button", { name: "金额 ↑" })).toBeVisible()
  await frame.getByRole("button", { name: "金额 ↑" }).click()
  await expect(frame.getByRole("button", { name: "金额 ↓" })).toBeVisible()
  await page.screenshot({
    path: "test-results/preview-1440.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "加入选择", exact: true }).click()
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("button", { name: "选择页码分页", exact: true }).click()
  await expect(page.locator(".selection-bar")).toContainText("已选 2 个组件")
  await page.getByRole("button", { name: "保存组件集", exact: true }).click()
  await page.getByLabel("组件集名称").fill("浏览器验收组件集")
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存组件集", exact: true })
    .click()
  await expect(page.getByRole("status")).toContainText("组件集已保存")
  await page.getByRole("button", { name: "导出给 Agent", exact: true }).click()
  const promptDownload = page.waitForEvent("download")
  await page.getByRole("button", { name: "提示词文件" }).click()
  const promptFile = await (await promptDownload).path()
  expect(await readFile(promptFile!, "utf8")).toContain(
    "export default function DataTable",
  )
  const zipDownload = page.waitForEvent("download")
  await page.getByRole("button", { name: "源码 ZIP" }).click()
  const zipFile = await (await zipDownload).path()
  const zip = unzipSync(await readFile(zipFile!))
  expect(Object.keys(zip)).toContain("manifest.json")
  expect(Object.keys(zip)).toContain("components/compact-table/table.tsx")
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("button", { name: "导入组件", exact: true }).click()
  await page.getByLabel("组件名称", { exact: true }).fill("验收按钮")
  await page.getByLabel("唯一标识", { exact: true }).fill("browser-button")
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导入组件", exact: true })
    .click()
  await expect(page.locator(".component-card")).toHaveCount(5)
  await page.getByRole("button", { name: "预览验收按钮", exact: true }).click()
  await expect(
    page
      .frameLocator('iframe[title="验收按钮实时预览"]')
      .getByRole("button", { name: "保存修改" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.screenshot({
    path: "test-results/library-768.png",
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: "test-results/library-390.png",
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole("button", { name: "导出给 Agent", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "导出给 Agent" }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        document.querySelector("dialog")!.scrollWidth <=
        document.querySelector("dialog")!.clientWidth,
    ),
  ).toBe(true)
  expect(errors).toEqual([])
})
