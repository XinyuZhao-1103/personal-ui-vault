import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { createRequire } from "node:module"
import path from "node:path"
import { readFile } from "node:fs/promises"

const require = createRequire(import.meta.url)
const compilerBase = path.dirname(path.dirname(require.resolve("@tailwindcss/node")))

// 将新来源的 Tailwind 4 样式物化为普通 CSS，供预览、离线导出和旧项目共用。
export async function materializeRegistryStyles(document) {
  if (!document.files.some(file => file.path === "tailwind-v4.css")) return document
  const theme = await readFile(new URL("../cloud/theme.css", import.meta.url), "utf8")
  const styles = document.files.filter(file => file.path.endsWith(".css"))
  const scanner = new Scanner({ sources: [] })
  const candidates = scanner.scanFiles([...document.files, { path: "demo.tsx", content: document.demo }]
    .filter(file => /\.[jt]sx?$/.test(file.path))
    .map(file => ({ content: file.content, extension: path.extname(file.path).slice(1) })))
  const builder = await compile(theme + "\n" + styles.map(file => file.content).join("\n"), { base: compilerBase, onDependency() {} })
  const files = document.files.filter(file => !file.path.endsWith(".css"))
  files.push(...styles.map(file => ({ path: `upstream/${file.path}.txt`, content: file.content })))
  files.push({ path: "preview.css", content: builder.build(candidates) })
  return { ...document, files }
}
