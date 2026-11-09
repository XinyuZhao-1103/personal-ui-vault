import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { unzipSync } from "fflate"
import { examples } from "../server/examples.mjs"
import { exportZip } from "../server/exporter.mjs"
import { validateComponent } from "../server/model.mjs"

const directory = path.resolve("test-results/export-project")
const docs = examples.map((doc, index) => ({
  ...validateComponent(doc, 8 * 1024 * 1024),
  id: `example-${index}`,
  revision: 1,
}))
const files = unzipSync(exportZip(docs, "验证表格、按钮、分页和 HTML 组件组合"))
for (const [name, content] of Object.entries(files)) {
  const target = path.join(directory, name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}
console.log(`已生成实际导出项目 ${directory}`)
