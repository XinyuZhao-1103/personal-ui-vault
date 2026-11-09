import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { validateComponent } from "../server/model.mjs"

// 测试与云端构建共用目录快照，干净检出无需先运行完整预览构建。
const documents = []
for (const entry of await readdir("catalog", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const meta = JSON.parse(await readFile(`catalog/${entry.name}/component.json`, "utf8"))
  const files = []
  for (const file of meta.files)
    files.push({ path: file, content: await readFile(`catalog/${entry.name}/${file}`, "utf8") })
  documents.push(validateComponent({ ...meta, files }, 1048576))
}
await mkdir("generated", { recursive: true })
await writeFile("generated/cloud-catalog.json", JSON.stringify({ documents, sources: JSON.parse(await readFile("catalog/sources.json", "utf8")) }))
