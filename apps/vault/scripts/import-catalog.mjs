import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../server/config.mjs"
import { safePath, validateComponent } from "../server/model.mjs"
import { makePreview } from "../server/preview.mjs"
import { exportZip } from "../server/exporter.mjs"

const config = loadConfig()
const catalog = fileURLToPath(new URL("../catalog/", import.meta.url))
const command = process.argv[2] || "--import"
if (!["--check", "--import", "--export"].includes(command))
  throw new Error("支持 --check、--import 或 --export")
const folders = (await readdir(catalog, { withFileTypes: true }))
  .filter((item) => item.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))
if (folders.length > 100)
  throw new Error("单次目录检查上限为 100 个组件，请拆分目录")
const documents = []
for (const folder of folders) {
  const directory = path.join(catalog, folder.name)
  const metadata = JSON.parse(
    await readFile(path.join(directory, "component.json"), "utf8"),
  )
  const files = []
  for (const relative of metadata.files) {
    safePath.parse(relative)
    files.push({
      path: relative,
      content: await readFile(path.join(directory, relative), "utf8"),
    })
  }
  documents.push(validateComponent({ ...metadata, files }, config.maxBytes))
}

const evidence = path.resolve("work/catalog-verification")
await mkdir(evidence, { recursive: true })
if (command === "--check") {
  for (const doc of documents) {
    const html = await makePreview(doc, config.previewTimeout)
    await writeFile(path.join(evidence, `${doc.slug}.html`), html)
    console.log(`编译通过 ${doc.slug}`)
  }
  console.log(
    JSON.stringify({ validated: documents.length, previewDirectory: evidence }),
  )
} else if (command === "--export") {
  const archive = exportZip(
    documents.map((doc, index) => ({
      ...doc,
      id: `catalog-${index}`,
      revision: 1,
    })),
    "本地首批开源组件预览与接入",
    config.maxBytes,
  )
  const target = path.join(evidence, "curated-components.zip")
  await writeFile(target, archive)
  console.log(JSON.stringify({ components: documents.length, archive: target }))
} else {
  const base = config.origin
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: config.password }),
  })
  if (!login.ok) throw new Error(`登录失败 HTTP ${login.status}`)
  const cookie = login.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("服务未返回登录会话")
  async function api(endpoint, options = {}) {
    const response = await fetch(base + endpoint, {
      ...options,
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
      },
    })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
    return value
  }
  const results = []
  try {
    for (const doc of documents) {
      const existing = await api(
        `/api/components?q=${encodeURIComponent(doc.slug)}&size=48`,
      )
      const match = existing.items.find((item) => item.slug === doc.slug)
      if (match) {
        const current = validateComponent(
          await api(`/api/components/${match.id}`),
          config.maxBytes,
        )
        if (JSON.stringify(current) !== JSON.stringify(doc))
          throw new Error(
            `${doc.slug} 已存在且内容不同，已保留本地内容。请在网站中核对版本后更新。`,
          )
        results.push({ slug: doc.slug, id: match.id, status: "unchanged" })
      } else {
        const saved = await api("/api/components", {
          method: "POST",
          body: JSON.stringify(doc),
        })
        results.push({ slug: doc.slug, id: saved.id, status: "imported" })
      }
      console.log(`${results.at(-1).status} ${doc.slug}`)
    }
    const sourceData = JSON.parse(
      await readFile(path.join(catalog, "sources.json"), "utf8"),
    )
    const kits = []
    for (const source of sourceData.sources) {
      const name = `首批精选 · ${source.repository}`
      let existing
      for (let page = 1; page <= 1000; page++) {
        const response = await api(`/api/kits?page=${page}`)
        existing = response.items.find((kit) => kit.name === name)
        if (existing || page * response.size >= response.total) break
      }
      if (existing) {
        kits.push(existing)
        continue
      }
      const sourceSlugs = sourceData.components
        .filter((item) => item.repository === source.repository)
        .map((item) => item.slug)
      const selection = []
      for (const result of results.filter((item) =>
        sourceSlugs.includes(item.slug),
      )) {
        const current = await api(`/api/components/${result.id}`)
        selection.push({ id: current.id, revision: current.revision })
      }
      kits.push(
        await api("/api/kits", {
          method: "POST",
          body: JSON.stringify({ name, selection }),
        }),
      )
    }
    await writeFile(
      path.join(evidence, "import-result.json"),
      JSON.stringify({ target: base, results, kits }, null, 2),
    )
    console.log(
      JSON.stringify({
        imported: results.filter((item) => item.status === "imported").length,
        unchanged: results.filter((item) => item.status === "unchanged").length,
        target: base,
      }),
    )
  } finally {
    await api("/api/logout", { method: "POST", body: "{}" })
  }
}
