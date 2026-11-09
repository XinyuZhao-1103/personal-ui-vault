# 首版验收记录

日期为 2026-11-06，应用版本为 0.1.0。

## 已完成并验证

| 范围 | 证据 |
| --- | --- |
| 类型检查与构建 | `npm run check`、`npm run build` 通过 |
| 自动化回归 | `npm test` 共 10 项通过，覆盖认证、来源校验、只读 Token、分页、空数据、原子导入、重试冲突、历史兼容读取、持久化、ZIP 路径与大小限制、依赖冲突和 Registry 依赖 |
| 浏览器主流程 | Edge Playwright 1 项完整端到端通过，包含登录、加载示例、导入 React 组件、表格排序、单选多选、保存组件集、提示词下载和 ZIP 下载 |
| 响应式布局 | 1440、768、390 宽度无页面横向溢出，截图保存在本地 `test-results` |
| 预览 | 四个内置组件均真实编译，详情 iframe 中实际点击表格排序；缩略图使用按需真实预览 |
| 导出往返 | 多组件源码 ZIP 重新解析通过，包含原始源码、依赖、主题、示例与许可信息 |
| 独立导出项目 | 四组件实际导出至 `test-results/export-project`，单独执行 `npm install` 与 `npm run build` 通过 |
| 远程 Registry | 实际读取 `https://ui.shadcn.com/r/styles/new-york/button.json` 成功，导入路径为 `components/ui/button.tsx`；递归依赖、主题与冲突由受控 fixture 回归覆盖 |
| 依赖审计 | 修复已发现的 fflate、PostCSS、Zod 与 Vite 问题后，新增应用的完整 `npm audit` 为 0 个已知漏洞 |
| Linux 镜像 | `personal-ui-vault:0.1.0` 构建通过，基础镜像固定摘要，实际 Node 22.23.4 |
| Compose | 配置校验通过，容器以 node 用户、只读根文件系统运行，健康状态为 healthy |
| 容器持久化 | 写入四个组件后重启，组件仍保留，预览与 ZIP 导出通过 |
| 断网运行 | 断开本机验收容器网络后，在容器内执行登录、组件读取、React 编译、ZIP 导出和页面读取均通过，之后恢复网络 |

## 实现决定

- 在上游 Fork 内新增 `apps/vault`，直接复用上游解析器与 Registry 数据约定，保留原站应用源码。自托管应用使用 React、Vite、Express、SQLite。
- 当前产品名“拾 UI”为实施时暂定名称。
- 采用 Framed sheet 视觉方向，seed 为 781826422，保留系统字体，避免运行时下载外部字体。源码标识使用等宽字体，浮层与选择工具条使用阴影。
- SQLite 保存组件源码、二进制资源的 base64 文档、不可变版本、组件集、会话与 Token 摘要。日志不输出密码、Token 或源码正文。
- 导入与导出 ZIP 在受限 Worker 中执行。预览使用独立 Worker 编译和不带 allow-same-origin 的 iframe，缓存有数量、字节和过期上限。

## 受限与待验收

- 尚未连接用户服务器，正式域名、HTTPS 反向代理和服务器资源容量需要在目标环境验收。
- 当前面向单管理员私有库，主组件技术栈为 React / TypeScript 与 HTML / CSS。
- 预览使用固定的常见 npm 包集合。其他依赖可保存和导出，实时预览需要管理员增加固定版本依赖并调整白名单。
- Registry 需要发布后的含源码 JSON。命名空间依赖需完整 URL，自定义 CSS 对象会拒绝并提示使用 ZIP。
- Next.js 服务端组件、真实业务接口、任意可执行 Tailwind 配置不属于当前预览支持范围。
- Agent 接入已提供提示词、源码包及只读 HTTP / Registry 接口。MCP、浏览器收藏扩展和全局默认组件集自动接入尚待后续实现。
- 跨组件全局 CSS 仍需目标项目组合验收。提示词和示例不能代替 Agent 对业务行为的测试。

## 复验

在 `apps/vault` 执行。

```bash
npm ci
npm run build
npm run check
npm test
npx playwright test
node scripts/prepare-export-verification.mjs
```

浏览器测试默认使用本机 Edge。容器冒烟脚本为 `scripts/container-smoke.mjs`，通过标准输入传给容器中的 `node --input-type=module` 执行。脚本读取容器环境中的密码，不在命令参数或输出中暴露密码。
