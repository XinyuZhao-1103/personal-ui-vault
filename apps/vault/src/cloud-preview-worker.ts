import * as esbuild from "esbuild-wasm"

const workerScope = self as unknown as {
  onmessage: (event: MessageEvent) => void
  postMessage: (value: unknown) => void
}
const escapeScript = (text: string) => text.replace(/<\/script/gi, "<\\/script")
const escapeStyle = (text: string) => text.replace(/<\/style/gi, "<\\/style")

workerScope.onmessage = async event => {
  try {
    const { document: doc, origin } = event.data
    const themeResponse = await fetch(`${origin}/compiler/theme.css`)
    const theme = await themeResponse.text()
    let content = ""
    let styles = doc.files.filter((file: { path: string }) => file.path.endsWith(".css")).map((file: { content: string }) => file.content).join("\n")
    if (doc.framework === "html") content = doc.files.find((file: { path: string }) => file.path === doc.entry).content
    else {
      await esbuild.initialize({ wasmURL: `${origin}/compiler/esbuild.wasm`, worker: false })
      const dependencies = await (await fetch(`${origin}/compiler/dependencies.json`)).json()
      const files = Object.fromEntries(doc.files.map((file: { path: string }) => [file.path, file]))
      files["lib/utils.ts"] ||= { content: 'import {clsx} from "clsx";import {twMerge} from "tailwind-merge";export function cn(...values: unknown[]){return twMerge(clsx(values))}' }
      files["__vault_demo.tsx"] = { content: doc.demo || `import * as C from './${doc.entry}';const View=C.default || Object.entries(C).find(([key])=>/^[A-Z]/.test(key))?.[1];export default function Demo(){return View ? <View/> : <p>请填写演示代码</p>}` }
      files["__vault_main.tsx"] = { content: "import React from 'react';import {createRoot} from 'react-dom/client';import Demo from './__vault_demo';createRoot(document.getElementById('root')).render(<Demo/>);" }
      const result = await esbuild.build({
        entryPoints: ["__vault_main.tsx"], bundle: true, write: false, outdir: "out", format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "isolated-files", setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            if (args.namespace === "dependency") {
              const target = new URL(args.path, `${origin}${args.importer}`).pathname
              if (!target.startsWith("/compiler/deps/")) throw new Error("预览依赖路径无效")
              return { path: target, namespace: "dependency" }
            }
            if (dependencies[args.path]) return { path: dependencies[args.path], namespace: "dependency" }
            const segments = args.path.startsWith("@/") ? args.path.slice(2).split("/") : args.path.startsWith(".") ? [...args.importer.split("/").slice(0, -1), ...args.path.split("/")] : [args.path]
            const normalized: string[] = []
            for (const part of segments) {
              if (!part || part === ".") continue
              if (part === "..") normalized.pop()
              else normalized.push(part)
            }
            const base = normalized.join("/")
            const target = [base, ...[".tsx", ".ts", ".jsx", ".js", ".css", ".json", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"].map(ext => base + ext)].find(path => Object.hasOwn(files, path))
            if (!target) throw new Error(`缺少文件或未支持的预览依赖 ${args.path}`)
            return { path: target, namespace: "component" }
          })
          builder.onLoad({ filter: /.*/, namespace: "dependency" }, async args => {
            const response = await fetch(`${origin}${args.path}`)
            if (!response.ok) throw new Error("预览依赖读取失败")
            return { contents: await response.text(), loader: "js" }
          })
          builder.onLoad({ filter: /.*/, namespace: "component" }, args => {
            const file = files[args.path]
            const ext = args.path.split(".").pop() || ""
            if (ext === "css") return { contents: "", loader: "js" }
            const asset = /^(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|svg)$/.test(ext)
            return { contents: file.encoding === "base64" ? Uint8Array.from(atob(file.content), char => char.charCodeAt(0)) : file.content, loader: asset ? "dataurl" : ({ js: "jsx", jsx: "jsx", ts: "ts", tsx: "tsx", json: "json" } as Record<string, esbuild.Loader>)[ext] || "text" }
          })
        } }],
      })
      content = `<div id="root"></div><script>${escapeScript(result.outputFiles!.find(file => file.path.endsWith(".js"))!.text)}</script>`
    }
    styles = styles.replace(/@tailwind\s+(base|components|utilities)\s*;/g, "")
    const runtimeResponse = await fetch(`${origin}/compiler/tailwind.js`)
    const runtime = await runtimeResponse.text()
    const csp = "default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;font-src data:;connect-src 'none';form-action 'none';base-uri 'none'"
    workerScope.postMessage({ html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style type="text/tailwindcss">${escapeStyle(theme + styles)}</style><script>${escapeScript(runtime)}</script><script>window.addEventListener('error',e=>parent.postMessage({type:'vault-preview-error',message:e.message},'*'));window.addEventListener('unhandledrejection',e=>parent.postMessage({type:'vault-preview-error',message:String(e.reason)},'*'));</script></head><body>${content}</body></html>` })
  } catch (error) {
    workerScope.postMessage({ error: (error as Error).message })
  }
}
