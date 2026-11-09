import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { once } from "node:events"
import { examples } from "../server/examples.mjs"

const port = 14311
const base = `http://127.0.0.1:${port}`
const directory = mkdtempSync(path.join(tmpdir(), "vault-api-"))
let child
let cookie
let logs = ""
async function api(url, method = "GET", body, headers = {}) {
  return fetch(base + url, {
    method,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
before(async () => {
  child = spawn(process.execPath, ["server/index.mjs", "--production"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      VAULT_PASSWORD: "test-only-password-123",
      VAULT_ORIGIN: base,
      VAULT_PORT: String(port),
      VAULT_HOST: "127.0.0.1",
      VAULT_DATA_DIR: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => {
    logs += d
  })
  child.stderr.on("data", (d) => {
    logs += d
  })
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(base + "/api/health")
      if (response.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`测试服务未启动 ${logs}`)
})
after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  rmSync(directory, { recursive: true, force: true })
})

test("认证、来源、分页上限、导出、只读权限和注销", async () => {
  assert.equal((await api("/api/components")).status, 401)
  assert.equal(
    (
      await api(
        "/api/login",
        "POST",
        { password: "test-only-password-123" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  )
  assert.equal(
    (await api("/api/login", "POST", { password: "wrong" })).status,
    401,
  )
  const login = await api("/api/login", "POST", {
    password: "test-only-password-123",
  })
  assert.equal(login.status, 200)
  cookie = login.headers.get("set-cookie").split(";")[0]
  assert.equal((await api("/api/components?size=10000")).status, 400)
  assert.equal((await api("/api/components?page=-1")).status, 400)
  assert.equal((await api("/api/examples", "POST", {})).status, 200)
  const docs = (await (await api("/api/components")).json()).items
  assert.equal(docs.length, 4)
  const created = await api("/api/components", "POST", {
    ...examples[0],
    slug: "api-button",
  })
  assert.equal(created.status, 201)
  const document = await created.json()
  assert.equal(
    (
      await api("/api/components", "POST", {
        ...examples[0],
        slug: "api-button",
      })
    ).status,
    409,
  )
  assert.equal(
    (
      await api(`/api/components/${document.id}`, "PUT", {
        ...document,
        name: "更新按钮",
        expectedRevision: 1,
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await api(`/api/components/${document.id}`, "PUT", {
        ...document,
        expectedRevision: 1,
      })
    ).status,
    409,
  )
  assert.equal(
    (await api("/api/preview", "POST", { id: document.id })).status,
    200,
  )
  const selection = [{ id: document.id, revision: 1 }]
  const prompt = await (
    await api("/api/export", "POST", { selection, format: "prompt" })
  ).json()
  assert.match(prompt.text, /export function Button/)
  const zip = await api("/api/export", "POST", { selection, format: "zip" })
  assert.equal(zip.headers.get("content-type"), "application/zip")
  assert.ok((await zip.arrayBuffer()).byteLength > 1000)
  assert.equal(
    (await api("/api/export", "POST", { selection: [], format: "zip" })).status,
    400,
  )
  const token = await (await api("/api/tokens", "POST", {})).json()
  const savedCookie = cookie
  cookie = undefined
  assert.equal(
    (
      await api("/api/components", "GET", undefined, {
        Authorization: `Bearer ${token.token}`,
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await api(
        "/api/examples",
        "POST",
        {},
        { Authorization: `Bearer ${token.token}` },
      )
    ).status,
    401,
  )
  cookie = savedCookie
  assert.equal((await api(`/api/tokens/${token.id}`, "DELETE")).status, 200)
  assert.equal((await api("/api/logout", "POST", {})).status, 200)
  assert.equal((await api("/api/components")).status, 401)
  assert.doesNotMatch(logs, /test-only-password-123/)
})
