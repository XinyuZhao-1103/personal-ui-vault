import React, { useEffect, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react"

export type AccountUser = {
  id: string
  username: string
  displayName: string
  role: "admin" | "visitor"
  status: "active" | "disabled"
  hasPassword?: boolean
  createdAt?: string
  lastLoginAt?: string | null
}
export type LoginProvider = { id: string; name: string }
export type AccountSession = {
  authenticated: boolean
  user: AccountUser | null
  providers: LoginProvider[]
  limits: { maxSelection: number }
}
export type ApiRequest = <T>(url: string, options?: RequestInit) => Promise<T>
type Page<T> = { items: T[]; total: number; page: number; size: number }
type LoginLog = {
  id: string
  userId: string | null
  username: string
  provider: string
  success: boolean
  reason: string
  ipHash: string
  userAgent: string
  createdAt: string
}
const roles = { admin: "管理员", visitor: "访客" }
const providers: Record<string, string> = {
  password: "账号密码",
  github: "GitHub",
  google: "Google",
  wechat: "微信",
}
const timestamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

function Feedback({ error, notice }: { error: string; notice?: string }) {
  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </>
  )
}

function Pager({
  page,
  total,
  size,
  busy,
  onPage,
}: {
  page: number
  total: number
  size: number
  busy: boolean
  onPage: (page: number) => void
}) {
  return (
    <div className="pagination account-pagination">
      <span>
        共 {total} 条 · 每页 {size} 条
      </span>
      <div>
        <button
          aria-label="上一页记录"
          disabled={busy || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ArrowLeft size={15} />
        </button>
        <span>
          第 {page} / {Math.max(1, Math.ceil(total / size))} 页
        </span>
        <button
          aria-label="下一页记录"
          disabled={busy || page * size >= total}
          onClick={() => onPage(page + 1)}
        >
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  )
}

function PasswordFields({
  value,
  onChange,
  label = "新密码",
}: {
  value: string
  onChange: (value: string) => void
  label?: string
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        maxLength={256}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>使用 12—256 个字符。</small>
    </label>
  )
}

function Profile({
  user,
  api,
  onSignedOut,
}: {
  user: AccountUser
  api: ApiRequest
  onSignedOut: () => void
}) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致")
      return
    }
    setBusy(true)
    try {
      await api(
        "/api/account/password",
        jsonBody("POST", { currentPassword, newPassword }),
      )
      setCurrentPassword("")
      setNewPassword("")
      setConfirmation("")
      onSignedOut()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="account-profile">
      <section className="account-section">
        <h2>当前账号</h2>
        <dl className="account-facts">
          <div>
            <dt>账号</dt>
            <dd>{user.username}</dd>
          </div>
          <div>
            <dt>显示名称</dt>
            <dd>{user.displayName}</dd>
          </div>
          <div>
            <dt>身份</dt>
            <dd>{roles[user.role]}</dd>
          </div>
          <div>
            <dt>可用权限</dt>
            <dd>
              {user.role === "admin"
                ? "维护组件、管理账号与查看登录日志"
                : "浏览、预览和导出组件"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="account-section">
        <h2>修改密码</h2>
        <p className="description">
          修改成功后需要重新登录，其他设备的登录会话也会失效。
        </p>
        {user.hasPassword === false ? (
          <p className="account-empty">
            此账号使用第三方登录。如需密码登录，请联系管理员设置密码。
          </p>
        ) : (
          <form className="form-stack account-password-form" onSubmit={submit}>
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <PasswordFields value={newPassword} onChange={setNewPassword} />
            <label>
              再次输入新密码
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <Feedback error={error} />
            <button className="primary" disabled={busy}>
              {busy ? "正在保存…" : "保存密码并重新登录"}
            </button>
          </form>
        )}
      </section>
    </div>
  )
}

function UserEditor({
  user,
  api,
  onClose,
  onSaved,
}: {
  user: AccountUser | "new"
  api: ApiRequest
  onClose: () => void
  onSaved: () => void
}) {
  const creating = user === "new"
  const [username, setUsername] = useState(creating ? "" : user.username)
  const [displayName, setDisplayName] = useState(
    creating ? "" : user.displayName,
  )
  const [role, setRole] = useState(creating ? "visitor" : user.role)
  const [status, setStatus] = useState(creating ? "active" : user.status)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (creating)
        await api(
          "/api/admin/users",
          jsonBody("POST", { username, displayName, password, role }),
        )
      else
        await api(
          `/api/admin/users/${encodeURIComponent(user.id)}`,
          jsonBody("PATCH", { displayName, role, status }),
        )
      setPassword("")
      onSaved()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="account-editor"
      aria-label={creating ? "创建用户" : "编辑用户"}
    >
      <div className="account-section-heading">
        <h2>{creating ? "创建用户" : `编辑 ${user.username}`}</h2>
        <button
          className="icon-button"
          aria-label="关闭用户编辑"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <form className="account-user-form" onSubmit={submit}>
        <label>
          账号
          <input
            aria-label="账号"
            required
            minLength={3}
            maxLength={64}
            pattern="[a-zA-Z0-9_.@-]{3,64}"
            autoComplete="off"
            value={username}
            readOnly={!creating}
            onChange={(event) => setUsername(event.target.value)}
          />
          <small>3—64 个字母、数字或 _.@-</small>
        </label>
        <label>
          显示名称
          <input
            required
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label>
          身份
          <select
            value={role}
            onChange={(event) =>
              setRole(event.target.value as AccountUser["role"])
            }
          >
            <option value="visitor">访客</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        {creating ? (
          <PasswordFields
            label="初始密码"
            value={password}
            onChange={setPassword}
          />
        ) : (
          <label>
            账号状态
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as AccountUser["status"])
              }
            >
              <option value="active">启用</option>
              <option value="disabled">禁用</option>
            </select>
          </label>
        )}
        <div className="account-form-foot">
          <Feedback error={error} />
          <p className="hint">
            访客可浏览和导出。管理员可维护组件、管理用户与查看登录日志。禁用账号会撤销其登录会话。
          </p>
          <div className="account-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "正在保存…" : creating ? "创建用户" : "保存修改"}
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}

function ResetPassword({
  user,
  api,
  onClose,
  onSaved,
}: {
  user: AccountUser
  api: ApiRequest
  onClose: () => void
  onSaved: () => void
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api(
        `/api/admin/users/${encodeURIComponent(user.id)}/password`,
        jsonBody("POST", { password }),
      )
      setPassword("")
      onSaved()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="account-editor">
      <div className="account-section-heading">
        <h2>重置 {user.username} 的密码</h2>
        <button
          className="icon-button"
          aria-label="关闭密码重置"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <form className="form-stack account-password-form" onSubmit={submit}>
        <p className="description">
          重置后该账号所有已登录设备需要重新登录。请通过安全方式告知用户新密码。
        </p>
        <PasswordFields value={password} onChange={setPassword} />
        <Feedback error={error} />
        <div className="account-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : "确认重置密码"}
          </button>
        </div>
      </form>
    </section>
  )
}

function Users({
  api,
  currentUser,
}: {
  api: ApiRequest
  currentUser: AccountUser
}) {
  const [data, setData] = useState<Page<AccountUser>>({
    items: [],
    total: 0,
    page: 1,
    size: 20,
  })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState<AccountUser | "new" | null>(null)
  const [reset, setReset] = useState<AccountUser | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setError("")
    api<Page<AccountUser>>(
      `/api/admin/users?${new URLSearchParams({ page: String(page), size: "20", q: search })}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [api, page, search, refresh])
  function saved() {
    setEditor(null)
    setReset(null)
    setRefresh((value) => value + 1)
    setNotice("用户设置已保存。")
  }
  return (
    <section>
      <div className="account-toolbar">
        <form
          className="account-search"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch(query.trim())
            setPage(1)
          }}
        >
          <Search size={16} />
          <input
            aria-label="搜索用户"
            placeholder="搜索账号或显示名称"
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button>搜索</button>
        </form>
        <button
          className="primary"
          onClick={() => {
            setReset(null)
            setEditor("new")
            setNotice("")
          }}
        >
          <Plus size={16} />
          创建用户
        </button>
      </div>
      <Feedback error={error} notice={notice} />
      {editor && (
        <UserEditor
          key={editor === "new" ? "new" : editor.id}
          user={editor}
          api={api}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {reset && (
        <ResetPassword
          key={reset.id}
          user={reset}
          api={api}
          onClose={() => setReset(null)}
          onSaved={saved}
        />
      )}
      <div className="account-table-wrap" aria-busy={busy}>
        <table className="account-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>身份与状态</th>
              <th>创建时间</th>
              <th>最近登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <tr>
                <td colSpan={5} className="account-empty">
                  正在读取用户…
                </td>
              </tr>
            ) : !data.items.length ? (
              <tr>
                <td colSpan={5} className="account-empty">
                  {search ? "没有找到匹配用户，请调整搜索条件。" : "暂无用户。"}
                </td>
              </tr>
            ) : (
              data.items.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.username}
                      {user.id === currentUser.id ? " · 当前账号" : ""}
                    </small>
                  </td>
                  <td>
                    <span>{roles[user.role]}</span>
                    <small
                      className={
                        user.status === "disabled" ? "account-disabled" : ""
                      }
                    >
                      {user.status === "active" ? "启用" : "已禁用"} ·{" "}
                      {user.hasPassword ? "密码登录" : "第三方登录"}
                    </small>
                  </td>
                  <td>{timestamp(user.createdAt)}</td>
                  <td>{timestamp(user.lastLoginAt)}</td>
                  <td>
                    <div className="account-row-actions">
                      <button
                        onClick={() => {
                          setReset(null)
                          setEditor(user)
                          setNotice("")
                        }}
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => {
                          setEditor(null)
                          setReset(user)
                          setNotice("")
                        }}
                      >
                        重置密码
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager
        page={page}
        total={data.total}
        size={data.size}
        busy={busy}
        onPage={setPage}
      />
    </section>
  )
}

function LoginLogs({ api }: { api: ApiRequest }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<LoginLog>>({
    items: [],
    total: 0,
    page: 1,
    size: 20,
  })
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setError("")
    api<Page<LoginLog>>(`/api/admin/login-logs?page=${page}&size=20`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [api, page, refresh])
  return (
    <section>
      <div className="account-toolbar">
        <p className="hint">记录登录成功与失败，来源地址以哈希标识保存。</p>
        <button
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
          刷新日志
        </button>
      </div>
      <Feedback error={error} />
      <div className="account-table-wrap" aria-busy={busy}>
        <table className="account-table login-log-table">
          <thead>
            <tr>
              <th>登录时间</th>
              <th>账号与方式</th>
              <th>结果</th>
              <th>来源标识</th>
              <th>浏览器</th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <tr>
                <td colSpan={5} className="account-empty">
                  正在读取登录日志…
                </td>
              </tr>
            ) : !data.items.length ? (
              <tr>
                <td colSpan={5} className="account-empty">
                  暂无登录记录。
                </td>
              </tr>
            ) : (
              data.items.map((log) => (
                <tr key={log.id}>
                  <td>{timestamp(log.createdAt)}</td>
                  <td>
                    <strong>{log.username || "—"}</strong>
                    <small>{providers[log.provider] || log.provider}</small>
                  </td>
                  <td>
                    <span
                      className={`account-result ${log.success ? "success" : "failure"}`}
                    >
                      {log.success ? "成功" : "失败"}
                    </span>
                    <small>{log.reason || "—"}</small>
                  </td>
                  <td>
                    <code title={log.ipHash}>
                      {log.ipHash ? log.ipHash.slice(0, 12) : "—"}
                    </code>
                  </td>
                  <td>
                    <span className="account-user-agent" title={log.userAgent}>
                      {log.userAgent || "—"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager
        page={page}
        total={data.total}
        size={data.size}
        busy={busy}
        onPage={setPage}
      />
    </section>
  )
}

export function AccountSettings({
  user,
  api,
  onSignedOut,
  onTokens,
}: {
  user: AccountUser
  api: ApiRequest
  onSignedOut: () => void
  onTokens: () => void
}) {
  const [tab, setTab] = useState("account")
  return (
    <div className="account-settings">
      <div className="page-title">
        <div>
          <h1>账号与安全</h1>
          <p>管理拾 UI 的账号、访问权限与登录记录。</p>
        </div>
      </div>
      <div className="tabs account-tabs">
        <button
          className={tab === "account" ? "active" : ""}
          onClick={() => setTab("account")}
        >
          <UserRound size={16} />
          我的账号
        </button>
        {user.role === "admin" && (
          <>
            <button
              className={tab === "users" ? "active" : ""}
              onClick={() => setTab("users")}
            >
              <ShieldCheck size={16} />
              用户管理
            </button>
            <button
              className={tab === "logs" ? "active" : ""}
              onClick={() => setTab("logs")}
            >
              登录日志
            </button>
            <button onClick={onTokens}>
              <KeyRound size={16} />
              Agent 访问
            </button>
          </>
        )}
      </div>
      {tab === "account" && (
        <Profile user={user} api={api} onSignedOut={onSignedOut} />
      )}
      {user.role === "admin" && tab === "users" && (
        <Users api={api} currentUser={user} />
      )}
      {user.role === "admin" && tab === "logs" && <LoginLogs api={api} />}
    </div>
  )
}
