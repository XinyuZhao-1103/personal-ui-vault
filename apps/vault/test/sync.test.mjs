import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { identityDatabase } from "../server/identity-db.mjs"
import { cloudStore } from "../cloud/store.mjs"
import { syncSources, publishCandidate } from "../cloud/sync.mjs"
import { syncPolicy, reviewedComponent } from "../cloud/sync-policy.mjs"
import { examples } from "../server/examples.mjs"

const sources = syncPolicy.sources.filter(source => source.enabled)
const config = { maxBytes: 1048576, fetchTimeout: 1000, syncBatchSize: 3, syncMaxCommits: 30, syncTimeout: 90000 }
function fixture(t, { empty = false, unavailable = false, licenseChanged = false } = {}) {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(readFileSync(new URL("../drizzle/0000_cloud_vault.sql", import.meta.url), "utf8"))
  const store = cloudStore(identityDatabase(sqlite))
  const statement = store.statement
  store.statement = (sql, ...args) => {
    assert.doesNotMatch(sql, /\b(LIKE|GLOB)\b/i)
    return statement(sql, ...args)
  }
  const license = "MIT License\nPermission is hereby granted"
  const hashes = sources.map(source => source.licenseSha256)
  for (const source of sources) source.licenseSha256 = createHash("sha256").update(license).digest("hex")
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = new URL(input)
    requests.push(url)
    if (unavailable) return new Response("Unavailable", { status: 503 })
    if (url.hostname === "raw.githubusercontent.com") return new Response(url.pathname.endsWith(".tsx")
      ? 'export function Sample(){return <div>sample</div>}'
      : licenseChanged ? license + "\nChanged terms" : license)
    const source = sources.find(source => url.pathname.startsWith(`/repos/${source.repository}`))
    assert.ok(source, url.href)
    if (url.pathname === `/repos/${source.repository}`) return Response.json({ license: { spdx_id: "MIT" }, stargazers_count: 100 })
    assert.equal(url.searchParams.get("per_page"), "1")
    if (empty) return Response.json([])
    return Response.json([{ sha: "snapshot", commit: { committer: { date: "2026-11-09T00:00:00Z" } } }])
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    sources.forEach((source, index) => { source.licenseSha256 = hashes[index] })
    sqlite.close()
  })
  async function seed() {
    for (const source of sources)
      for (const filename of Object.keys(source.reviews))
        await store.createMany([{ ...examples[0], slug: `renamed-${source.prefix}-${filename.replace(/\.tsx$/, "")}`, source: `https://github.com/${source.repository}/blob/old/${source.directory}/${filename}` }])
  }
  return { store, requests, seed }
}
test("只采集启用来源的精选组件，固定快照、稳定排序，重复复用候选", async t => {
  const { store, requests } = fixture(t)
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "complete")
  assert.equal(result.sources.length, 4)
  assert.equal(result.discovered, sources.reduce((total, source) => total + Math.min(3, Object.keys(source.reviews).length), 0))
  for (const id of result.candidateIds) {
    const row = await store.statement("SELECT * FROM sync_candidates WHERE id=?", id).first()
    const doc = JSON.parse(row.document)
    assert.ok(reviewedComponent(row.repository, row.source_path))
    assert.ok(doc.demo && doc.description && doc.tags.includes("特色精选"))
    assert.equal(JSON.parse(doc.files.find(file => file.path === "PROVENANCE.json").content).policy, "curated-v1")
  }
  assert.ok(requests.filter(url => url.searchParams.get("path")?.endsWith(".tsx")).every(url => url.searchParams.get("sha") === "snapshot"))
  assert.ok(requests.every(url => !url.href.includes("shadcn-ui")))
  const repeated = await syncSources(store, config, {})
  assert.equal(repeated.discovered, 0)
  assert.deepEqual(repeated.candidateIds, result.candidateIds)
})
test("来源路径识别改名组件，全数已收录允许零新增", async t => {
  const { store, seed } = fixture(t)
  await seed()
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "complete")
  assert.equal(result.candidateIds.length, 0)
  assert.ok(result.sources.every(source => source.exhausted && source.shortfall === 3))
})
test("精选不足允许成功，单源上限和本轮排除生效", async t => {
  const { store } = fixture(t)
  const first = await syncSources(store, config, {}, { sourceLimits: Object.fromEntries(sources.map(source => [source.repository, 1])) })
  assert.equal(first.candidateIds.length, sources.length)
  const next = await syncSources(store, config, {}, { excludeCandidateIds: first.candidateIds })
  assert.ok(next.candidateIds.every(id => !first.candidateIds.includes(id)))
  assert.equal(next.status, "complete")
})
test("空目录不凑数", async t => {
  const { store } = fixture(t, { empty: true })
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "complete")
  assert.equal(result.discovered, 0)
  assert.ok(result.sources.every(source => source.exhausted))
})
test("许可正文变化拒绝采集，遗留未精选候选不能绕过发布入口", async t => {
  const { store } = fixture(t, { licenseChanged: true })
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "partial")
  assert.equal(result.discovered, 0)
  assert.ok(result.failures.every(failure => /许可正文/.test(failure.error)))
  await store.statement("INSERT INTO sync_candidates VALUES(?,?,?,?,?,'pending','legacy',?)", "old", "shadcn-ui/ui", "unreviewed.tsx", "old", JSON.stringify(examples[0]), new Date().toISOString()).run()
  await assert.rejects(publishCandidate({ candidateId: "old", previewGzip: "" }, store, config, {}), /精选策略/)
})
test("检查预算不足明确报告，互斥租约释放", async t => {
  const { store } = fixture(t)
  const limited = await syncSources(store, { ...config, syncMaxCommits: 1 }, {})
  assert.equal(limited.status, "partial")
  assert.ok(limited.sources.some(source => source.scanLimited))
  assert.equal(await store.statement("SELECT value FROM sync_state WHERE key='sync_lock'").first(), null)
  await store.statement("INSERT INTO sync_state VALUES('sync_lock',?)", String(Date.now() + 300000)).run()
  await assert.rejects(syncSources(store, config, {}), /同步任务正在运行/)
})
test("来源依赖失败可观测", async t => {
  const { store } = fixture(t, { unavailable: true })
  const result = await syncSources(store, config, {})
  assert.equal(result.status, "partial")
  assert.equal(result.failures.length, sources.length)
  assert.equal(await store.statement("SELECT value FROM sync_state WHERE key='sync_lock'").first(), null)
})
