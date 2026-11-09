import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { createIdentity } from "../server/identity.mjs"

function database() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  sqlite.exec(readFileSync(new URL("../drizzle/0001_identity.sql", import.meta.url), "utf8"))
  const prepare = sql => ({ bind: (...args) => ({
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => {
      if (!/^\s*SELECT/i.test(sql)) throw new Error("不是查询")
      return { results: sqlite.prepare(sql).all(...args) }
    },
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  }) })
  let pending = Promise.resolve()
  return { sqlite, prepare, batch(statements) {
    // D1 在同一数据库串行提交事务，读操作仍可在事务之间并发。
    const completed = pending.then(async () => {
      sqlite.exec("BEGIN IMMEDIATE")
      try {
        const result = []
        for (const statement of statements) {
          try { result.push(await statement.all()) }
          catch { result.push(await statement.run()) }
        }
        sqlite.exec("COMMIT")
        return result
      } catch (error) { sqlite.exec("ROLLBACK"); throw error }
    })
    pending = completed.catch(() => {})
    return completed
  } }
}

function fixture(overrides = {}) {
  const db = database()
  const config = { bootstrapUsername: "admin", bootstrapPassword: "test-password-123", auditHashKey: "test-audit-secret", passwordIterations: 10000, origin: "http://localhost", maxPageSize: 48, ...overrides }
  const identity = createIdentity({ db, config })
  async function call(path, method = "GET", body, cookie, headers = {}) {
    const request = new Request(`http://localhost${path}`, { method, headers: { Origin: "http://localhost", "cf-connecting-ip": "127.0.0.1", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    try { return await identity.handle(request) }
    catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }) }
  }
  async function login(username = "admin", password = "test-password-123") {
    const response = await call("/api/login", "POST", { username, password })
    assert.equal(response.status, 200, await response.clone().text())
    return response.headers.get("set-cookie").split(";")[0]
  }
  return { db, identity, call, login }
}

test("身份登录持久化、角色边界、分页及脱敏日志", async () => {
  const { db, call, login, identity } = fixture()
  assert.equal((await (await call("/api/session")).json()).authenticated, false)
  const adminCookie = await login()
  const session = await (await call("/api/session", "GET", undefined, adminCookie)).json()
  assert.equal(session.user.role, "admin")
  assert.equal(session.user.hasPassword, true)
  assert.equal("password_hash" in session.user, false)
  assert.equal((await call("/api/login", "POST", { username: "admin", password: "wrong" })).status, 401)
  assert.equal((await call("/api/login", "POST", { password: "test-password-123" }, undefined, { Origin: "https://evil.invalid" })).status, 403)
  const created = await call("/api/admin/users", "POST", { username: "visitor", displayName: "访客", password: "visitor-password-123", role: "visitor" }, adminCookie)
  assert.equal(created.status, 201)
  const visitor = await created.json()
  const visitorCookie = await login("visitor", "visitor-password-123")
  assert.equal((await call("/api/admin/users", "GET", undefined, visitorCookie)).status, 403)
  assert.equal((await call("/api/admin/users?size=100", "GET", undefined, adminCookie)).status, 400)
  assert.equal((await (await call("/api/admin/users?page=1&size=1", "GET", undefined, adminCookie)).json()).items.length, 1)
  assert.equal((await (await call("/api/admin/users?page=3&size=1", "GET", undefined, adminCookie)).json()).items.length, 0)
  assert.equal((await call("/api/admin/users", "POST", { username: "visitor", displayName: "重复", password: "visitor-password-123" }, adminCookie)).status, 409)
  const logs = await (await call("/api/admin/login-logs", "GET", undefined, adminCookie)).json()
  assert.equal(logs.items.some(item => item.reason === "账号或密码不正确"), true)
  assert.equal(logs.items.every(item => item.ipHash.length === 64), true)
  assert.equal(JSON.stringify(logs).includes("test-password"), false)
  await identity.ensureBootstrap()
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM identity_users").get().n, 2)
  await call(`/api/admin/users/${visitor.id}`, "PATCH", { status: "disabled" }, adminCookie)
  assert.equal((await (await call("/api/session", "GET", undefined, visitorCookie)).json()).authenticated, false)
  assert.equal((await call("/api/login", "POST", { username: "visitor", password: "visitor-password-123" })).status, 401)
  db.sqlite.close()
})

test("最后管理员保护、重置密码及会话撤销", async () => {
  const { db, call, login } = fixture()
  let adminCookie = await login()
  assert.equal((await call("/api/admin/users/bootstrap-admin", "PATCH", { role: "visitor" }, adminCookie)).status, 409)
  assert.equal((await call("/api/admin/users/bootstrap-admin", "PATCH", { status: "disabled" }, adminCookie)).status, 409)
  // 拒绝最后管理员变更不应撤销已有有效会话。
  adminCookie = await login()
  const second = await (await call("/api/admin/users", "POST", { username: "second", displayName: "管理员二", password: "second-password-123", role: "admin" }, adminCookie)).json()
  const secondCookie = await login("second", "second-password-123")
  assert.equal((await call(`/api/admin/users/${second.id}/password`, "POST", { password: "updated-password-123" }, adminCookie)).status, 200)
  assert.equal((await (await call("/api/session", "GET", undefined, secondCookie)).json()).authenticated, false)
  assert.equal((await call("/api/login", "POST", { username: "second", password: "second-password-123" })).status, 401)
  const updated = await login("second", "updated-password-123")
  assert.equal((await call("/api/account/password", "POST", { currentPassword: "wrong-password", newPassword: "self-password-123" }, updated)).status, 400)
  assert.equal((await (await call("/api/session", "GET", undefined, updated)).json()).authenticated, true)
  assert.equal((await call("/api/account/password", "POST", { currentPassword: "updated-password-123", newPassword: "self-password-123" }, updated)).status, 200)
  assert.equal((await (await call("/api/session", "GET", undefined, updated)).json()).authenticated, false)
  assert.equal((await call("/api/admin/users/bootstrap-admin", "PATCH", { role: "visitor" }, adminCookie)).status, 200)
  assert.equal((await (await call("/api/session", "GET", undefined, adminCookie)).json()).authenticated, false)
  const lastCookie = await login("second", "self-password-123")
  assert.equal((await call(`/api/admin/users/${second.id}`, "PATCH", { status: "disabled" }, lastCookie)).status, 409)
  db.sqlite.close()
})

test("限流、请求大小上限、未配置初始化拒绝登录", async () => {
  const { db, call } = fixture({ loginMaxAttempts: 2 })
  for (let index = 0; index < 2; index++) assert.equal((await call("/api/login", "POST", { password: "wrong" })).status, 401)
  assert.equal((await call("/api/login", "POST", { password: "test-password-123" })).status, 429)
  assert.equal((await call("/api/login", "POST", { password: "x".repeat(17000) })).status, 413)
  db.sqlite.close()
  const missing = fixture({ bootstrapPassword: undefined })
  assert.equal((await missing.call("/api/login", "POST", { password: "test-password-123" })).status, 401)
  assert.equal(missing.db.sqlite.prepare("SELECT count(*) AS n FROM identity_users").get().n, 0)
  missing.db.sqlite.close()
})

test("幂等迁移、会话数量和过期、注销、日志留存与限流总容量", async () => {
  const { db, identity, call, login } = fixture({ maxSessionsPerUser: 2, loginLogMaxRows: 3 })
  db.sqlite.exec(readFileSync(new URL("../drizzle/0001_identity.sql", import.meta.url), "utf8"))
  const first = await login()
  const second = await login()
  const restarted = createIdentity({ db, config: { origin: "http://localhost" } })
  assert.equal((await restarted.getSession(new Request("http://localhost/api/session", { headers: { Cookie: first } }))).role, "admin")
  await login()
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM identity_sessions").get().n, 2)
  assert.equal((await (await call("/api/session", "GET", undefined, first)).json()).authenticated, false)
  assert.equal((await (await call("/api/session", "GET", undefined, second)).json()).authenticated, true)
  assert.equal((await call("/api/logout", "POST", {}, second)).status, 200)
  assert.equal((await (await call("/api/session", "GET", undefined, second)).json()).authenticated, false)
  db.sqlite.prepare("UPDATE identity_sessions SET expires_at=0").run()
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM identity_login_logs").get().n, 3)
  // 修改部署初始化口令不会覆盖用户库中的既有密码。
  const changed = createIdentity({ db, config: { bootstrapPassword: "a-different-password", passwordIterations: 10000 } })
  await changed.ensureBootstrap()
  assert.equal((await identity.handle(new Request("http://localhost/api/session"))).status, 200)
  await login()
  db.sqlite.close()
  const capped = fixture({ loginRateLimitMaxKeys: 2 })
  assert.equal((await capped.call("/api/login", "POST", { username: "random1", password: "wrong" })).status, 401)
  assert.equal((await capped.call("/api/login", "POST", { username: "random2", password: "wrong" })).status, 429)
  assert.equal(capped.db.sqlite.prepare("SELECT count(*) AS n FROM identity_rate_limits").get().n, 2)
  capped.db.sqlite.close()
})

test("并发降权和禁用始终保留可用管理员", async () => {
  for (const change of [{ role: "visitor" }, { status: "disabled" }]) {
    const { db, call, login } = fixture()
    const firstCookie = await login()
    const second = await (await call("/api/admin/users", "POST", { username: "second", displayName: "管理员二", password: "second-password-123", role: "admin" }, firstCookie)).json()
    const secondCookie = await login("second", "second-password-123")
    const responses = await Promise.all([
      call("/api/admin/users/bootstrap-admin", "PATCH", change, firstCookie),
      call(`/api/admin/users/${second.id}`, "PATCH", change, secondCookie),
    ])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM identity_users WHERE role='admin' AND status='active'").get().n, 1)
    db.sqlite.close()
  }
})

test("并发旧密码登录与管理员重置不会留下有效旧密码会话", async () => {
  const { db, call, login } = fixture()
  const adminCookie = await login()
  const visitor = await (await call("/api/admin/users", "POST", { username: "visitor", displayName: "访客", password: "visitor-password-123", role: "visitor" }, adminCookie)).json()
  let current = "visitor-password-123"
  for (let index = 0; index < 5; index++) {
    const next = `updated-password-${index}`
    const [attempt, reset] = await Promise.all([
      call("/api/login", "POST", { username: "visitor", password: current }),
      call(`/api/admin/users/${visitor.id}/password`, "POST", { password: next }, adminCookie),
    ])
    assert.equal(reset.status, 200)
    assert.ok([200, 401].includes(attempt.status))
    const oldCookie = attempt.headers.get("set-cookie")?.split(";")[0]
    if (oldCookie) assert.equal((await (await call("/api/session", "GET", undefined, oldCookie)).json()).authenticated, false)
    assert.equal((await call("/api/login", "POST", { username: "visitor", password: current })).status, 401)
    await login("visitor", next)
    current = next
  }
  db.sqlite.close()
})
