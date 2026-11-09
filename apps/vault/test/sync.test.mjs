import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { identityDatabase } from "../server/identity-db.mjs"
import { cloudStore } from "../cloud/store.mjs"
import { syncSources } from "../cloud/sync.mjs"
import { examples } from "../server/examples.mjs"

const repositories = ["shadcn-ui/ui", "magicuidesign/magicui", "ibelick/motion-primitives"]
const directories = ["apps/v4/registry/new-york-v4/ui", "apps/www/registry/magicui", "components/core"]
const prefixes = ["shadcn", "magic", "motion"]
const config = { maxBytes: 1048576, fetchTimeout: 1000, syncBatchSize: 3, syncMaxCommits: 30, syncTimeout: 90000 }

function fixture(t, { count = 16, unavailable = false, largeCommit = false } = {}) {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(readFileSync(new URL("../drizzle/0000_cloud_vault.sql", import.meta.url), "utf8"))
  const store = cloudStore(identityDatabase(sqlite))
  const statement = store.statement
  store.statement = (sql, ...args) => {
    // 云端 D1 会拒绝较长的 LIKE/GLOB 模式，真实来源 URL 超过该上限。
    assert.doesNotMatch(sql, /\b(LIKE|GLOB)\b/i)
    return statement(sql, ...args)
  }
  const requests = []
  const fetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = new URL(input)
    requests.push(url)
    if (unavailable) return new Response("Unavailable", { status: 503 })
    if (url.hostname === "raw.githubusercontent.com") return new Response(url.pathname.endsWith(".tsx")
      ? 'export function Sample(){return <div>sample</div>}'
      : "MIT License\nPermission is hereby granted")
    const index = repositories.findIndex(repository => url.pathname.startsWith(`/repos/${repository}`))
    assert.notEqual(index, -1, url.href)
    const base = `/repos/${repositories[index]}`
    if (url.pathname === base) return Response.json({ license: { spdx_id: "MIT" }, stargazers_count: 100 })
    if (url.pathname === `${base}/commits`) {
      const page = Number(url.searchParams.get("page"))
      return Response.json(Array.from({ length: count }, (_, n) => ({ sha: `commit-${n}` })).slice((page - 1) * 10, page * 10))
    }
    const n = Number(url.pathname.split("-").pop())
    const page = Number(url.searchParams.get("page"))
    const filename = `${directories[index]}/sample-${n}.tsx`
    const files = largeCommit && n === 0 && page === 1
      ? Array.from({ length: 100 }, (_, n) => ({ filename: `unrelated/${n}.ts`, status: "modified" }))
      : [{ filename, status: "modified" }]
    return Response.json({ sha: `commit-${n}`, commit: { committer: { date: `2026-11-${String(30 - n).padStart(2, "0")}T00:00:00Z` } }, files })
  }
  t.after(() => { globalThis.fetch = fetch; sqlite.close() })
  async function seed(number, renameSlug = false) {
    for (let index = 0; index < repositories.length; index++)
      for (let n = 0; n < number; n++)
        await store.createMany([{ ...examples[0], slug: `${renameSlug ? "renamed-" : ""}${prefixes[index]}-sample-${n}`, source: `https://github.com/${repositories[index]}/blob/old/${directories[index]}/sample-${n}.tsx` }])
  }
  return { store, sqlite, requests, seed }
}

test("连续已有组件跨过提交分页后，每来源补足三个，重复执行复用候选", async t => {
  const { store, requests, seed } = fixture(t)
  await seed(11)
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "complete")
  assert.equal(result.discovered, 9)
  for (const source of result.sources) {
    assert.equal(source.selected, 3)
    assert.equal(source.skippedExisting, 11)
    assert.equal(source.scannedCommits, 14)
  }
  assert.equal(result.candidateIds.length, 9)
  assert.ok(requests.some(url => url.searchParams.get("page") === "2" && url.searchParams.get("sha") === "commit-0"))
  const repeated = await syncSources(store, config, {})
  assert.equal(repeated.discovered, 0)
  assert.deepEqual(repeated.candidateIds, result.candidateIds)
  // 入库后，下次继续取得更早的未收录组件。
  for (const id of result.candidateIds) {
    const row = await store.statement("SELECT document FROM sync_candidates WHERE id=?", id).first()
    await store.createMany([JSON.parse(row.document)])
  }
  const next = await syncSources(store, config, {})
  assert.ok(next.candidateIds.every(id => !result.candidateIds.includes(id)))
  assert.ok(next.sources.every(source => source.selected === 2 && source.exhausted))
})

test("按来源路径识别改名组件，扫描上限不足时显式返回 partial", async t => {
  const { store, seed } = fixture(t)
  await seed(2, true)
  const result = await syncSources(store, { ...config, syncMaxCommits: 3 }, {})
  assert.equal(result.status, "partial")
  assert.equal(result.failures.length, 3)
  assert.ok(result.sources.every(source => source.skippedExisting === 2 && source.selected === 1 && source.shortfall === 2))
  assert.equal(await store.statement("SELECT value FROM sync_state WHERE key='sync_lock'").first(), null)
})

test("来源不足或为空如实返回，失败候选可在本轮排除后继续向前补采", async t => {
  const { store } = fixture(t, { count: 2 })
  const first = await syncSources(store, config, {})
  assert.ok(first.sources.every(source => source.selected === 2 && source.shortfall === 1 && source.exhausted))
  const excluded = await syncSources(store, config, {}, { excludeCandidateIds: first.candidateIds })
  assert.equal(excluded.candidateIds.length, 0)
  assert.ok(excluded.sources.every(source => source.exhausted && source.shortfall === 3))
})

test("单提交文件分页能找到第二页组件，补采目标可按来源递减", async t => {
  const { store, requests } = fixture(t, { largeCommit: true })
  const result = await syncSources(store, config, {}, { sourceLimits: Object.fromEntries(repositories.map(repository => [repository, 1])) })
  assert.equal(result.candidateIds.length, 3)
  assert.ok(result.candidateIds.every(id => id.endsWith(":commit-0")))
  assert.ok(requests.some(url => url.pathname.endsWith("/commits/commit-0") && url.searchParams.get("page") === "2"))
})

test("来源依赖失败可观测，互斥锁会释放并拒绝重叠执行", async t => {
  const { store } = fixture(t, { unavailable: true })
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "partial")
  assert.equal(result.failures.length, 3)
  assert.equal(await store.statement("SELECT value FROM sync_state WHERE key='sync_lock'").first(), null)
  await store.statement("INSERT INTO sync_state VALUES('sync_lock',?)", String(Date.now() + 300000)).run()
  await assert.rejects(syncSources(store, config, {}), /同步任务正在运行/)
})
