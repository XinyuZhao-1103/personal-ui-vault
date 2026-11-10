# 拾 UI · 自托管组件资产库

基于 `serafimcloud/21st` 的个人组件资产库，保留复用的上游解析器与 MIT 许可证。本应用直接打包 `apps/web/lib/parsers.ts`，沿用组件、演示、合集及 Registry 分发约定。

Docker 版使用 React、Vite、Express 与 SQLite。ChatGPT Sites 版使用 Worker、D1 与 R2，每天北京时间 08:00 检查精选组件。云端部署、访问控制和维护说明见 [CLOUD.md](./apps/vault/CLOUD.md)。

## 功能

- 账号密码登录，管理员与访客角色，HttpOnly 会话与只读 Agent Token。
- 账号与安全后台，用户创建、角色调整、启用禁用、重置密码和分页登录日志。
- React / TypeScript 与 HTML / CSS 组件管理，支持多套组件、分类、搜索和分页。
- 粘贴代码、带清单的 ZIP、已发布 Registry JSON 导入。
- 隔离实时预览，React / Tailwind 编译；可编辑入口、演示与依赖。
- 单选、跨页多选、组件集及固定版本快照。
- 导出含源码的提示词文件，或包含组件、资源、依赖、可运行示例、来源和许可的 ZIP。
- 源码包可重新导入。更新组件保留历史版本，组件集维持原版本引用。

## 本地运行

要求 Node.js 22.23.4 或兼容的 Node 24 版本，支持 `node:sqlite`。Docker 使用已固定摘要的 Node 22.23.4 镜像。从本目录执行。

```powershell
Copy-Item .env.example .env
# 编辑 .env，设置至少 12 位 VAULT_PASSWORD。
npm ci
npm run dev
```

打开 <http://localhost:4310>，输入账号 `admin`（可通过 `VAULT_ADMIN_USERNAME` 配置）和 `.env` 中的初始化管理员密码。空库可以手动加载四个 MIT 示例。所有示例均为本应用演示组件，其中表格数据为虚构示例。

```bash
npm run check
npm test
npm run build
npm start
```

## Linux Docker Compose 部署

复制整个项目，进入 `apps/vault`。

```bash
cp .env.example .env
# 编辑密码。VAULT_ORIGIN 填写浏览器实际访问的来源。
docker compose up -d --build
docker compose ps
```

默认映射 `127.0.0.1:4310 → 容器 4310`，适合在宿主机通过已有 HTTPS 反向代理访问。反向代理保留 Host，转发到 `http://127.0.0.1:4310`。域名示例为 `https://ui.example.com` 时，设置 `VAULT_ORIGIN=https://ui.example.com`，以启用 Secure Cookie。

需要局域网直接访问时，在 `.env` 配置 `VAULT_BIND_IP=0.0.0.0`、`VAULT_PUBLIC_PORT=4310`，并将 `VAULT_ORIGIN` 改为真实的 `http://服务器地址:4310`。端口、地址配置变更后执行 `docker compose up -d --force-recreate`。个人组件库应通过受控网络或 HTTPS 访问。

首次构建需联网下载基础镜像及 npm 依赖。运行阶段的页面、字体、预览及示例使用本地资源。远程 Registry 导入是主动联网操作。

## 数据与备份

SQLite 文件位于本地 `data/vault.sqlite`，容器中位于 `/app/data`，使用 `vault_data` 数据卷。源码和资源以 JSON 文档保存在数据库中，组件集引用不可变版本。

备份前停止应用，再备份完整数据目录或数据卷，完成后启动。不要只复制运行中的主 SQLite 文件，WAL 中可能仍有已提交数据。恢复时使用同一版本应用和完整数据卷。升级先备份，再构建新镜像。应用启动时检查数据库版本。

首次启动会在数据库创建管理员，原组件与组件集继续保留，升级后需要重新登录。`VAULT_PASSWORD` 仅用于初始化，之后在“账号与安全”中修改密码。修改密码、管理员重置密码、调整角色或禁用用户会撤销相关会话。至少保留一名可用管理员。

管理员可维护组件与组件集、管理账号和 Token、查看登录日志。访客可浏览、预览及导出。账号由管理员创建，第三方登录暂未启用，配置说明见 `OAUTH.md`。

账号、加盐密码派生值、会话摘要和登录日志持久化在 SQLite，云端对应 D1。日志记录时间、账号、结果、原因、截断浏览器信息与 HMAC 地址标识，默认保留90天、最多10000条，在认证操作时分批清理。Agent Token 独立管理，需要在“Agent 访问”中撤销。

## 导入 ZIP

根目录提供 `component.json`，其余文件保留相对目录结构。

```json
{
  "name": "我的按钮",
  "slug": "my-button",
  "framework": "react",
  "category": "按钮",
  "entry": "button.tsx",
  "description": "适用于后台页面的按钮",
  "license": "MIT 及原始版权声明",
  "source": "原始来源",
  "dependencies": {},
  "demo": "import Button from './button'; export default function Demo(){return <Button/>}"
}
```

也支持本站导出的 `manifest.json` 组件包。已有相同 slug 时导入会拒绝，全部组件原子保存。修改既有组件请使用详情中的“编辑新版本”。

## Registry 与 Agent

导入使用 HTTPS 公网地址，要求 JSON 的 `files` 包含 `content`。禁止内网、本机和保留地址，递归依赖与重定向均有限额。带命名空间的依赖请提供完整 URL。未支持的自定义 CSS 对象会明确报错，避免丢失样式。

“Agent 访问”可生成只读 Token。通过 `Authorization: Bearer <Token>` 读取以下接口。

```text
GET /api/components?page=1&size=12&q=button
GET /api/components/{id}
GET /api/components/{id}?revision=1
GET /api/registry/{id}
GET /api/kits?page=1
GET /api/kits/{id}
```

此版本通过文件和只读 HTTP 接口向 Agent 提供组件。导出的 AGENT.md 应与任务一起交给 Agent，或由项目指令引用。

## 预览支持边界

预览包内置 React 19、Lucide、Motion、clsx、tailwind-merge、CVA 和 Radix Slot。其他 npm 包的源码与依赖可以收集、导出，预览会提示管理员安装所需依赖。扩展时在 package.json 固定版本，并同步修改 `server/preview-worker.mjs` 的预览包白名单。

React 预览需要纯客户端组件和正确的 demo，服务器组件、Next.js 路由上下文及业务接口需先提供独立演示适配。支持 Tailwind 3 的静态配置和主题变量，自定义可执行 Tailwind 配置不在预览中执行。HTML 预览支持入口 HTML 与补充 CSS，外部网络、表单提交与父页面访问受限。任意 JavaScript 运行仍可能占用浏览器资源，应只预览自己认可的组件。

导出包保留源码及其版本要求，依赖版本不一致时拒绝合并。未锁定的依赖范围会在导出检查中提示。运行导出示例前执行 npm install，并保留生成的 package-lock.json。CSS 的全局选择器仍需在目标项目中做组合验收。

## 上游与实现约定

- 上游提交 `b96d84dcf748d5e56f2f72f2bab9a4f7f33574cf`。
- 根目录 LICENSE 为上游 MIT 许可证，导出包附组件各自的许可信息。
- 配置说明及范围见 `.env.example` 与 `server/config.mjs`，环境变量优先。
- 预览编译在受限 Worker 中进行， iframe 使用不含 `allow-same-origin` 的 sandbox 及 CSP。
- 当前版本为共享组件库，支持管理员与访客角色。组件、源码、合集和只读接口均要求认证。账号间共享同一组件库。
