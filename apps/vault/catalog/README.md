# 首批开源组件

采集日期为 2026-11-06。三个来源均核对了公开仓库的 MIT 许可，保留完整许可及版权声明。星数是仓库受欢迎程度的参考，组件本身没有独立 GitHub 星数。

| 来源 | 采集时仓库星数 | 本地快照 | 数量 |
| --- | --- | --- | --- |
| shadcn/ui | 127468 | 8a3536678a528cc012b9e62484290e79d0be410f | 3 |
| Magic UI | 23106 | 37ce829f18dd7d0a7219531a4249b664419933ea | 4 |
| Motion Primitives | 6904 | 120f64f6ca60348e251f929e9c81f11ccbe45eda | 3 |

## 组件与最近源码修改时间

| 组件 | 最近修改日期 | 本地标识 |
| --- | --- | --- |
| shadcn 多样式按钮 | 2026-09-04 | shadcn-button |
| shadcn 数据表格 | 2026-09-04 | shadcn-table |
| shadcn 页码分页 | 2026-09-04 | shadcn-pagination |
| Magic UI 点阵光场背景 | 2026-11-02 | magic-dither-field |
| Magic UI 点击涟漪按钮 | 2026-10-17 | magic-ripple-button |
| Magic UI 3D 粒子背景 | 2026-09-04 | magic-floating-particles |
| Magic UI 状态切换按钮 | 2026-07-31 | magic-subscribe-button |
| Motion Primitives 字符解码 | 2026-03-19 | motion-text-scramble |
| Motion Primitives 轮换文字 | 2025-01-17 | motion-text-loop |
| Motion Primitives 过渡面板 | 2025-01-09 | motion-transition-panel |

这里组合了近期新增组件与适合复用的稳定基础组件。全部读取各来源所固定主分支的当前源码快照，逐组件记录最近修改日期。仓库的推送时间与组件的新增、修改时间分别保存。

## 文件组织

每个组件目录包含以下文件。

- `component.tsx` 为可运行适配版本，`demo.tsx` 为本地中文演示。
- `upstream/*.txt` 保留对应上游源码。
- `LICENSE.txt` 保留上游许可原文。
- `PROVENANCE.json` 保存仓库、快照提交、源文件路径、最近修改提交和适配说明。
- `preview.css` 与 `lib/utils.ts` 提供本地运行所需的兼容样式与工具。
- `component.json` 是本地组件清单，明确入口、文件、依赖、描述和许可。

shadcn 源码的 `cn` 包引用改为本地等价工具，聚合的 Slot 导入改为已安装的 Radix Slot。局部 Tailwind 4 写法调整为当前预览环境可识别的 Tailwind 3 写法。Magic UI 涟漪按钮补充本地动画样式。这些差异均写入对应 PROVENANCE.json，原始源码仍保存在 upstream 中。

## 本地导入与验证

从 apps/vault 执行，脚本使用本地 .env 配置。密码通过登录请求传递，日志只显示组件标识和处理结果。

```bash
node --env-file-if-exists=.env scripts/import-catalog.mjs --check
node --env-file-if-exists=.env scripts/import-catalog.mjs --import
node --env-file-if-exists=.env scripts/import-catalog.mjs --export
```

重复导入会跳过未变化内容。遇到同标识但不同的本地内容时，脚本会保留本地内容并报错，避免覆盖用户修改。脚本通过网站正常 API 入库，数据随网站数据卷持久化。

程序化背景无需外部图片或视频。点阵光场依赖 WebGL2，缺少该能力时使用上游内置的静态点阵回退。演示文案和表格金额为本地虚构示例。

## 本地验收记录

2026-11-09 恢复本地 Docker 服务后再次验收，10 个组件均保留，重复导入为 0 个新增、10 个未变化。来源快照与星数的采集时间仍为 2026-11-06。

- 10 个组件全部完成编译检查，并在真实 Edge 浏览器中渲染。
- 实际验证表格排序、页码切换、涟漪点击与清理、订阅状态切换、字符解码重播和面板切换。
- 点阵光场和粒子背景均创建 Canvas，点阵光场模式切换可用，浏览器脚本未记录页面异常。
- 按来源保存 3 个固定版本组件集，网站可以一次选择并导出全部 10 个组件。
- 实际导出源码包解压到独立项目，执行 npm install 和 npm run build 通过。
- Vite 构建会提示忽略 React 组件中的 use client 模块指令，这是客户端示例的构建提示，构建正常完成。

验收脚本为 `scripts/verify-catalog-browser.mjs`。截图、导出包及运行记录保存在本机 `work/catalog-verification`，未纳入源码提交。
