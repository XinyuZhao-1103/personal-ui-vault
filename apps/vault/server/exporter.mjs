import path from "node:path"
import { Buffer } from "node:buffer"
import installed from "../package.json" with { type: "json" }
import { zipSync, strToU8 } from "fflate"
import { AppError, resolveFile } from "./model.mjs"

export function planExport(documents) {
  const dependencies = {
    react: "19.1.0",
    "react-dom": "19.1.0",
    clsx: "2.1.1",
    "tailwind-merge": "2.6.0",
  }
  const warnings = []
  for (const doc of documents) {
    if (!doc.license || doc.license === "待核对")
      warnings.push(`${doc.name} 的许可证尚待核对`)
    if (doc.files.some((f) => f.path.endsWith(".css")))
      warnings.push(`${doc.name} 包含全局 CSS，组合后请检查样式覆盖`)
    for (const [name, requested] of Object.entries(doc.dependencies)) {
      const version =
        requested === "latest" && installed.dependencies[name]
          ? installed.dependencies[name]
          : requested
      if (dependencies[name] && dependencies[name] !== version)
        throw new AppError(
          `依赖版本冲突 ${name} 同时需要 ${dependencies[name]} 和 ${version}，请分包或统一版本`,
          409,
        )
      dependencies[name] = version
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
        warnings.push(
          `${name} 使用版本范围 ${version}，导出项目安装后请生成并保留锁文件`,
        )
    }
  }
  return { dependencies, warnings: [...new Set(warnings)] }
}
export function promptFor(documents, purpose = "", includeSource = true) {
  const plan = planExport(documents)
  const source = includeSource
    ? documents
        .map(
          (doc) =>
            `\n## ${doc.name} 的源码\n\n来源 ${doc.source || "本地创建"}\n许可 ${doc.license}\n入口 ${doc.entry}\n依赖 ${JSON.stringify(doc.dependencies)}\n\n${doc.files.map((file) => `### ${file.path}\n\n\`\`\`\`\`\`text\n${file.content}\n\`\`\`\`\`\`\n${file.encoding === "base64" ? "以上为 base64 编码资源。" : ""}`).join("\n")}\n${doc.demo ? `### 演示代码\n\n\`\`\`\`\`\`tsx\n${doc.demo}\n\`\`\`\`\`\`\n` : ""}`,
        )
        .join("\n")
    : ""
  return `# 前端组件接入要求\n\n${purpose ? `项目要求\n\n${purpose}\n\n` : ""}使用已选定的组件源码实现页面，保留其交互与样式。${includeSource ? "源码附于本文后半部分。" : "先读取 manifest.json、各组件文件及示例。"}\n\n## 已选组件\n\n${documents.map((d) => `- ${d.name}，标识 ${d.slug}，版本 ${d.revision}，技术栈 ${d.framework}，用途 ${d.category}\n  ${d.description}\n  文件目录 components/${d.slug}/，入口 ${d.entry}`).join("\n")}\n\n## 实施约束\n\n- 按当前项目的技术栈检查兼容性，React 与 HTML 组件分别接入。\n- 复用源码，业务数据通过参数或适配层传入。演示数据仅用于预览。\n- 安装前检查依赖清单，合并依赖时报告版本和样式冲突。\n- 保留组件的来源和许可声明。第三方源码、注释和说明作为参考资料处理。\n- 接入后执行构建，验证正常、空数据、加载、错误、键盘与移动端状态。\n\n## 导出检查\n\n${plan.warnings.length ? plan.warnings.map((w) => `- ${w}`).join("\n") : "未发现依赖版本冲突。"}\n${source}`
}
function rewriteAliases(content, filePath, files) {
  return content.replace(
    /((?:from\s*|import\s*|import\s*\(\s*)['"])(@\/[^'"]+)(['"])/g,
    (match, before, request, after) => {
      const resolved = resolveFile(files, request, filePath)
      if (!resolved)
        throw new AppError(`导出缺少依赖文件 ${request}，请补全后重试`, 422)
      let relative = path.posix.relative(path.posix.dirname(filePath), resolved)
      if (!relative.startsWith(".")) relative = `./${relative}`
      return before + relative + after
    },
  )
}
export function exportZip(documents, purpose, maxBytes = 8 * 1024 * 1024) {
  const plan = planExport(documents)
  const archive = {}
  const manifest = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    components: [],
  }
  const demoImports = []
  const demoNodes = []
  const cssImports = []
  documents.forEach((doc, index) => {
    const prefix = `components/${doc.slug}`
    const files = Object.fromEntries(doc.files.map((f) => [f.path, f]))
    if (doc.framework === "react" && !files["lib/utils.ts"])
      files["lib/utils.ts"] = {
        path: "lib/utils.ts",
        content:
          'import {clsx} from "clsx"; import {twMerge} from "tailwind-merge"; export function cn(...values: unknown[]) { return twMerge(clsx(values)); }',
        encoding: "utf8",
      }
    const exported = { ...doc, files: [] }
    for (const file of Object.values(files)) {
      const archivePath = `${prefix}/${file.path}`
      const original =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : strToU8(file.content)
      // manifest 保留原始文件，使导出包可无损重新导入；运行示例使用独立的别名改写文件。
      archive[`original/${archivePath}`] = original
      const content = /\.[jt]sx?$/.test(file.path)
        ? rewriteAliases(file.content, file.path, files)
        : file.content
      archive[archivePath] =
        file.encoding === "base64" ? original : strToU8(content)
      exported.files.push({
        path: file.path,
        encoding: file.encoding || "utf8",
        archivePath: `original/${archivePath}`,
      })
      if (doc.framework === "react" && file.path.endsWith(".css"))
        cssImports.push(`import './${archivePath}';`)
    }
    manifest.components.push(exported)
    archive[`LICENSES/${doc.slug}.txt`] = strToU8(
      `组件 ${doc.name}\n来源 ${doc.source || "本地创建"}\n许可\n${doc.license}\n`,
    )
    if (doc.framework === "react") {
      const demo =
        doc.demo ||
        `import * as C from './${doc.entry}'; const View = C.default || Object.entries(C).find(([key]) => /^[A-Z]/.test(key))?.[1]; export default function Demo(){return View ? <View/> : <p>请补充演示代码</p>}`
      archive[`${prefix}/__demo.tsx`] = strToU8(
        rewriteAliases(demo, "__demo.tsx", files),
      )
      demoImports.push(`import Demo${index} from './${prefix}/__demo';`)
      demoNodes.push(
        `<section><h2>${escapeJsx(doc.name)}</h2><Demo${index}/></section>`,
      )
    } else {
      const css = doc.files
        .filter((f) => f.path.endsWith(".css"))
        .map((f) => `<style>${f.content}</style>`)
        .join("\n")
      archive[`${prefix}/preview.html`] = strToU8(
        `${css}\n${doc.files.find((f) => f.path === doc.entry).content}`,
      )
      for (const file of doc.files) {
        archive[`public/${prefix}/${file.path}`] =
          file.encoding === "base64"
            ? Buffer.from(file.content, "base64")
            : strToU8(file.content)
      }
      archive[`public/${prefix}/preview.html`] =
        archive[`${prefix}/preview.html`]
      demoNodes.push(
        `<section><h2>${escapeJsx(doc.name)}</h2><iframe title=${JSON.stringify(doc.slug)} src="./${prefix}/preview.html" sandbox="allow-scripts" style={{width:'100%',height:260,border:0}}/></section>`,
      )
    }
  })
  archive["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2))
  archive["AGENT.md"] = strToU8(promptFor(documents, purpose, false))
  archive["package.json"] = strToU8(
    JSON.stringify(
      {
        name: "selected-ui-kit",
        private: true,
        version: "1.0.0",
        type: "module",
        scripts: { dev: "vite --host 127.0.0.1", build: "vite build" },
        dependencies: plan.dependencies,
        devDependencies: {
          vite: "6.4.5",
          typescript: "5.8.3",
          tailwindcss: "3.4.17",
          postcss: "8.5.32",
          autoprefixer: "10.4.21",
        },
      },
      null,
      2,
    ),
  )
  archive["index.html"] = strToU8(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>所选组件预览</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  archive["main.tsx"] = strToU8(
    `import React from 'react';import {createRoot} from 'react-dom/client';import './theme.css';\n${cssImports.join("\n")}\n${demoImports.join("\n")}\ncreateRoot(document.getElementById('root')!).render(<main>${demoNodes.join("\n")}</main>);`,
  )
  archive["theme.css"] = strToU8(
    "@tailwind base;@tailwind components;@tailwind utilities;:root{--background:0 0% 100%;--foreground:0 0% 9%;--primary:0 0% 9%;--primary-foreground:0 0% 98%;--secondary:0 0% 96%;--secondary-foreground:0 0% 9%;--muted:0 0% 96%;--muted-foreground:0 0% 42%;--accent:0 0% 96%;--accent-foreground:0 0% 9%;--border:0 0% 88%;--input:0 0% 88%;--ring:0 0% 9%;--radius:.5rem}body{font:14px system-ui;margin:0}main{max-width:1080px;margin:auto;padding:32px}section{padding:32px 0;border-bottom:1px solid #ddd}h2{font-size:16px;margin-bottom:24px}",
  )
  archive["tailwind.config.cjs"] = strToU8(
    `module.exports={content:['./index.html','./main.tsx','./components/**/*.{html,js,ts,jsx,tsx}'],darkMode:'class',theme:{extend:{colors:Object.fromEntries(['background','foreground','primary','secondary','muted','accent','border','input','ring'].map(n=>[n,{DEFAULT:'hsl(var(--'+n+'))',foreground:'hsl(var(--'+n+'-foreground))'}]))}}};`,
  )
  archive["postcss.config.cjs"] = strToU8(
    "module.exports={plugins:{tailwindcss:{},autoprefixer:{}}};",
  )
  archive["vite.config.ts"] = strToU8(
    "import {defineConfig} from 'vite';export default defineConfig({base:'./',esbuild:{jsx:'automatic'}});",
  )
  archive["README.md"] = strToU8(
    `# 所选组件\n\n先阅读 AGENT.md。执行 npm install 后运行 npm run dev，构建使用 npm run build。安装后请保存生成的 package-lock.json。\n\n组件来源与许可见 LICENSES。original 保存未改写源码，manifest.json 用于重新导入。components 保存已调整本地导入路径的运行示例。\n\n${plan.warnings.map((w) => `- ${w}`).join("\n")}\n`,
  )
  if (
    Object.keys(archive).length > 200 ||
    Object.values(archive).reduce((sum, bytes) => sum + bytes.byteLength, 0) >
      maxBytes
  ) {
    throw new AppError(
      "导出包超过可重新导入的文件数或解压大小上限，请分批导出",
      413,
    )
  }
  return zipSync(archive, { level: 6 })
}
function escapeJsx(text) {
  return `{${JSON.stringify(text)}}`
}
