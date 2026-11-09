import React, { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckSquare,
  ChevronRight,
  Code2,
  Folder,
  FolderPlus,
  Grid2X2,
  Layers,
  LogOut,
  Package,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Upload,
  X,
} from "lucide-react"
import "./style.css"
import {
  AccountSettings,
  type AccountSession,
  type AccountUser,
  type LoginProvider,
} from "./auth-admin"

type FileEntry = {
  path: string
  content: string
  encoding?: "utf8" | "base64"
}
type ComponentDoc = {
  id: string
  revision: number
  name: string
  slug: string
  description: string
  category: string
  framework: "react" | "html"
  tags: string[]
  source: string
  license: string
  entry: string
  demo: string
  files: FileEntry[]
  dependencies: Record<string, string>
  updatedAt?: string
}
type Summary = Pick<
  ComponentDoc,
  | "id"
  | "revision"
  | "name"
  | "slug"
  | "description"
  | "category"
  | "framework"
  | "updatedAt"
>
type Kit = { id: string; name: string; count: number; created_at: string }
const categories = [
  "按钮",
  "表格",
  "分页",
  "表单",
  "导航",
  "卡片",
  "反馈",
  "其他",
]
const starter =
  "import React from 'react';\n\nexport default function Button() {\n  return <button className=\"rounded-md bg-neutral-900 px-5 py-2.5 text-white\">保存修改</button>;\n}\n"
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers:
      options.body instanceof Blob
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  })
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login")
      window.dispatchEvent(new Event("vault-session-expired"))
    let error
    try {
      error = await response.json()
    } catch {
      error = { error: `请求失败 HTTP ${response.status}` }
    }
    throw new Error(error.error || "请求失败")
  }
  const value = await response.json()
  if (url === "/api/preview" && value.compiler === "browser") {
    const { compileCloudPreview } = await import("./cloud-preview")
    return (await compileCloudPreview(value.document)) as T
  }
  if (url === "/api/logout" && value.redirect) location.assign(value.redirect)
  return value
}
const post = <T,>(url: string, body: unknown) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body) })
let thumbnailQueue = Promise.resolve()
function MiniPreview({ item }: { item: Summary }) {
  const root = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState("")
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        thumbnailQueue = thumbnailQueue.then(async () => {
          if (!active) return
          try {
            const value = await post<{ html: string }>("/api/preview", {
              id: item.id,
              revision: item.revision,
            })
            if (active) setHtml(value.html)
          } catch {
            if (active) setFailed(true)
          }
        })
      },
      { rootMargin: "100px" },
    )
    if (root.current) observer.observe(root.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [item.id, item.revision])
  return (
    <div className="mini-preview" ref={root}>
      {html ? (
        <iframe
          title={`${item.name}缩略预览`}
          sandbox="allow-scripts"
          srcDoc={html}
          tabIndex={-1}
        />
      ) : (
        <div className="source-art">
          <Code2 size={30} strokeWidth={1.2} />
          <code>{item.slug}</code>
          <span>
            {failed ? "打开详情查看预览错误" : "正在准备实时预览…"}
            <ArrowRight size={13} />
          </span>
        </div>
      )}
    </div>
  )
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function ErrorNote({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    ref.current?.showModal()
    return () => previous?.focus()
  }, [])
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      onCancel={onClose}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
function Preview({ document: doc }: { document: ComponentDoc }) {
  const [html, setHtml] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    let active = true
    setBusy(true)
    setError("")
    setHtml("")
    post<{ html: string }>("/api/preview", {
      id: doc.id,
      revision: doc.revision,
    })
      .then((result) => {
        if (active) setHtml(result.html)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    const onMessage = (e: MessageEvent) => {
      if (
        e.source === frame.current?.contentWindow &&
        e.data?.type === "vault-preview-error"
      )
        setError(String(e.data.message).slice(0, 1000))
    }
    window.addEventListener("message", onMessage)
    return () => {
      active = false
      window.removeEventListener("message", onMessage)
    }
  }, [doc.id, doc.revision, attempt])
  return (
    <div className="preview-well">
      <div className="preview-toolbar">
        <span>
          <span className="status-dot" />
          隔离预览
        </span>
        <button onClick={() => setAttempt(attempt + 1)} disabled={busy}>
          重新运行
        </button>
      </div>
      {busy && <div className="loading">正在编译组件…</div>}
      <ErrorNote message={error} />
      {html && (
        <iframe
          ref={frame}
          title={`${doc.name}实时预览`}
          sandbox="allow-scripts"
          srcDoc={html}
        />
      )}
      <p className="preview-foot">网络请求已限制 · 演示数据仅用于预览</p>
    </div>
  )
}
function Detail({
  doc,
  onClose,
  onEdit,
  selectedRevision,
  onSelect,
}: {
  doc: ComponentDoc
  onClose: () => void
  onEdit?: () => void
  selectedRevision?: number
  onSelect: (document: ComponentDoc) => void
}) {
  const [tab, setTab] = useState("preview")
  const [file, setFile] = useState(doc.entry)
  const [versions, setVersions] = useState<
    { revision: number; createdAt: string }[]
  >([])
  const [shown, setShown] = useState(doc)
  const selected = selectedRevision === shown.revision
  const [error, setError] = useState("")
  useEffect(() => {
    request<typeof versions>(`/api/components/${doc.id}/versions`)
      .then(setVersions)
      .catch((e) => setError(e.message))
  }, [doc.id])
  async function version(revision: number) {
    try {
      const value = await request<ComponentDoc>(
        `/api/components/${doc.id}?revision=${revision}`,
      )
      setShown(value)
      setFile(value.entry)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const current = shown.files.find((f) => f.path === file)
  return (
    <Modal title={doc.name} onClose={onClose} wide>
      <div className="detail-meta">
        <span className="badge">{doc.category}</span>
        <span>
          {doc.framework === "react" ? "React / TypeScript" : "HTML / CSS"}
        </span>
        <label>
          版本{" "}
          <select
            value={shown.revision}
            onChange={(e) => version(Number(e.target.value))}
          >
            {versions.map((v) => (
              <option value={v.revision} key={v.revision}>
                v{v.revision}
              </option>
            ))}
          </select>
        </label>
        {onEdit && <button onClick={onEdit}>编辑新版本</button>}
        <button
          className={selected ? "button selected" : "button primary"}
          onClick={() => onSelect(shown)}
        >
          {selected ? <Check size={16} /> : <Plus size={16} />}{" "}
          {selected ? "已加入选择" : "加入选择"}
        </button>
      </div>
      <p className="description">{shown.description || "尚未填写描述"}</p>
      <ErrorNote message={error} />
      <div className="tabs">
        {[
          ["preview", "实时预览"],
          ["code", "组件源码"],
          ["info", "依赖与来源"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "preview" && <Preview document={shown} />}{" "}
      {tab === "code" && (
        <div className="code-layout">
          <div className="file-list">
            {shown.files.map((f) => (
              <button
                className={file === f.path ? "active" : ""}
                onClick={() => setFile(f.path)}
                key={f.path}
              >
                {f.path}
              </button>
            ))}
          </div>
          <pre>
            {current?.encoding === "base64"
              ? "二进制资源随源码包导出"
              : current?.content}
          </pre>
        </div>
      )}
      {tab === "info" && (
        <div className="info-grid">
          <div>
            <h3>npm 依赖</h3>
            <pre>{JSON.stringify(shown.dependencies, null, 2)}</pre>
            <h3>标签</h3>
            <p>{shown.tags.join(" / ") || "—"}</p>
          </div>
          <div>
            <h3>来源</h3>
            <p className="wrap">{shown.source || "本地创建"}</p>
            <h3>许可声明</h3>
            <pre>{shown.license}</pre>
            <h3>组件标识</h3>
            <code>{shown.slug}</code>
          </div>
        </div>
      )}
    </Modal>
  )
}
function ImportForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ComponentDoc
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState("code")
  const [framework, setFramework] = useState<"react" | "html">(
    initial?.framework || "react",
  )
  const [name, setName] = useState(initial?.name || "")
  const [slug, setSlug] = useState(initial?.slug || "")
  const [category, setCategory] = useState(initial?.category || "按钮")
  const [description, setDescription] = useState(initial?.description || "")
  const [tags, setTags] = useState(initial?.tags.join(", ") || "")
  const [source, setSource] = useState(initial?.source || "")
  const [license, setLicense] = useState(initial?.license || "待核对")
  const [entry, setEntry] = useState(initial?.entry || "button.tsx")
  const [code, setCode] = useState(
    initial?.files.find((f) => f.path === initial.entry)?.content || starter,
  )
  const [css, setCss] = useState(
    initial?.files.find((f) => f.path.endsWith(".css"))?.content || "",
  )
  const [demo, setDemo] = useState(initial?.demo || "")
  const [dependencies, setDependencies] = useState(
    JSON.stringify(initial?.dependencies || {}, null, 2),
  )
  const [url, setUrl] = useState("")
  const [zip, setZip] = useState<File | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  async function analyze() {
    setError("")
    try {
      const value = await post<{
        exports: string[]
        dependencies: Record<string, string>
      }>("/api/analyze", { code })
      setDependencies(
        JSON.stringify(
          { ...value.dependencies, ...JSON.parse(dependencies) },
          null,
          2,
        ),
      )
      setMessage(
        `识别导出 ${value.exports.join("、") || "无命名导出"}，已补充依赖清单。`,
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setBusy(true)
    try {
      if (mode === "zip") {
        if (!zip) throw new Error("请选择 ZIP 文件")
        await request("/api/import/zip", {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: zip,
        })
      } else if (mode === "registry") {
        await post("/api/import/registry", {
          url,
          ...(name ? { name } : {}),
          ...(slug ? { slug } : {}),
        })
      } else {
        const cssPath =
          initial?.files.find((f) => f.path.endsWith(".css"))?.path ||
          "styles.css"
        const files = (initial?.files || []).filter(
          (f) => f.path !== initial?.entry && f.path !== cssPath,
        )
        files.push({ path: entry, content: code })
        if (css.trim()) files.push({ path: cssPath, content: css })
        const parsedDeps = JSON.parse(dependencies)
        const auto =
          framework === "react"
            ? await post<{ dependencies: Record<string, string> }>(
                "/api/analyze",
                { code: `${code}\n${demo}` },
              )
            : { dependencies: {} }
        const document = {
          name,
          slug,
          category,
          framework,
          description,
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          source,
          license,
          entry,
          files,
          demo,
          dependencies: { ...auto.dependencies, ...parsedDeps },
          ...(initial ? { expectedRevision: initial.revision } : {}),
        }
        await request(
          initial ? `/api/components/${initial.id}` : "/api/components",
          { method: initial ? "PUT" : "POST", body: JSON.stringify(document) },
        )
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={initial ? "编辑组件 · 保存为新版本" : "导入组件"}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        {!initial && (
          <div className="tabs">
            {[
              ["code", "粘贴源码"],
              ["registry", "Registry 链接"],
              ["zip", "上传 ZIP"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={mode === value ? "active" : ""}
                onClick={() => {
                  setMode(value)
                  setError("")
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <ErrorNote message={error} />
        {mode === "zip" ? (
          <div className="upload-zone">
            <Upload size={28} />
            <h3>将组件源码收进你的库</h3>
            <p>支持本站导出的组件包，或包含 component.json 的源码 ZIP。</p>
            <input
              aria-label="组件 ZIP 文件"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setZip(e.target.files?.[0] || null)}
            />
            <details>
              <summary>查看 component.json 示例</summary>
              <pre>
                {JSON.stringify(
                  {
                    name: "我的按钮",
                    slug: "my-button",
                    framework: "react",
                    category: "按钮",
                    entry: "button.tsx",
                    license: "MIT",
                    dependencies: {},
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        ) : mode === "registry" ? (
          <div className="form-stack">
            <p className="description">
              粘贴发布后的组件 JSON
              链接。会读取源码和递归依赖，导入后保存本地快照。
            </p>
            <label>
              Registry HTTPS URL
              <input
                required
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://ui.shadcn.com/r/styles/new-york/button.json"
              />
            </label>
            <div className="form-grid">
              <label>
                自定义名称（可选）
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                自定义标识（可选）
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="my-button"
                />
              </label>
            </div>
            <p className="hint">
              仅支持公网 HTTPS；命名空间依赖需要完整
              URL。导入后请核对许可和演示入口。
            </p>
          </div>
        ) : (
          <div className="import-grid">
            <div className="form-stack">
              <div className="form-grid">
                <label>
                  组件名称
                  <input
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如，极简操作按钮"
                  />
                </label>
                <label>
                  唯一标识
                  <input
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={100}
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="quiet-button"
                  />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  类别
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  技术栈
                  <select
                    value={framework}
                    onChange={(e) => {
                      const next = e.target.value as "react" | "html"
                      setFramework(next)
                      if (!initial) {
                        setEntry(next === "html" ? "index.html" : "button.tsx")
                        setCode(
                          next === "html"
                            ? "<button>保存修改</button>"
                            : starter,
                        )
                      }
                    }}
                  >
                    <option value="react">React / TypeScript</option>
                    <option value="html">HTML / CSS</option>
                  </select>
                </label>
              </div>
              <label>
                描述
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="组件的特点，以及适合什么场景"
                />
              </label>
              <label>
                标签
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="简洁, 后台, 紧凑"
                />
              </label>
              <label>
                来源
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="原始链接或作者"
                />
              </label>
              <label>
                许可声明
                <textarea
                  rows={2}
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                />
              </label>
            </div>
            <div className="form-stack">
              <label>
                入口文件
                <input
                  required
                  value={entry}
                  onChange={(e) => setEntry(e.target.value)}
                />
              </label>
              <label>
                组件代码
                <textarea
                  className="editor"
                  rows={12}
                  required
                  value={code}
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <label>
                补充 CSS
                <textarea
                  className="editor"
                  rows={4}
                  value={css}
                  spellCheck={false}
                  onChange={(e) => setCss(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setAdvanced(!advanced)}
              >
                <SlidersHorizontal size={14} />
                {advanced ? "收起高级设置" : "演示代码与依赖设置"}
              </button>
              {advanced && (
                <>
                  <label>
                    演示代码（默认导出 React 组件）
                    <textarea
                      className="editor"
                      rows={5}
                      value={demo}
                      spellCheck={false}
                      onChange={(e) => setDemo(e.target.value)}
                      placeholder="import Button from './button'; export default function Demo(){return <Button/>}"
                    />
                  </label>
                  <label>
                    npm 依赖 JSON
                    <textarea
                      className="editor"
                      rows={4}
                      value={dependencies}
                      onChange={(e) => setDependencies(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={analyze}>
                    识别代码依赖
                  </button>
                  <p className="hint">
                    {message ||
                      "预览内置 React、Motion、Lucide、clsx、tailwind-merge、CVA 和 Radix Slot。其他依赖会在预览时明确提示。"}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <span className="hint">
            {initial
              ? "历史版本会保留，组件集继续引用原快照。"
              : "导入后可在详情中运行预览和编辑。"}
          </span>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : initial ? "保存新版本" : "导入组件"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function ExportPanel({
  selection,
  onClose,
}: {
  selection: ComponentDoc[]
  onClose: () => void
}) {
  const [purpose, setPurpose] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [warnings, setWarnings] = useState<string[]>([])
  const [prompt, setPrompt] = useState("")
  const body = {
    selection: selection.map((d) => ({ id: d.id, revision: d.revision })),
    purpose,
  }
  useEffect(() => {
    post<{ warnings: string[] }>("/api/export/check", body)
      .then((v) => setWarnings(v.warnings))
      .catch((e) => setError(e.message))
  }, [])
  async function output(format: string) {
    setBusy(format)
    setError("")
    try {
      if (format === "prompt") {
        const value = await post<{ text: string }>("/api/export", {
          ...body,
          format,
        })
        setPrompt(value.text)
        download(
          new Blob([value.text], { type: "text/markdown;charset=utf-8" }),
          "AGENT.md",
        )
      } else {
        const response = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, format }),
        })
        if (!response.ok) throw new Error((await response.json()).error)
        download(await response.blob(), "selected-ui-kit.zip")
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy("")
    }
  }
  return (
    <Modal title="导出给 Agent" onClose={onClose}>
      <p className="description">{selection.length} 个组件，已固定所选版本。</p>
      <div className="export-list">
        {selection.map((d) => (
          <div key={d.id}>
            <Code2 size={16} />
            <span>{d.name}</span>
            <code>v{d.revision}</code>
          </div>
        ))}
      </div>
      <label className="form-stack">
        项目要求（可选）
        <textarea
          rows={3}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="例如，使用这些组件构建订单管理页，表格采用服务端分页。"
        />
      </label>
      {warnings.length > 0 && (
        <div className="warning">
          <h3>导出检查</h3>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote message={error} />
      <div className="export-options">
        <button disabled={!!busy} onClick={() => output("prompt")}>
          <Code2 size={20} />
          <strong>提示词文件</strong>
          <span>组件选择、版本与接入要求</span>
        </button>
        <button disabled={!!busy} onClick={() => output("zip")}>
          <Package size={20} />
          <strong>源码 ZIP</strong>
          <span>源码、资源、示例与许可</span>
        </button>
      </div>
      {busy && <p role="status">正在生成导出文件…</p>}
      {prompt && (
        <details>
          <summary>查看提示词</summary>
          <pre>{prompt}</pre>
        </details>
      )}
      <p className="hint">
        ZIP 包可重新导入本站，也可交给 Agent 接入现有项目。
      </p>
    </Modal>
  )
}
function TokenSettings({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<
    { id: string; name: string; created_at: string }[]
  >([])
  const [secret, setSecret] = useState("")
  const [error, setError] = useState("")
  async function refresh() {
    try {
      setTokens(await request("/api/tokens"))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    refresh()
  }, [])
  async function create() {
    try {
      const value = await post<{ token: string }>("/api/tokens", {})
      setSecret(value.token)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function revoke(id: string) {
    try {
      await request(`/api/tokens/${id}`, { method: "DELETE" })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Modal title="Agent 访问" onClose={onClose}>
      <p className="description">
        只读 Token 可读取组件、版本和 Registry 接口。请交给可信任的 Agent。
      </p>
      <ErrorNote message={error} />
      <button className="primary" onClick={create}>
        创建只读 Token
      </button>
      {secret && (
        <div className="warning">
          <h3>请保存，新 Token 仅显示这一次</h3>
          <textarea readOnly value={secret} aria-label="新建的只读 Token" />
          <button
            onClick={() => {
              download(new Blob([secret]), "vault-readonly-token.txt")
              setSecret("")
            }}
          >
            下载并隐藏
          </button>
        </div>
      )}
      <div className="token-list">
        {tokens.map((t) => (
          <div key={t.id}>
            <span>
              {t.name}
              <small>{new Date(t.created_at).toLocaleString("zh-CN")}</small>
            </span>
            <button onClick={() => revoke(t.id)}>撤销</button>
          </div>
        ))}
      </div>
      <h3>读取方式</h3>
      <pre>{`GET ${location.origin}/api/components\nGET ${location.origin}/api/registry/{组件ID}\nAuthorization: Bearer <你的Token>`}</pre>
    </Modal>
  )
}
function App() {
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        event.key === "/" &&
        !target.closest("input,textarea,select,[contenteditable],dialog")
      ) {
        const search = document.querySelector<HTMLInputElement>(
          'input[aria-label="搜索组件"]',
        )
        if (search) {
          event.preventDefault()
          search.focus()
        }
      }
    }
    window.addEventListener("keydown", focusSearch)
    return () => window.removeEventListener("keydown", focusSearch)
  }, [])
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [user, setUser] = useState<AccountUser | null>(null)
  const [providers, setProviders] = useState<LoginProvider[]>([])
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [loginBusy, setLoginBusy] = useState(false)
  const [items, setItems] = useState<Summary[]>([])
  const [kits, setKits] = useState<Kit[]>([])
  const [kitPage, setKitPage] = useState(1)
  const [kitTotal, setKitTotal] = useState(0)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("")
  const [framework, setFramework] = useState("")
  const [view, setView] = useState("library")
  const [selected, setSelected] = useState<Map<string, ComponentDoc>>(new Map())
  const [maxSelection, setMaxSelection] = useState(50)
  const [detail, setDetail] = useState<ComponentDoc | null>(null)
  const [editing, setEditing] = useState<ComponentDoc | undefined>()
  const [modal, setModal] = useState("")
  const [kitName, setKitName] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    request<AccountSession>("/api/session")
      .then((v) => {
        setAuthenticated(v.authenticated)
        setUser(v.user)
        setProviders(v.providers || [])
        setMaxSelection(v.limits.maxSelection)
      })
      .catch((e) => {
        setAuthenticated(false)
        setLoginError(e.message)
      })
  }, [])
  useEffect(() => {
    const expire = () => {
      setAuthenticated(false)
      setUser(null)
      setSelected(new Map())
      setDetail(null)
      setModal("")
      setView("library")
      setLoginError("登录已失效，请重新登录。")
    }
    window.addEventListener("vault-session-expired", expire)
    return () => window.removeEventListener("vault-session-expired", expire)
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query)
      setPage(1)
    }, 250)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    if (!authenticated) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    request<{ items: Summary[]; total: number; pages: number }>(
      `/api/components?${new URLSearchParams({ q: search, category, framework, page: String(page), size: "12" })}`,
      { signal: controller.signal },
    )
      .then((v) => {
        setItems(v.items)
        setTotal(v.total)
        setPages(v.pages)
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [authenticated, search, category, framework, page, refreshKey])
  useEffect(() => {
    if (!authenticated) return
    request<{ items: Kit[]; total: number }>(`/api/kits?page=${kitPage}`)
      .then((v) => {
        setKits(v.items)
        setKitTotal(v.total)
      })
      .catch((e) => setError(e.message))
  }, [authenticated, kitPage, refreshKey])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(""), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  async function login(e: React.FormEvent) {
    e.preventDefault()
    setLoginError("")
    setLoginBusy(true)
    try {
      await post("/api/login", { username, password })
      const session = await request<AccountSession>("/api/session")
      if (!session.authenticated || !session.user)
        throw new Error("登录会话未建立，请重试。")
      setUser(session.user)
      setProviders(session.providers || [])
      setMaxSelection(session.limits.maxSelection)
      setAuthenticated(session.authenticated)
      setPassword("")
    } catch (e) {
      setLoginError((e as Error).message)
    } finally {
      setLoginBusy(false)
    }
  }
  async function open(id: string) {
    try {
      setDetail(await request(`/api/components/${id}`))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function toggle(item: Summary | ComponentDoc) {
    setError("")
    if (selected.get(item.id)?.revision === item.revision) {
      setSelected((previous) => {
        const next = new Map(previous)
        next.delete(item.id)
        return next
      })
      return
    }
    if (selected.size >= maxSelection && !selected.has(item.id)) {
      setError(`最多选择 ${maxSelection} 个组件`)
      return
    }
    try {
      const doc =
        "files" in item
          ? item
          : await request<ComponentDoc>(`/api/components/${item.id}`)
      setSelected((previous) => {
        if (previous.size >= maxSelection && !previous.has(doc.id))
          return previous
        return new Map(previous).set(doc.id, doc)
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function selectPage() {
    try {
      const docs = await Promise.all(
        items
          .filter((i) => !selected.has(i.id))
          .map((i) => request<ComponentDoc>(`/api/components/${i.id}`)),
      )
      setSelected((previous) => {
        const next = new Map(previous)
        for (const doc of docs) {
          if (next.size >= maxSelection) break
          next.set(doc.id, doc)
        }
        return next
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function seed() {
    try {
      await post("/api/examples", {})
      setRefreshKey((v) => v + 1)
      setNotice("示例组件已加入，可随时预览和导出。")
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function loadKit(id: string) {
    try {
      const kit = await request<{ name: string; items: ComponentDoc[] }>(
        `/api/kits/${id}`,
      )
      setSelected(new Map(kit.items.map((d) => [d.id, d])))
      setView("selected")
      setNotice(`已载入“${kit.name}”的固定版本。`)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function saveKit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await post("/api/kits", {
        name: kitName,
        selection: [...selected.values()].map((d) => ({
          id: d.id,
          revision: d.revision,
        })),
      })
      setModal("")
      setKitName("")
      setRefreshKey((v) => v + 1)
      setNotice("组件集已保存，引用版本已固定。")
    } catch (e) {
      setError((e as Error).message)
    }
  }
  function closeModal() {
    setModal("")
    setEditing(undefined)
  }
  function signedOut() {
    setAuthenticated(false)
    setUser(null)
    setSelected(new Map())
    setItems([])
    setKits([])
    setDetail(null)
    setModal("")
    setView("library")
    setError("")
    setNotice("")
  }
  const isAdmin = user?.role === "admin"
  if (!authenticated)
    return (
      <div className="login-page">
        <div className="login-brand">
          <Layers size={28} />
          <span>拾 UI</span>
        </div>
        <form className="login-form" onSubmit={login}>
          <div>
            <span className="eyebrow">拾 UI · 组件工作空间</span>
            <h1>登录拾 UI</h1>
          </div>
          <p>把好设计，留给下一次。使用网站账号进入组件库。</p>
          <label>
            账号
            <input
              autoFocus
              required
              minLength={3}
              maxLength={64}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              required
              maxLength={256}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <ErrorNote message={loginError} />
          <button
            className="primary"
            disabled={loginBusy || authenticated === null}
          >
            {loginBusy
              ? "正在登录…"
              : authenticated === null
                ? "正在连接…"
                : "进入组件库"}
            <ArrowRight size={16} />
          </button>
          {providers.length > 0 && (
            <div className="oauth-login">
              <span>或使用第三方账号</span>
              <div>
                {providers.map((provider) => (
                  <a
                    className="oauth-button"
                    key={provider.id}
                    href={`/api/auth/${encodeURIComponent(provider.id)}/start`}
                  >
                    {provider.name}
                  </a>
                ))}
              </div>
            </div>
          )}
          <p className="login-help">
            账号由管理员创建。如忘记密码，请联系管理员重置。
          </p>
          <small>
            <ShieldCheck size={14} />
            独立账号登录 · 按身份授权访问
          </small>
        </form>
        <footer>基于 21st.dev 开源项目构建</footer>
      </div>
    )
  const visible = view === "selected" ? [...selected.values()] : items
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="拾UI首页">
          <Layers size={25} />
          <strong>拾 UI</strong>
          <span>个人组件库</span>
        </a>
        <div className="workspace">
          <span className="workspace-mark">UI</span>
          <div>
            <strong>
              {user?.displayName || user?.username || "拾 UI 用户"}
            </strong>
            <small>
              {isAdmin ? "管理员 · 维护与管理" : "访客 · 浏览与导出"}
            </small>
          </div>
          <ShieldCheck size={15} />
        </div>
        <div className="nav-caption">工作空间</div>
        <nav>
          <button
            className={view === "library" ? "active" : ""}
            onClick={() => {
              setView("library")
              setCategory("")
              setPage(1)
            }}
          >
            <Grid2X2 size={17} />
            全部组件
          </button>
          <button
            className={view === "selected" ? "active" : ""}
            onClick={() => setView("selected")}
          >
            <CheckSquare size={17} />
            当前选择<span>{selected.size}</span>
          </button>
          <button
            className={view === "kits" ? "active" : ""}
            onClick={() => setView("kits")}
          >
            <Folder size={17} />
            组件集
          </button>
        </nav>
        <div className="nav-caption category-caption">按类别浏览</div>
        <nav className="category-nav">
          {categories.map((c) => (
            <button
              className={category === c && view === "library" ? "active" : ""}
              onClick={() => {
                setCategory(c)
                setView("library")
                setPage(1)
              }}
              key={c}
            >
              <span className="category-dot" />
              {c}
              <ChevronRight size={13} />
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "account" ? "active" : ""}
            onClick={() => setView("account")}
          >
            <Settings2 size={17} />
            账号与安全
          </button>
          <button
            onClick={async () => {
              try {
                await post("/api/logout", {})
                signedOut()
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          >
            <LogOut size={17} />
            退出登录
          </button>
          <small>基于 21st.dev · Self-hosted</small>
        </div>
      </aside>
      <div className="work-area">
        <header className="topbar">
          <span>
            我的工作空间 <ChevronRight size={13} />{" "}
            {view === "account"
              ? "账号与安全"
              : view === "kits"
                ? "组件集"
                : view === "selected"
                  ? "当前选择"
                  : "组件库"}
          </span>
          <span className="private-label">
            <span className="status-dot" />
            {isAdmin ? "管理员" : "访客"}
          </span>
          <div className="mobile-tools">
            <button
              aria-label="打开账号与安全"
              onClick={() => setView("account")}
            >
              <Settings2 size={17} />
            </button>
            <button
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await post("/api/logout", {})
                  signedOut()
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="sheet">
          {view === "account" && user ? (
            <AccountSettings
              user={user}
              api={request}
              onSignedOut={() => {
                signedOut()
                setLoginError("密码已修改，请使用新密码重新登录。")
              }}
              onTokens={() => setModal("settings")}
            />
          ) : (
            <>
              <div className="page-title">
                <div>
                  <h1>
                    {view === "kits"
                      ? "组件集"
                      : view === "selected"
                        ? "为下一个项目挑选"
                        : category || "组件库"}
                  </h1>
                  <p>
                    {view === "kits"
                      ? "为不同项目保留一套搭配，固定组件版本。"
                      : view === "selected"
                        ? "选好的组件集中在这里，打包后交给 Agent。"
                        : "让每一个喜欢的组件，都有下一次出场。"}
                  </p>
                </div>
                {isAdmin && (
                  <button
                    className="primary"
                    onClick={() => {
                      setEditing(undefined)
                      setModal("import")
                    }}
                  >
                    <Plus size={17} />
                    导入组件
                  </button>
                )}
              </div>
              <ErrorNote message={error} />
              {notice && (
                <div className="notice" role="status">
                  <Check size={16} />
                  {notice}
                </div>
              )}
              {view !== "kits" && (
                <>
                  <div className="filter-row">
                    <div className="search">
                      <Search size={17} />
                      <input
                        aria-label="搜索组件"
                        placeholder="搜索名称、描述或标识…"
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value)
                          if (view === "selected") setView("library")
                        }}
                      />
                      <kbd>/</kbd>
                    </div>
                    <select
                      className="mobile-category"
                      aria-label="筛选类别"
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value)
                        setPage(1)
                      }}
                    >
                      <option value="">全部类别</option>
                      {categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <select
                      aria-label="筛选技术栈"
                      value={framework}
                      onChange={(e) => {
                        setFramework(e.target.value)
                        setPage(1)
                      }}
                    >
                      <option value="">全部技术栈</option>
                      <option value="react">React</option>
                      <option value="html">HTML / CSS</option>
                    </select>
                    <div className="filter-spacer" />
                    <span className="result-count">
                      {view === "selected" ? selected.size : total} 个组件
                    </span>
                    {view === "library" && items.length > 0 && (
                      <button className="text-button" onClick={selectPage}>
                        <CheckSquare size={15} />
                        选择本页
                      </button>
                    )}
                  </div>
                  {loading && view === "library" ? (
                    <div className="loading">正在读取组件…</div>
                  ) : visible.length > 0 ? (
                    <div className="component-grid">
                      {visible.map((item) => (
                        <article
                          className={`component-card ${selected.has(item.id) ? "is-selected" : ""}`}
                          key={item.id}
                        >
                          <div className="card-visual">
                            <button
                              className="card-open"
                              aria-label={`预览${item.name}`}
                              onClick={() =>
                                "files" in item
                                  ? setDetail(item as ComponentDoc)
                                  : open(item.id)
                              }
                            >
                              <MiniPreview item={item} />
                            </button>
                            <button
                              className="select-control"
                              aria-label={`${selected.has(item.id) ? "取消选择" : "选择"}${item.name}`}
                              aria-pressed={selected.has(item.id)}
                              onClick={() => toggle(item)}
                            >
                              {selected.has(item.id) ? (
                                <CheckSquare size={19} />
                              ) : (
                                <Square size={19} />
                              )}
                            </button>
                            <span className="framework-label">
                              {item.framework === "react" ? "React" : "HTML"}
                            </span>
                          </div>
                          <div className="card-body">
                            <button
                              className="card-title"
                              onClick={() =>
                                "files" in item
                                  ? setDetail(item as ComponentDoc)
                                  : open(item.id)
                              }
                            >
                              {item.name}
                              <ArrowRight size={14} />
                            </button>
                            <p>
                              {item.description ||
                                "打开组件查看源码与实时预览。"}
                            </p>
                            <div className="card-foot">
                              <span>{item.category}</span>
                              <code>v{item.revision}</code>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-symbol">
                        <Layers size={40} strokeWidth={1} />
                      </div>
                      <h2>
                        {view === "selected"
                          ? "给下一个项目选几件好设计"
                          : search || category || framework
                            ? "没有找到匹配组件"
                            : "你的组件收藏，从这里开始"}
                      </h2>
                      <p>
                        {view === "selected"
                          ? "从组件库加入表格、按钮和分页，再导出给 Agent。"
                          : search || category || framework
                            ? "尝试其他关键词，或清除筛选。"
                            : isAdmin
                              ? "粘贴源码、导入 Registry，或上传一个组件包。"
                              : "组件库暂时为空，请等待管理员添加组件。"}
                      </p>
                      <div className="empty-actions">
                        {view === "selected" ? (
                          <button
                            className="primary"
                            onClick={() => setView("library")}
                          >
                            浏览组件库
                          </button>
                        ) : search || category || framework ? (
                          <button
                            onClick={() => {
                              setQuery("")
                              setCategory("")
                              setFramework("")
                            }}
                          >
                            清除筛选
                          </button>
                        ) : isAdmin ? (
                          <>
                            <button
                              className="primary"
                              onClick={() => setModal("import")}
                            >
                              <Plus size={16} />
                              导入第一个组件
                            </button>
                            <button onClick={seed}>加载 4 个示例</button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {view === "library" && total > 0 && (
                    <div className="pagination">
                      <span>共 {total} 个组件 · 每页 12 个</span>
                      <div>
                        <button
                          disabled={page <= 1}
                          onClick={() => setPage(page - 1)}
                          aria-label="上一页"
                        >
                          <ArrowLeft size={15} />
                        </button>
                        <span>
                          第 {page} / {Math.max(1, pages)} 页
                        </span>
                        <button
                          disabled={page >= pages}
                          onClick={() => setPage(page + 1)}
                          aria-label="下一页"
                        >
                          <ArrowRight size={15} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {view === "kits" && (
                <>
                  {kits.length ? (
                    <div className="kit-grid">
                      {kits.map((kit) => (
                        <button
                          className="kit-card"
                          onClick={() => loadKit(kit.id)}
                          key={kit.id}
                        >
                          <Folder size={28} strokeWidth={1.2} />
                          <strong>{kit.name}</strong>
                          <span>{kit.count} 个组件 · 固定版本</span>
                          <small>
                            载入选择 <ArrowRight size={14} />
                          </small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <FolderPlus size={40} strokeWidth={1} />
                      <h2>为项目留下一套搭配</h2>
                      <p>
                        {isAdmin
                          ? "先选择组件，再点击“保存组件集”。"
                          : "管理员保存的组件集会显示在这里。"}
                      </p>
                      <button onClick={() => setView("library")}>
                        去选择组件
                      </button>
                    </div>
                  )}
                  {kitTotal > 24 && (
                    <div className="pagination">
                      <span>共 {kitTotal} 个组件集</span>
                      <div>
                        <button
                          disabled={kitPage <= 1}
                          onClick={() => setKitPage(kitPage - 1)}
                        >
                          上一页
                        </button>
                        <span>{kitPage}</span>
                        <button
                          disabled={kitPage * 24 >= kitTotal}
                          onClick={() => setKitPage(kitPage + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="sheet-foot">
                <span>
                  <ShieldCheck size={14} />
                  源码、版本与资源保存在你的服务器
                </span>
                {isAdmin && <button onClick={seed}>添加内置示例</button>}
              </div>
            </>
          )}
        </main>
      </div>
      {selected.size > 0 && view !== "account" && (
        <div className="selection-bar">
          <div>
            <CheckSquare size={19} />
            <strong>已选 {selected.size} 个组件</strong>
            <button onClick={() => setSelected(new Map())}>清空</button>
          </div>
          <div>
            {isAdmin && (
              <button onClick={() => setModal("kit")}>
                <FolderPlus size={16} />
                保存组件集
              </button>
            )}
            <button className="primary" onClick={() => setModal("export")}>
              <ArrowDownToLine size={16} />
              导出给 Agent
            </button>
          </div>
        </div>
      )}
      {detail && (
        <Detail
          key={detail.id + detail.revision}
          doc={detail}
          selectedRevision={selected.get(detail.id)?.revision}
          onSelect={toggle}
          onClose={() => setDetail(null)}
          onEdit={
            isAdmin
              ? () => {
                  setEditing(detail)
                  setDetail(null)
                  setModal("import")
                }
              : undefined
          }
        />
      )}{" "}
      {isAdmin && modal === "import" && (
        <ImportForm
          initial={editing}
          onClose={closeModal}
          onSaved={() => {
            closeModal()
            setRefreshKey((v) => v + 1)
            setNotice("组件已保存。")
          }}
        />
      )}{" "}
      {modal === "export" && (
        <ExportPanel selection={[...selected.values()]} onClose={closeModal} />
      )}{" "}
      {isAdmin && modal === "settings" && (
        <TokenSettings onClose={closeModal} />
      )}{" "}
      {isAdmin && modal === "kit" && (
        <Modal title="保存组件集" onClose={closeModal}>
          <form className="form-stack" onSubmit={saveKit}>
            <p className="description">
              保存当前 {selected.size} 个组件及选定版本，后续可一键载入。
            </p>
            <label>
              组件集名称
              <input
                required
                maxLength={100}
                value={kitName}
                onChange={(e) => setKitName(e.target.value)}
                placeholder="例如，后台管理简洁版"
              />
            </label>
            <ErrorNote message={error} />
            <div className="modal-actions">
              <button type="button" onClick={closeModal}>
                取消
              </button>
              <button className="primary">保存组件集</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
