import { parentPort, workerData } from "node:worker_threads"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "tailwindcss"
import { resolveFile } from "./model.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const allowed = new Set([
  "react",
  "react-dom",
  "lucide-react",
  "motion",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "@radix-ui/react-slot",
])
const colors = Object.fromEntries(
  [
    "background",
    "foreground",
    "border",
    "input",
    "ring",
    "primary",
    "secondary",
    "muted",
    "accent",
    "destructive",
    "card",
    "popover",
  ].map((name) => [
    name,
    {
      DEFAULT: `hsl(var(--${name}))`,
      foreground: `hsl(var(--${name}-foreground))`,
    },
  ]),
)
try {
  const doc = workerData
  const files = Object.fromEntries(doc.files.map((f) => [f.path, f]))
  const utility =
    'import { clsx } from "clsx"; import { twMerge } from "tailwind-merge"; export function cn(...values) { return twMerge(clsx(values)); }'
  if (!files["lib/utils.ts"]) files["lib/utils.ts"] = { content: utility }
  const demo =
    doc.demo ||
    `import * as Components from './${doc.entry}'; const Preview = Components.default || Object.entries(Components).find(([key]) => /^[A-Z]/.test(key))?.[1]; export default function Demo(){ return Preview ? <Preview/> : <p>未找到导出的 React 组件，请填写演示代码。</p>; }`
  files["__vault_demo.tsx"] = { content: demo }
  files["__vault_main.tsx"] = {
    content: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Demo from './__vault_demo'; createRoot(document.getElementById('root')).render(<Demo/>);`,
  }
  const result = await build({
    entryPoints: ["__vault_main.tsx"],
    bundle: true,
    write: false,
    outdir: "out",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    plugins: [
      {
        name: "vault-files",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData?.resolved) return
            if (args.namespace === "file" && args.importer) return
            if (Object.hasOwn(files, args.path))
              return { path: args.path, namespace: "vault" }
            if (args.path.startsWith(".") || args.path.startsWith("@/")) {
              const target = resolveFile(files, args.path, args.importer)
              if (!target)
                throw new Error(
                  `缺少文件 ${args.path}，请通过 ZIP 导入依赖文件`,
                )
              return { path: target, namespace: "vault" }
            }
            const packageName = args.path.startsWith("@")
              ? args.path.split("/").slice(0, 2).join("/")
              : args.path.split("/")[0]
            if (
              args.path.includes("\\") ||
              args.path.split("/").some((part) => part === ".." || part === ".")
            )
              throw new Error("预览依赖路径不允许目录跳转")
            if (!allowed.has(packageName))
              throw new Error(
                `预览环境尚未安装 ${packageName}。源码和依赖可正常导出，预览需由管理员安装并加入白名单。`,
              )
            return builder.resolve(args.path, {
              resolveDir: root,
              kind: args.kind,
              pluginData: { resolved: true },
            })
          })
          builder.onLoad({ filter: /.*/, namespace: "vault" }, (args) => {
            const file = files[args.path]
            const ext = path.extname(args.path).slice(1)
            const asset = /^(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|svg)$/.test(
              ext,
            )
            return {
              contents:
                file.encoding === "base64"
                  ? Buffer.from(file.content, "base64")
                  : file.content,
              loader: asset
                ? "dataurl"
                : {
                    js: "jsx",
                    jsx: "jsx",
                    ts: "ts",
                    tsx: "tsx",
                    css: "css",
                    json: "json",
                  }[ext] || "text",
              resolveDir: root,
            }
          })
        },
      },
    ],
  })
  const rawCss = doc.files
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.content)
    .join("\n")
  const css = await postcss([
    tailwind({
      content: doc.files.map((f) => ({
        raw: f.content,
        extension: path.extname(f.path).slice(1),
      })),
      darkMode: "class",
      theme: {
        extend: {
          colors,
          borderRadius: {
            lg: "var(--radius)",
            md: "calc(var(--radius) - 2px)",
            sm: "calc(var(--radius) - 4px)",
          },
        },
      },
    }),
  ]).process(
    `@tailwind base; @tailwind components; @tailwind utilities;\n${rawCss}`,
    { from: undefined },
  )
  parentPort.postMessage({
    script: result.outputFiles.find((f) => f.path.endsWith(".js")).text,
    css: css.css,
  })
} catch (error) {
  parentPort.postMessage({
    error: error.errors?.map((e) => e.text).join("\n") || error.message,
  })
}
