# 云端部署与组件维护

## 当前结构

前端沿用 React/Vite。Sites 运行 Worker API，D1 保存组件、不可变版本、固定组件集和同步状态，R2 保存经过验证的预览产物。既有 Docker/SQLite 部署入口仍可使用。

已采集组件在构建时预编译。网页新增的 React 组件由本地托管的 esbuild WASM 和 Tailwind 浏览器编译器生成隔离预览，依赖白名单由构建脚本声明。预览 iframe 只允许脚本运行，通过 CSP 限制网络、表单与页面跳转。

## 访问与凭据

Sites 受众设为 public，访客可直接打开网站登录页。网站使用独立账号密码与 HttpOnly/Secure Cookie 会话，后端按 admin、visitor 角色授权。平台身份头不能授予组件或后台权限。首次管理员账号由 VAULT_ADMIN_USERNAME（默认 admin）与 Secret VAULT_PASSWORD 初始化，之后密码在数据库中维护，重启不会覆盖已修改密码。

Agent Token 只有组件与组件集读取权限。管理员可管理用户、角色、禁用状态、密码和登录日志。访客可浏览、预览及导出。账号、密码派生值、会话摘要、登录日志持久化在 D1。数据库迁移0001新增身份表，保留原组件数据，旧登录需要重新验证。真实 `.env`、数据库、Token 和运行产物均不提交。

GitHub Actions 使用仓库 Secret `VAULT_SITE_SERVICE_TOKEN` 保存服务凭据，变量 `VAULT_SITE_URL` 保存站点 HTTPS 地址。同步脚本发送平台服务头及 `X-Vault-Service-Token`，应用通过 Sites Secret `VAULT_SERVICE_TOKEN` 独立校验后者，仅允许固定同步接口、初始化目录和 MCP 入口。服务密钥不能读取用户管理接口或代替浏览器登录。失效或轮换后需同步更新 Sites Secret 和 Actions Secret。来源访问使用每次运行自动签发的只读 `GITHUB_TOKEN`，通过 HTTPS 请求体交给站点并仅在本次请求内使用，不落库、不写日志。

公开站点的 MCP 同样要求应用层服务密钥，原插件仅携带 ChatGPT 身份时不能调用维护工具。第三方 OAuth 本轮仅预留配置，见 `OAUTH.md`。

在 Sites 环境变量中设置 VAULT_PASSWORD、VAULT_AUDIT_HASH_KEY 和 VAULT_SERVICE_TOKEN 为 Secret。后两项至少32位随机值。会话、登录限流、日志保留配置与允许范围统一见 `.env.example`，云端沿用同名配置。VAULT_PASSWORD 初始化完成后仍作为缺省审计密钥的兼容来源，建议单独设置 VAULT_AUDIT_HASH_KEY。

## 定时同步

工作流位于 `.github/workflows/vault-sync.yml`，每周一、三、五、周日 UTC 00:00 执行，对应北京时间 08:00。GitHub 排队可能使实际开始时间延迟，也支持 Actions 页面手动执行。

每轮检查 shadcn-ui/ui、magicuidesign/magicui 和 ibelick/motion-primitives 的组件目录，核对当前 MIT 许可并记录仓库星数，收集最新变更提交中每来源最多 5 个 TSX 组件。每轮处理最多 30 个候选。此范围为有界采集，尚未实现所有历史变更的无遗漏回补。

候选组件经过隔离编译、Chromium 渲染和运行异常检查后，上传压缩预览并入库，再读取保存的版本校验内容。无法编译、缺少参数或不支持的依赖留在候选区，工作流返回失败以提供可见提醒。该检查无法替代所有业务交互和视觉质量评审。

自动更新只作用于系统托管且未被用户修改的组件。用户编辑过的组件保留现状，候选中记录冲突。组件集保持创建时的固定版本。

在 Actions 中查看运行日志，在 `/api/sync/status` 或站点 MCP 工具中查看采集与候选概况。运行日志不包含服务凭据。

## 云端配置

运行配置统一通过 Sites 环境变量提供，保存时与请求入口进行范围校验。

| 配置 | 默认值 | 范围与用途 |
|---|---|---|
| VAULT_IMPORT_BYTES | 1048576 | 65536—1048576 字节，单组件与请求上限 |
| VAULT_MAX_PAGE_SIZE | 48 | 12—100，服务端列表页大小上限 |
| VAULT_MAX_SELECTION | 50 | 1—100，单次选择数量上限 |
| VAULT_FETCH_TIMEOUT_MS | 10000 | 1000—30000 毫秒，单次来源读取超时 |
| VAULT_SYNC_BATCH_SIZE | 5 | 1—10，每来源候选数和候选页大小 |
| VAULT_REGISTRY_HOSTS | ui.shadcn.com,magicui.design,motion-primitives.com,raw.githubusercontent.com | Registry HTTPS 域名白名单，重定向逐跳检查 |
| VAULT_LOCAL_DEV | false | 仅本地 Worker 测试设为 true，线上保持 false |
| GITHUB_TOKEN | 无 | 可选服务端 Secret，提高 GitHub 来源 API 配额 |

## 构建与验证

在 `apps/vault` 中执行 `npm ci`、`npm run check`、`npm test` 和 `npm run build:sites`。云端构建输出 `dist-sites`，包含 Worker、静态资源与 10 个初始组件预览。

D1 结构迁移位于 `drizzle`，部署时由 Sites 应用。初始数据通过受保护的 `/api/catalog/bootstrap` 幂等导入，不把数据回填放入结构迁移。

用 `node scripts/prepare-sites-checkout.mjs <独立绝对目录>` 生成不包含本地数据的 Sites 源码镜像，再使用 Sites 官方源码同步与发布流程。保留 `.openai/hosting.json` 中已有的项目 ID，避免重复建站。

升级前保存源码提交和 Sites 版本。应用可回退到此前已发布版本，数据库迁移采用向后兼容追加方式。组件修订与组件集快照保存在 D1，定期导出重要组件集作为可迁移源码包。
