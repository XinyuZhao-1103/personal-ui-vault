import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import worker from "../cloud/worker.mjs"
import { identityDatabase } from "../server/identity-db.mjs"
import { examples } from "../server/examples.mjs"

const origin = "https://vault.example.test"
const adminPassword = "cloud-admin-password-123"
const visitorPassword = "cloud-visitor-password-123"
const serviceToken = "cloud-test-service-key-1234567890123456789"

function fixture() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  for (const migration of ["0000_cloud_vault.sql", "0001_identity.sql"])
    sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), "utf8"))
  const env = {
    DB: identityDatabase(sqlite),
    VAULT_PASSWORD: adminPassword,
    VAULT_AUDIT_HASH_KEY: "cloud-test-audit-key-1234567890123456789",
    VAULT_SERVICE_TOKEN: serviceToken,
    ASSETS: { fetch: async () => new Response("静态资源", { status: 200 }) },
    BUCKET: { get: async () => null },
  }
  async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
    return worker.fetch(new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env)
  }
  async function login(username, password) {
    const response = await call("/api/login", { method: "POST", body: { username, password } })
    assert.equal(response.status, 200, await response.clone().text())
    return response.headers.get("set-cookie").split(";")[0]
  }
  return { sqlite, call, login }
}

test("云端真实入口的匿名、访客、管理员与服务访问边界", async t => {
  const { sqlite, call, login } = fixture()
  t.after(() => sqlite.close())

  await t.test("匿名只能取得健康与未登录状态，伪造平台身份不能登录", async () => {
    assert.equal((await call("/api/health")).status, 200)
    const session = await (await call("/api/session")).json()
    assert.equal(session.authenticated, false)
    assert.equal(session.user, null)
    assert.deepEqual(session.providers, [])
    assert.equal((await call("/api/components")).status, 401)
    assert.equal((await call("/previews/shadcn-button.html")).status, 401)
    assert.equal((await call("/api/components", { headers: {
      "oai-authenticated-user-id": "forged-owner",
      "oai-authenticated-user-email": "owner@example.test",
    } })).status, 401)
    for (const [path, method] of [
      ["/api/sync/status", "GET"],
      ["/api/sync/run", "POST"],
      ["/api/catalog/bootstrap", "POST"],
      ["/mcp", "POST"],
    ]) assert.equal((await call(path, { method, body: method === "POST" ? {} : undefined })).status, 401, path)
  })

  const adminCookie = await login("admin", adminPassword)
  const createdUser = await call("/api/admin/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "visitor", displayName: "测试访客", password: visitorPassword, role: "visitor" },
  })
  assert.equal(createdUser.status, 201, await createdUser.clone().text())
  const createdComponent = await call("/api/components", { method: "POST", cookie: adminCookie, body: examples[0] })
  assert.equal(createdComponent.status, 201, await createdComponent.clone().text())
  const component = await createdComponent.json()
  const visitorCookie = await login("visitor", visitorPassword)

  await t.test("访客可读取、预览与实际导出，输入校验仍生效", async () => {
    const listed = await call("/api/components", { cookie: visitorCookie })
    const previewAsset = await call("/previews/shadcn-button.html", { cookie: visitorCookie })
    assert.equal(previewAsset.status, 200)
    assert.equal(previewAsset.headers.get("cache-control"), "no-store")
    assert.equal(listed.status, 200)
    assert.equal((await listed.json()).items[0].id, component.id)
    assert.equal((await call(`/api/components/${component.id}`, { cookie: visitorCookie })).status, 200)
    assert.equal((await call("/api/preview", { method: "POST", cookie: visitorCookie, body: { id: component.id } })).status, 200)
    const selection = [{ id: component.id }]
    assert.equal((await call("/api/export/check", { method: "POST", cookie: visitorCookie, body: { selection } })).status, 200)
    const exported = await call("/api/export", { method: "POST", cookie: visitorCookie, body: { selection, format: "prompt" } })
    assert.equal(exported.status, 200)
    assert.match((await exported.json()).text, /轻量操作按钮/)
    for (const path of ["/api/export", "/api/export/check"])
      assert.equal((await call(path, { method: "POST", cookie: visitorCookie, body: { selection: [] } })).status, 400, path)
  })

  await t.test("访客不能维护资产、管理账号、Token 或调用同步服务", async () => {
    for (const [path, method] of [
      ["/api/components", "POST"],
      [`/api/components/${component.id}`, "PUT"],
      ["/api/import/registry", "POST"],
      ["/api/examples", "POST"],
      ["/api/kits", "POST"],
      ["/api/tokens", "GET"],
      ["/api/tokens", "POST"],
      ["/api/tokens/missing", "DELETE"],
      ["/api/admin/users", "GET"],
      ["/api/admin/login-logs", "GET"],
      ["/api/sync/status", "GET"],
      ["/api/sync/run", "POST"],
      ["/api/catalog/bootstrap", "POST"],
      ["/mcp", "POST"],
    ]) {
      const response = await call(path, { method, cookie: visitorCookie, body: method === "GET" ? undefined : {} })
      assert.equal(response.status, 403, `${method} ${path}`)
    }
  })

  await t.test("管理员读取设置与同步状态，跨源写入被拒绝", async () => {
    for (const path of ["/api/admin/users", "/api/admin/login-logs", "/api/tokens", "/api/sync/status"])
      assert.equal((await call(path, { cookie: adminCookie })).status, 200, path)
    assert.equal((await call("/api/components", {
      method: "POST", cookie: adminCookie, body: examples[1], headers: { Origin: "https://evil.example.test" },
    })).status, 403)
    assert.equal((await call("/api/export/check", {
      method: "POST", cookie: visitorCookie, body: { selection: [{ id: component.id }] }, headers: { Origin: "https://evil.example.test" },
    })).status, 403)
    assert.equal((await call("/api/admin/users", {
      method: "POST", cookie: adminCookie, body: {}, headers: { Origin: "https://evil.example.test" },
    })).status, 403)
  })

  await t.test("独立服务密钥仅开放指定服务路径", async () => {
    const headers = { "x-vault-service-token": serviceToken }
    assert.equal((await call("/api/sync/status", { headers })).status, 200)
    assert.equal((await call("/api/sync/status", { headers: { "x-vault-service-token": "wrong-service-key" } })).status, 401)
    for (const path of ["/api/components", "/api/admin/users", "/api/tokens"])
      assert.equal((await call(path, { headers })).status, 401, path)
    const session = await (await call("/api/session", { headers })).json()
    assert.equal(session.authenticated, false)
  })
})
