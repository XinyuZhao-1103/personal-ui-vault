import { test, expect, type Page } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"

const adminPassword = "browser-test-password-123"
const visitorPassword = "visitor-browser-test-123"
const origin = "http://localhost:14312"

async function login(page: Page, username: string, password: string) {
  await page.goto("/")
  await page.getByLabel("账号", { exact: true }).fill(username)
  await page.getByLabel("密码", { exact: true }).fill(password)
  await page.getByRole("button", { name: "进入组件库", exact: true }).click()
}

async function settings(page: Page, tab?: string) {
  await page.getByRole("button", { name: "账号与安全", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "账号与安全", exact: true }),
  ).toBeVisible()
  if (tab) await page.getByRole("button", { name: tab, exact: true }).click()
}

async function request(
  page: Page,
  path: string,
  method = "GET",
  data?: unknown,
) {
  return page.request.fetch(path, {
    method,
    data,
    headers: { Origin: origin },
  })
}

test("账号角色、用户管理、登录日志与会话撤销", async ({ page, browser }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mkdir("work/auth-verification", { recursive: true })
  await page.goto("/")
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 })
    await page.screenshot({
      path: `work/auth-verification/login-${width}.png`,
      fullPage: true,
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await login(page, "admin", "incorrect-password-123")
  await expect(page.getByRole("alert")).toContainText("账号或密码不正确")
  await login(page, "admin", adminPassword)
  await expect(
    page.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  const session = await (await request(page, "/api/session")).json()
  expect(session.user.role).toBe("admin")
  for (const data of [{ role: "visitor" }, { status: "disabled" }]) {
    const response = await request(
      page,
      `/api/admin/users/${session.user.id}`,
      "PATCH",
      data,
    )
    expect(response.status()).toBe(409)
  }
  await request(page, "/api/examples", "POST", {})
  await settings(page, "用户管理")
  await page.getByRole("button", { name: "创建用户", exact: true }).click()
  const editor = page.getByRole("region", { name: "创建用户", exact: true })
  await editor.getByLabel("账号", { exact: true }).fill("browser.visitor")
  await editor.getByLabel("显示名称").fill("浏览器验收访客")
  await editor.getByLabel("初始密码").fill(visitorPassword)
  await editor.getByRole("button", { name: "创建用户", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("用户设置已保存")
  let row = page.getByRole("row").filter({ hasText: "browser.visitor" })
  await expect(row).toContainText("访客")
  await row.getByRole("button", { name: "编辑", exact: true }).click()
  await page.getByLabel("显示名称").fill("只读浏览器访客")
  await page.getByRole("button", { name: "保存修改", exact: true }).click()
  await expect(row).toContainText("只读浏览器访客")
  const users = await (await request(page, "/api/admin/users?size=20")).json()
  const visitor = users.items.find(
    (user: { username: string }) => user.username === "browser.visitor",
  )
  expect(visitor.hasPassword).toBe(true)
  expect(visitor.password).toBeUndefined()
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 })
    await page.screenshot({
      path: `work/auth-verification/users-${width}.png`,
      fullPage: true,
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  const visitorContext = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 960 },
  })
  const visitorPage = await visitorContext.newPage()
  visitorPage.on("pageerror", (error) => errors.push(error.message))
  await login(visitorPage, "browser.visitor", visitorPassword)
  await expect(
    visitorPage.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  await expect(
    visitorPage.getByRole("button", { name: "导入组件", exact: true }),
  ).toHaveCount(0)
  await expect(
    visitorPage.getByRole("button", { name: "添加内置示例", exact: true }),
  ).toHaveCount(0)
  expect((await request(visitorPage, "/api/admin/users")).status()).toBe(403)
  expect((await request(visitorPage, "/api/admin/login-logs")).status()).toBe(
    403,
  )
  expect(
    (await request(visitorPage, "/api/components", "POST", {})).status(),
  ).toBe(403)
  await visitorPage
    .getByRole("button", { name: "预览紧凑数据表格", exact: true })
    .click()
  await expect(
    visitorPage
      .frameLocator('iframe[title="紧凑数据表格实时预览"]')
      .getByRole("table"),
  ).toBeVisible()
  await expect(
    visitorPage.getByRole("button", { name: "编辑新版本", exact: true }),
  ).toHaveCount(0)
  await visitorPage
    .getByRole("button", { name: "加入选择", exact: true })
    .click()
  await visitorPage.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(
    visitorPage.getByRole("button", { name: "保存组件集", exact: true }),
  ).toHaveCount(0)
  await visitorPage
    .getByRole("button", { name: "导出给 Agent", exact: true })
    .click()
  const downloading = visitorPage.waitForEvent("download")
  await visitorPage
    .getByRole("button", { name: "提示词文件" })
    .click()
  expect((await downloading).suggestedFilename()).toBe("AGENT.md")
  await visitorPage.getByRole("button", { name: "关闭", exact: true }).click()
  await settings(visitorPage)
  await expect(
    visitorPage.getByRole("button", { name: "用户管理", exact: true }),
  ).toHaveCount(0)
  await expect(
    visitorPage.getByRole("button", { name: "登录日志", exact: true }),
  ).toHaveCount(0)
  await visitorPage.screenshot({
    path: "work/auth-verification/visitor-account-1440.png",
    fullPage: true,
  })
  row = page.getByRole("row").filter({ hasText: "browser.visitor" })
  await row.getByRole("button", { name: "重置密码", exact: true }).click()
  await page
    .getByLabel("新密码", { exact: true })
    .fill("visitor-reset-browser-123")
  await page.getByRole("button", { name: "确认重置密码", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("用户设置已保存")
  expect((await request(visitorPage, "/api/components")).status()).toBe(401)
  await visitorPage.reload()
  await expect(
    visitorPage.getByRole("heading", { name: "登录拾 UI", exact: true }),
  ).toBeVisible()
  await login(visitorPage, "browser.visitor", "visitor-reset-browser-123")
  await expect(
    visitorPage.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  await settings(visitorPage)
  await visitorPage
    .getByLabel("当前密码", { exact: true })
    .fill("incorrect-current-password-123")
  await visitorPage
    .getByLabel("新密码", { exact: true })
    .fill("visitor-new-browser-123")
  await visitorPage
    .getByLabel("再次输入新密码", { exact: true })
    .fill("visitor-new-browser-123")
  await visitorPage
    .getByRole("button", { name: "保存密码并重新登录", exact: true })
    .click()
  await expect(visitorPage.getByRole("alert")).toBeVisible()
  await expect(visitorPage.getByRole("heading", { name: "账号与安全", exact: true })).toBeVisible()
  expect((await (await request(visitorPage, "/api/session")).json()).authenticated).toBe(true)
  await visitorPage
    .getByLabel("当前密码", { exact: true })
    .fill("visitor-reset-browser-123")
  await visitorPage
    .getByLabel("新密码", { exact: true })
    .fill("visitor-new-browser-123")
  await visitorPage
    .getByLabel("再次输入新密码", { exact: true })
    .fill("visitor-new-browser-123")
  await visitorPage
    .getByRole("button", { name: "保存密码并重新登录", exact: true })
    .click()
  await expect(
    visitorPage.getByRole("heading", { name: "登录拾 UI", exact: true }),
  ).toBeVisible()
  await login(visitorPage, "browser.visitor", "visitor-new-browser-123")
  await expect(
    visitorPage.getByRole("heading", { name: "组件库", exact: true }),
  ).toBeVisible()
  row = page.getByRole("row").filter({ hasText: "browser.visitor" })
  await row.getByRole("button", { name: "编辑", exact: true }).click()
  await page.getByLabel("账号状态").selectOption("disabled")
  await page.getByRole("button", { name: "保存修改", exact: true }).click()
  await expect(row).toContainText("已禁用")
  await visitorPage.reload()
  await expect(
    visitorPage.getByRole("heading", { name: "登录拾 UI", exact: true }),
  ).toBeVisible()
  await login(visitorPage, "browser.visitor", "visitor-new-browser-123")
  await expect(visitorPage.getByRole("alert")).toContainText("账号或密码不正确")
  await page.getByRole("button", { name: "登录日志", exact: true }).click()
  await expect(page.getByRole("table")).toContainText("browser.visitor")
  await expect(page.getByRole("table")).toContainText("失败")
  await expect(page.getByRole("table")).toContainText("成功")
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 })
    await page.screenshot({
      path: `work/auth-verification/login-logs-${width}.png`,
      fullPage: true,
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  expect(errors).toEqual([])
  await writeFile(
    "work/auth-verification/browser-result.json",
    JSON.stringify(
      {
        status: "passed",
        browser: "Microsoft Edge",
        viewportWidths: [1440, 768, 390],
        checks: [
          "账号密码登录与错误密码",
          "最后管理员保护",
          "管理员创建与编辑访客",
          "访客权限与预览导出",
          "管理接口拒绝访客",
          "重置密码撤销旧会话",
          "本人修改密码与重新登录",
          "当前密码错误时保留有效会话",
          "禁用用户撤销会话并拒绝登录",
          "登录日志成功与失败记录",
          "页面无横向溢出",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  await visitorContext.close()
})
