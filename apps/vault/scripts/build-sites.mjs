import { build as bundle } from "esbuild"
import { build as viteBuild } from "vite"
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { makePreview } from "../server/preview.mjs"
import { validateComponent } from "../server/model.mjs"

const output = path.resolve("dist-sites")
const documents = []
for (const entry of await readdir("catalog", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const meta = JSON.parse(await readFile(`catalog/${entry.name}/component.json`, "utf8"))
  const files = []
  for (const file of meta.files) files.push({ path: file, content: await readFile(`catalog/${entry.name}/${file}`, "utf8") })
  documents.push(validateComponent({ ...meta, files }, 1048576))
}
await mkdir("generated", { recursive: true })
await writeFile("generated/cloud-catalog.json", JSON.stringify({ documents, sources: JSON.parse(await readFile("catalog/sources.json", "utf8")) }))
await viteBuild({ build: { outDir: `${output}/client`, emptyOutDir: true } })
await mkdir(`${output}/client/compiler/deps`, { recursive: true })
await mkdir(`${output}/server`, { recursive: true })
await mkdir(`${output}/.openai`, { recursive: true })
await mkdir(`${output}/client/previews`, { recursive: true })
await copyFile("node_modules/esbuild-wasm/esbuild.wasm", `${output}/client/compiler/esbuild.wasm`)
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", `${output}/client/compiler/tailwind.js`)
await copyFile("cloud/theme.css", `${output}/client/compiler/theme.css`)
const packages = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "lucide-react", "motion/react", "clsx", "tailwind-merge", "class-variance-authority", "@radix-ui/react-slot", "react-use-measure"]
const entries = {}
const dependencies = {}
for (const [index, name] of packages.entries()) {
  const exports = await import(name)
  const named = Object.keys(exports).filter(key => key !== "default" && /^[A-Za-z_$][\w$]*$/.test(key))
  const entry = `generated/dependency-${index}.mjs`
  const hasDefault = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "clsx", "react-use-measure"].includes(name)
  await writeFile(entry, `${named.length ? `export {${named.join(",")}} from ${JSON.stringify(name)};` : ""}${hasDefault ? `export {default} from ${JSON.stringify(name)};` : ""}`)
  entries[`dependency-${index}`] = entry
  dependencies[name] = `/compiler/deps/dependency-${index}.js`
}
await bundle({ entryPoints: entries, outdir: `${output}/client/compiler/deps`, bundle: true, splitting: true, format: "esm", platform: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } })
await writeFile(`${output}/client/compiler/dependencies.json`, JSON.stringify(dependencies))
await bundle({ entryPoints: ["cloud/worker.mjs"], outfile: `${output}/server/index.js`, bundle: true, platform: "browser", format: "esm", mainFields: ["browser", "module", "main"], conditions: ["browser"], external: ["node:*"], plugins: [{ name: "worker-network", setup(builder) {
  builder.onResolve({ filter: /^\.\/remote\.mjs$/ }, args => args.importer.endsWith("importer.mjs") ? { path: path.resolve("cloud/remote.mjs") } : undefined)
} }] })
for (const doc of documents) {
  await writeFile(`${output}/client/previews/${doc.slug}.html`, await makePreview(doc, 30000))
  console.log(`预编译 ${doc.slug}`)
}
const manifest = JSON.parse(await readFile(".openai/hosting.json", "utf8"))
await writeFile(`${output}/.openai/hosting.json`, JSON.stringify(manifest, null, 2))
await writeFile(`${output}/server/wrangler.json`, JSON.stringify({ name: "personal-ui-vault", main: "index.js", compatibility_date: "2026-05-15", compatibility_flags: ["nodejs_compat"], assets: { directory: "../client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/mcp"] }, d1_databases: [{ binding: "DB", database_name: "personal-ui-vault", database_id: "local-vault-db", migrations_dir: "../../drizzle" }], r2_buckets: [{ binding: "BUCKET", bucket_name: "personal-ui-vault-files" }] }, null, 2))
console.log(`Sites 构建完成，包含 ${documents.length} 个已编译组件`)
