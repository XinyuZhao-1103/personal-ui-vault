import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// 将源码镜像到独立 Sites checkout，避免改变原 Fork 的历史与运行数据。
const target = path.resolve(process.argv[2] || "../../../../work/personal-ui-vault-site")
const source = path.resolve(".")
if (target.startsWith(source + path.sep)) throw new Error("Sites checkout 必须位于应用目录之外")
await mkdir(target, { recursive: true })
await mkdir(`${target}/apps/vault`, { recursive: true })
const excluded = new Set([".git", ".env", "data", "work", "node_modules", "dist", "dist-sites", "generated", "test-results", "playwright-report", ".wrangler"])
await cp(source, `${target}/apps/vault`, { recursive: true, filter: input => !excluded.has(path.basename(input)) })
await mkdir(`${target}/apps/web/lib`, { recursive: true })
await cp("../web/lib/parsers.ts", `${target}/apps/web/lib/parsers.ts`)
await cp("../../LICENSE", `${target}/LICENSE`)
await cp(".openai", `${target}/.openai`, { recursive: true })
await cp("drizzle", `${target}/drizzle`, { recursive: true })
await cp("dist-sites", `${target}/dist`, { recursive: true })
await writeFile(`${target}/.gitignore`, "node_modules/\ndist/\n.env\n.sites-runtime/\n")
await writeFile(`${target}/package.json`, JSON.stringify({ name: "personal-ui-vault-site", private: true, type: "module", scripts: { build: "npm --prefix apps/vault run build:sites && node scripts/copy-build.mjs" } }, null, 2))
await mkdir(`${target}/scripts`, { recursive: true })
await writeFile(`${target}/scripts/copy-build.mjs`, "import {cp} from 'node:fs/promises';await cp('apps/vault/dist-sites','dist',{recursive:true});\n")
console.log(JSON.stringify({ checkout: target, copied: true }))
