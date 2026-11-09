import { z } from "zod"
import { AppError } from "./model.mjs"

const encoder = new TextEncoder()
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("")
const unhex = value => Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16))
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)))
const digest = async value => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.@-]{3,64}$/, "账号需为3至64位字母、数字或_.@-")
const passwordSchema = z.string().min(12, "密码至少12位").max(256, "密码最多256位")
const displayNameSchema = z.string().trim().min(1).max(80)
const publicUser = row => row ? {
  id: row.id, username: row.username, displayName: row.display_name,
  role: row.role, status: row.status, hasPassword: row.has_password === undefined ? !!row.password_hash : !!row.has_password,
  createdAt: row.created_at, lastLoginAt: row.last_login_at,
} : null

async function passwordHash(password, iterations, salt = token()) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations }, key, 256)
  return `pbkdf2-sha256$${iterations}$${salt}$${hex(bits)}`
}

async function verifyPassword(password, encoded) {
  const parts = (encoded || "").split("$")
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 100000) return false
  const candidate = await passwordHash(password, iterations, parts[2])
  let difference = candidate.length ^ encoded.length
  for (let index = 0; index < candidate.length; index++) difference |= candidate.charCodeAt(index) ^ (encoded.charCodeAt(index) || 0)
  return difference === 0
}

async function readBody(request) {
  const reader = request.body?.getReader()
  const chunks = []
  let length = 0
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 16384) throw new AppError("请求超过16KiB上限", 413)
        chunks.push(value)
      }
    } finally { await reader.cancel() }
  }
  const bytes = new Uint8Array(length)
  let position = 0
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new AppError("请求JSON无效") }
}

export function createIdentity({ db, config }) {
  const query = (sql, ...values) => db.prepare(sql).bind(...values)
  const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
  const cookieName = config.secureCookie ? "__Host-vault_identity" : "vault_identity"
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`
  const cookieValue = request => (request.headers.get("cookie") || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)

  async function ensureBootstrap() {
    if (!config.bootstrapPassword) return
    const existing = await query("SELECT id FROM identity_users LIMIT 1").first()
    if (existing) return
    const username = usernameSchema.parse(config.bootstrapUsername || "admin")
    const encoded = await passwordHash(passwordSchema.parse(config.bootstrapPassword), config.passwordIterations || 100000)
    const now = new Date().toISOString()
    await query("INSERT OR IGNORE INTO identity_users(id,username,display_name,password_hash,role,status,created_at,updated_at) SELECT 'bootstrap-admin',?,?,?,'admin','active',?,? WHERE NOT EXISTS(SELECT 1 FROM identity_users)", username, "管理员", encoded, now, now).run()
  }

  async function getSession(request) {
    const value = cookieValue(request)
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return null
    const row = await query("SELECT u.id,u.username,u.display_name,u.role,u.status,u.created_at,u.last_login_at,(u.password_hash IS NOT NULL) AS has_password FROM identity_sessions s JOIN identity_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'", await digest(value), Date.now()).first()
    return publicUser(row)
  }

  async function ipHash(request) {
    // 仅使用可信运行时提供的地址，不采纳访客可伪造的 X-Forwarded-For。
    const address = request.headers.get("cf-connecting-ip") || "local"
    const secret = config.auditHashKey || config.bootstrapPassword
    if (!secret) throw new AppError("身份审计密钥未配置", 503)
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(address)))
  }

  async function log(request, user, success, reason, username = "") {
    const now = new Date()
    const retainedAfter = new Date(now.getTime() - (config.loginLogRetentionDays || 90) * 86400000).toISOString()
    await db.batch([
      query("INSERT INTO identity_login_logs VALUES(?,?,?,?,?,?,?,?,?)", crypto.randomUUID(), user?.id || null, (user?.username || username).slice(0, 64), "password", success ? 1 : 0, reason, await ipHash(request), (request.headers.get("user-agent") || "").slice(0, 256), now.toISOString()),
      query("DELETE FROM identity_login_logs WHERE id IN (SELECT id FROM identity_login_logs WHERE created_at<? LIMIT 1000)", retainedAfter),
      query("DELETE FROM identity_login_logs WHERE id IN (SELECT id FROM identity_login_logs ORDER BY created_at DESC,id DESC LIMIT 1000 OFFSET ?)", config.loginLogMaxRows || 10000),
    ])
  }

  async function rateLimit(request, username) {
    const now = Date.now()
    const expires = now + (config.loginWindowSeconds || 300) * 1000
    const keys = [`ip:${await ipHash(request)}`, `account:${await digest(username)}`]
    await db.batch([
      query("DELETE FROM identity_rate_limits WHERE key IN (SELECT key FROM identity_rate_limits WHERE expires_at<=? LIMIT 1000)", now),
      ...keys.map(key => query("INSERT INTO identity_rate_limits SELECT ?,1,? WHERE EXISTS(SELECT 1 FROM identity_rate_limits WHERE key=?) OR (SELECT count(*) FROM identity_rate_limits)<? ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END", key, expires, key, config.loginRateLimitMaxKeys || 10000, now, now, expires)),
    ])
    const rows = await db.batch(keys.map(key => query("SELECT count FROM identity_rate_limits WHERE key=?", key)))
    if (rows.some(result => !result.results[0] || result.results[0].count > (config.loginMaxAttempts || 10))) {
      await log(request, null, false, "登录尝试过多", username)
      throw new AppError("登录尝试过多，请稍后重试", 429)
    }
    return keys
  }

  async function issueSession(request, row) {
    const now = Date.now()
    const value = token()
    const maxAge = (config.sessionHours || 24) * 3600
    const results = await db.batch([
      query("DELETE FROM identity_sessions WHERE expires_at<=?", now),
      query("DELETE FROM identity_sessions WHERE token_hash IN (SELECT token_hash FROM identity_sessions WHERE user_id=? ORDER BY created_at DESC,token_hash DESC LIMIT -1 OFFSET ?)", row.id, (config.maxSessionsPerUser || 10) - 1),
      query("INSERT INTO identity_sessions SELECT ?,id,?,? FROM identity_users WHERE id=? AND status='active' AND password_hash=? AND auth_version=?", await digest(value), now + maxAge * 1000, now, row.id, row.password_hash, row.auth_version),
      query("UPDATE identity_users SET last_login_at=? WHERE id=?", new Date(now).toISOString(), row.id),
    ])
    if (!results[2].meta.changes) throw new AppError("账号已更新，请重新登录", 401)
    await log(request, row, true, "登录成功")
    return json({ success: true, user: publicUser(row) }, 200, { "Set-Cookie": cookie(value, maxAge) })
  }

  async function requireUser(request, admin = false) {
    const user = await getSession(request)
    if (!user) throw new AppError("请先登录", 401)
    if (admin && user.role !== "admin") throw new AppError("需要管理员权限", 403)
    return user
  }

  function pagination(url) {
    return z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), size: z.coerce.number().int().min(1).max(config.maxPageSize || 48).default(20) }).parse(Object.fromEntries(url.searchParams))
  }

  async function handle(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const known = ["/api/session", "/api/login", "/api/logout", "/api/account/password", "/api/auth/providers", "/api/admin/users", "/api/admin/login-logs"].includes(path) || path.startsWith("/api/admin/users/")
    if (!known) return null
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== (config.origin || url.origin)) throw new AppError("请求来源不匹配", 403)
    await ensureBootstrap()
    if (path === "/api/session" && request.method === "GET") {
      const user = await getSession(request)
      return json({ authenticated: !!user, user, providers: [], limits: { maxBytes: config.maxBytes, maxSelection: config.maxSelection, maxPageSize: config.maxPageSize } })
    }
    if (path === "/api/auth/providers" && request.method === "GET") return json({ providers: [] })
    if (path === "/api/login" && request.method === "POST") {
      const input = z.object({ username: usernameSchema.default(config.bootstrapUsername || "admin"), password: z.string().min(1).max(256) }).parse(await readBody(request))
      const keys = await rateLimit(request, input.username)
      const row = await query("SELECT * FROM identity_users WHERE username=?", input.username).first()
      // 未知账号也执行同样的密码派生，减小账号探测的耗时差异。
      const fallback = `pbkdf2-sha256$${config.passwordIterations || 100000}$${"00".repeat(32)}$${"00".repeat(32)}`
      const valid = await verifyPassword(input.password, row?.password_hash || fallback)
      if (!valid || row?.status !== "active") {
        await log(request, row, false, "账号或密码不正确", input.username)
        throw new AppError("账号或密码不正确", 401)
      }
      await db.batch(keys.map(key => query("DELETE FROM identity_rate_limits WHERE key=?", key)))
      return issueSession(request, row)
    }
    const user = await requireUser(request, path.startsWith("/api/admin/"))
    if (path === "/api/logout" && request.method === "POST") {
      await query("DELETE FROM identity_sessions WHERE token_hash=?", await digest(cookieValue(request))).run()
      await log(request, user, true, "退出登录")
      return json({ success: true }, 200, { "Set-Cookie": cookie("", 0) })
    }
    if (path === "/api/account/password" && request.method === "POST") {
      const input = z.object({ currentPassword: z.string().max(256), newPassword: passwordSchema }).parse(await readBody(request))
      const row = await query("SELECT * FROM identity_users WHERE id=?", user.id).first()
      await rateLimit(request, user.username)
      if (!await verifyPassword(input.currentPassword, row.password_hash)) {
        await log(request, row, false, "修改密码验证失败")
        throw new AppError("当前密码不正确", 400)
      }
      const results = await db.batch([
        query("UPDATE identity_users SET password_hash=?,updated_at=?,auth_version=auth_version+1 WHERE id=? AND password_hash=? AND status='active'", await passwordHash(input.newPassword, config.passwordIterations || 100000), new Date().toISOString(), user.id, row.password_hash),
        query("DELETE FROM identity_sessions WHERE user_id=?", user.id),
      ])
      if (!results[0].meta.changes) throw new AppError("账号已更新，请重新登录", 409)
      await log(request, user, true, "密码已修改")
      return json({ success: true }, 200, { "Set-Cookie": cookie("", 0) })
    }
    if (path === "/api/admin/users" && request.method === "GET") {
      const { page, size } = pagination(url)
      const search = z.string().max(100).parse(url.searchParams.get("q") || "")
      const where = "WHERE (?='' OR instr(username,lower(?))>0 OR instr(lower(display_name),lower(?))>0)"
      const [items, count] = await db.batch([
        query(`SELECT id,username,display_name,role,status,created_at,last_login_at,(password_hash IS NOT NULL) AS has_password FROM identity_users ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, search, search, search, size, (page - 1) * size),
        query(`SELECT count(*) AS total FROM identity_users ${where}`, search, search, search),
      ])
      return json({ items: items.results.map(publicUser), total: count.results[0].total, page, size })
    }
    if (path === "/api/admin/users" && request.method === "POST") {
      const input = z.object({ username: usernameSchema, displayName: displayNameSchema, password: passwordSchema, role: z.enum(["admin", "visitor"]).default("visitor") }).parse(await readBody(request))
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      try {
        await query("INSERT INTO identity_users(id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)", id, input.username, input.displayName, await passwordHash(input.password, config.passwordIterations || 100000), input.role, now, now).run()
      } catch (error) {
        if (/UNIQUE constraint/i.test(error.message)) throw new AppError("账号已存在", 409)
        throw error
      }
      await log(request, user, true, `创建用户 ${input.username}`)
      return json(publicUser(await query("SELECT * FROM identity_users WHERE id=?", id).first()), 201)
    }
    const selected = path.match(/^\/api\/admin\/users\/([^/]+)(\/password)?$/)
    if (selected && !selected[2] && request.method === "PATCH") {
      const input = z.object({ displayName: displayNameSchema.optional(), role: z.enum(["admin", "visitor"]).optional(), status: z.enum(["active", "disabled"]).optional() }).strict().parse(await readBody(request))
      const row = await query("SELECT * FROM identity_users WHERE id=?", selected[1]).first()
      if (!row) throw new AppError("用户不存在", 404)
      const role = input.role || row.role
      const status = input.status || row.status
      // 条件与更新在同一SQL语句内执行，防止两名管理员并发降权后失去管理入口。
      const results = await db.batch([
        query("UPDATE identity_users SET display_name=?,role=?,status=?,updated_at=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND (role<>'admin' OR status<>'active' OR (?='admin' AND ?='active') OR (SELECT count(*) FROM identity_users WHERE role='admin' AND status='active')>1)", input.displayName || row.display_name, role, status, new Date().toISOString(), row.id, row.auth_version, role, status),
        query("DELETE FROM identity_sessions WHERE user_id=? AND (?<>? OR ?<>?) AND EXISTS(SELECT 1 FROM identity_users WHERE id=? AND auth_version=? AND role=? AND status=?)", row.id, row.role, role, row.status, status, row.id, row.auth_version + 1, role, status),
      ])
      if (!results[0].meta.changes) throw new AppError("用户已更新，或操作将导致没有可用管理员，请刷新后重试", 409)
      await log(request, user, true, `更新用户 ${row.username}，角色 ${role}，状态 ${status}`)
      return json(publicUser(await query("SELECT * FROM identity_users WHERE id=?", row.id).first()))
    }
    if (selected?.[2] && request.method === "POST") {
      const input = z.object({ password: passwordSchema }).parse(await readBody(request))
      const target = await query("SELECT username FROM identity_users WHERE id=?", selected[1]).first()
      if (!target) throw new AppError("用户不存在", 404)
      const results = await db.batch([
        query("UPDATE identity_users SET password_hash=?,updated_at=?,auth_version=auth_version+1 WHERE id=?", await passwordHash(input.password, config.passwordIterations || 100000), new Date().toISOString(), selected[1]),
        query("DELETE FROM identity_sessions WHERE user_id=?", selected[1]),
      ])
      if (!results[0].meta.changes) throw new AppError("用户不存在", 404)
      await log(request, user, true, `重置用户 ${target.username} 的密码`)
      return json({ success: true })
    }
    if (path === "/api/admin/login-logs" && request.method === "GET") {
      const { page, size } = pagination(url)
      const [items, count] = await db.batch([
        query("SELECT id,user_id AS userId,username,provider,success,reason,ip_hash AS ipHash,user_agent AS userAgent,created_at AS createdAt FROM identity_login_logs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", size, (page - 1) * size),
        query("SELECT count(*) AS total FROM identity_login_logs"),
      ])
      return json({ items: items.results.map(row => ({ ...row, success: !!row.success })), total: count.results[0].total, page, size })
    }
    return json({ error: "接口不支持此请求方法" }, 405)
  }

  return { handle, getSession, ensureBootstrap }
}
