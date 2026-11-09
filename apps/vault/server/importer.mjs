import { unzipSync, strFromU8 } from "fflate"
import { Buffer } from "node:buffer"
import upstreamParsers from "../generated/upstream-parsers.cjs"
import { AppError, safePath, validateComponent } from "./model.mjs"
import { fetchPublicJson } from "./remote.mjs"
import { z } from "zod"

const registrySchema = z.object({
  name: z.string().min(1).max(100),
  title: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  license: z.string().max(4000).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        target: z.string().max(240).optional(),
        type: z.string().max(60).optional(),
        content: z.string().max(2 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(100),
  dependencies: z.array(z.string().max(200)).max(100).optional(),
  devDependencies: z.array(z.string().max(200)).max(100).optional(),
  registryDependencies: z.array(z.string().max(2000)).max(32).optional(),
  cssVars: z
    .record(z.string(), z.record(z.string(), z.string().max(300)))
    .optional(),
  css: z.record(z.string(), z.unknown()).optional(),
})

const {
  extractComponentNames,
  extractNPMDependencies,
} = upstreamParsers
export function analyze(code) {
  const detected = extractNPMDependencies(code)
  const dependencies = Object.fromEntries(
    Object.entries(detected).map(([name, version]) => [
      name.startsWith("@")
        ? name.split("/").slice(0, 2).join("/")
        : name.split("/")[0],
      version,
    ]),
  )
  return {
    exports: extractComponentNames(code),
    dependencies,
  }
}
export function readZip(bytes, config, defaults = {}) {
  let total = 0
  let count = 0
  let files
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/")) return false
        safePath.parse(file.name)
        if (
          ++count > 200 ||
          file.originalSize > config.maxBytes ||
          (total += file.originalSize) > config.maxBytes
        )
          throw new AppError("ZIP 解压后超过文件数量或大小上限", 413)
        if (/(^|\/)(node_modules|\.git)(\/|$)/.test(file.name))
          throw new AppError("ZIP 不应包含 node_modules 或 .git")
        return true
      },
    })
  } catch (error) {
    throw new AppError(error.message || "ZIP 文件损坏", error.status || 400)
  }
  if (files["manifest.json"]) {
    let manifest
    try {
      manifest = JSON.parse(strFromU8(files["manifest.json"]))
    } catch {
      throw new AppError("manifest.json 无效")
    }
    if (
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.components) ||
      !manifest.components.length ||
      manifest.components.length > config.maxSelection
    )
      throw new AppError("不支持的组件包格式或组件数量超限")
    return manifest.components.map((doc) =>
      validateComponent(
        {
          ...doc,
          files: doc.files.map((file) => {
            safePath.parse(file.archivePath)
            const content = files[file.archivePath]
            if (!content) throw new AppError(`组件包缺少 ${file.archivePath}`)
            return {
              path: file.path,
              encoding: file.encoding || "utf8",
              content:
                file.encoding === "base64"
                  ? Buffer.from(content).toString("base64")
                  : strFromU8(content),
            }
          }),
        },
        config.maxBytes,
      ),
    )
  }
  // 普通 ZIP 使用 component.json 明确入口与元数据，避免猜测后导入错误组件。
  if (!files["component.json"])
    throw new AppError(
      "普通 ZIP 需要根目录 component.json，填写 name、slug、entry 和 framework。也可以导入本站导出的源码包。",
    )
  let meta
  try {
    meta = JSON.parse(strFromU8(files["component.json"]))
  } catch {
    throw new AppError("component.json 无效")
  }
  const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i
  const sourceFiles = Object.entries(files)
    .filter(([p]) => p !== "component.json")
    .map(([p, content]) => ({
      path: p,
      content: binary.test(p)
        ? Buffer.from(content).toString("base64")
        : strFromU8(content),
      encoding: binary.test(p) ? "base64" : "utf8",
    }))
  return [
    validateComponent(
      { ...defaults, ...meta, files: sourceFiles },
      config.maxBytes,
    ),
  ]
}
export async function readRegistry(
  url,
  config,
  metadata = {},
  fetchItem = fetchPublicJson,
) {
  const visited = new Set()
  const files = new Map()
  const dependencies = {}
  const theme = {}
  const deadline = Date.now() + config.fetchTimeout
  async function collect(address) {
    if (visited.has(address)) return null
    if (visited.size >= 32)
      throw new AppError("Registry 依赖超过 32 项，请拆分导入")
    visited.add(address)
    let raw
    try {
      raw = await fetchItem(address, config, 0, deadline)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError("无法读取 Registry，请检查网络与链接", 502)
    }
    const parsed = registrySchema.safeParse(raw)
    if (!parsed.success)
      throw new AppError(
        "Registry 格式无效，需要单组件 JSON，files 中每个文件包含 path 和源码 content",
      )
    const item = parsed.data
    if (!Array.isArray(item.files) || !item.files.length)
      throw new AppError(
        "需要构建后的单组件 Registry JSON，包含 files 和 content 字段",
      )
    for (const file of item.files) {
      if (typeof file.content !== "string")
        throw new AppError(
          "Registry 未包含源码 content，请使用发布后的组件 JSON",
        )
      const standardDirectory = {
        "registry:ui": "components/ui",
        "registry:hook": "hooks",
        "registry:lib": "lib",
      }[file.type]
      let target =
        file.target ||
        (standardDirectory
          ? `${standardDirectory}/${file.path.split("/").pop()}`
          : file.path)
      if (target.startsWith("~/")) target = target.slice(2)
      safePath.parse(target)
      if (files.has(target) && files.get(target).content !== file.content)
        throw new AppError(`Registry 文件冲突 ${target}`)
      files.set(target, { path: target, content: file.content })
    }
    for (const [mode, values] of Object.entries(item.cssVars || {})) {
      if (
        !["light", "dark", "theme"].includes(mode) ||
        !values ||
        typeof values !== "object"
      )
        throw new AppError("Registry 主题变量结构无效")
      theme[mode] ||= {}
      for (const [key, value] of Object.entries(values)) {
        if (
          !/^[a-zA-Z0-9_-]+$/.test(key) ||
          typeof value !== "string" ||
          /[{};]/.test(value)
        )
          throw new AppError("Registry 主题变量无效")
        if (Object.hasOwn(theme[mode], key) && theme[mode][key] !== value)
          throw new AppError(`Registry 主题变量冲突 ${key}`)
        theme[mode][key] = value
      }
    }
    if (item.css && Object.keys(item.css).length)
      throw new AppError(
        "此 Registry 含自定义 CSS 对象，请导出源码 ZIP 后导入，以保留完整样式",
      )
    for (const dep of [
      ...(item.dependencies || []),
      ...(item.devDependencies || []),
    ]) {
      if (typeof dep !== "string") throw new AppError("Registry 依赖格式无效")
      const at = dep.lastIndexOf("@")
      const name = at > 0 ? dep.slice(0, at) : dep
      const version = at > 0 ? dep.slice(at + 1) : "latest"
      if (dependencies[name] && dependencies[name] !== version)
        throw new AppError(`Registry npm 依赖冲突 ${name}`)
      dependencies[name] = version
    }
    for (const dep of item.registryDependencies || []) {
      if (typeof dep !== "string" || dep.startsWith("@"))
        throw new AppError("命名空间依赖需要转换为完整 Registry HTTPS URL")
      const next = dep.startsWith("https://")
        ? dep
        : new URL(`${dep}.json`, address).href
      await collect(next)
    }
    return item
  }
  const item = await collect(url)
  let css = ""
  if (Object.keys(theme).length) {
    for (const [mode, values] of Object.entries(theme)) {
      if (
        !["light", "dark", "theme"].includes(mode) ||
        !values ||
        typeof values !== "object"
      )
        continue
      const declarations = Object.entries(values)
        .map(([key, value]) => {
          if (
            !/^[a-zA-Z0-9_-]+$/.test(key) ||
            typeof value !== "string" ||
            /[{};]/.test(value)
          )
            throw new AppError("Registry 主题变量无效")
          return `--${key}:${value}`
        })
        .join(";")
      css += `${mode === "dark" ? ".dark" : ":root"}{${declarations}}\n`
    }
  }
  if (item.css && Object.keys(item.css).length)
    throw new AppError(
      "此 Registry 含自定义 CSS 对象，请导出源码 ZIP 后导入，以保留完整样式",
    )
  if (css)
    files.set("registry-theme.css", {
      path: "registry-theme.css",
      content: css,
    })
  const first = [...files.keys()].find((p) => /\.[jt]sx?$/.test(p))
  if (!first) throw new AppError("Registry 缺少 React 入口")
  const document = {
    name: item.title || item.name,
    slug: item.name,
    description: item.description || "",
    framework: "react",
    category: "其他",
    source: url,
    license: item.license || "待核对",
    files: [...files.values()],
    entry: first,
    dependencies,
    ...metadata,
  }
  return validateComponent(document, config.maxBytes)
}
