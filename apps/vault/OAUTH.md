# 第三方登录接入准备

## 当前交付范围

本轮先交付账号密码登录。GitHub、Google 和微信预留独立配置名，第三方授权、回调处理、账号绑定和真实登录尚未启用。登录页面只展示已完成并启用的登录方式。填入预留配置后，还需要完成对应授权流程及验收，才能开放入口。

## 部署配置

以下名称用于后续接入，默认值均为空字符串。每个平台的 ID 与 Secret 必须成对提供。生产配置通过 Sites 环境变量保存，Secret 标记为密钥。本地使用未跟踪的 `.env` 文件。环境变量不得传入 Vite 前端构建变量。

| 平台 | 应用标识 | 服务端密钥 |
| --- | --- | --- |
| GitHub | `VAULT_OAUTH_GITHUB_CLIENT_ID` | `VAULT_OAUTH_GITHUB_CLIENT_SECRET` |
| Google | `VAULT_OAUTH_GOOGLE_CLIENT_ID` | `VAULT_OAUTH_GOOGLE_CLIENT_SECRET` |
| 微信 | `VAULT_OAUTH_WECHAT_APP_ID` | `VAULT_OAUTH_WECHAT_APP_SECRET` |

回调来源应沿用 `VAULT_ORIGIN`，由服务端拼接固定路径。不要从用户输入、请求查询参数或未经验证的 Host 头生成回调地址。更换站点域名后需要同步更新应用控制台中的回调配置。

| 平台 | 预留回调路径 |
| --- | --- |
| GitHub | `/api/auth/github/callback` |
| Google | `/api/auth/google/callback` |
| 微信 | `/api/auth/wechat/callback` |

例如，现有站点的 GitHub 完整回调地址预留为 `https://xinyuzhao-ui-vault.downyforum1.chatgpt.site/api/auth/github/callback`。这些路径目前属于接入规划，尚未提供授权回调服务。

## GitHub

在 GitHub 的 Settings → Developer settings → OAuth apps 创建应用，填写站点首页与完整回调地址，取得 Client ID，并生成仅服务端使用的 Client Secret。账号登录应只申请所需的用户身份范围，私有仓库访问权限不属于本站登录所需权限。授权码交换在服务端完成，使用随机 `state` 和 PKCE S256，之后重新查询用户身份并以稳定的 GitHub 用户 ID 关联本站账号。[创建 OAuth 应用](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

## Google

在 Google Cloud Console 创建项目，配置 OAuth 品牌信息、用户同意页面及受众，创建 Web application 类型的 OAuth Client，登记完整回调地址并取得 Client ID 和 Client Secret。回调 URI 的协议、大小写和末尾斜杠必须与登记值一致。测试和正式发布的受众、测试用户及审核要求按控制台当前状态处理。[Web 服务端授权](https://developers.google.com/identity/protocols/oauth2/web-server)

接入时使用 OpenID Connect 的 `openid profile email` 最小身份范围，以 `sub` 作为稳定身份。后端验证 ID Token 的签名、issuer、audience、有效期和 nonce，授权码流程同时验证 `state` 并使用 PKCE。邮箱仅作为用户资料，账号合并需要单独的已登录确认流程。[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)

## 微信

本项目预留的是微信开放平台的网站扫码登录。后续需要在微信开放平台确认网站应用的注册主体、审核状态、微信登录权限、AppID、AppSecret 及授权回调域配置。当前 `chatgpt.site` 子域能否满足该应用的域名和审核要求，需以开放平台实际审核结果为准，可能需要使用已验证归属的自有域名。

2026-11-09 官方网站应用微信登录文档的自动读取失败，本轮没有核实最新的主体资格、认证费用或域名审核细则，也未创建微信应用。接入前由应用所有者登录开放平台核对这些条件。[微信网站应用登录文档](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)

## 后续接入验收

- 授权成功后创建或读取持久账号，首次第三方登录创建访客，管理员通过用户管理变更角色。
- 使用平台稳定标识关联账号，禁止仅依据同名账号或相同邮箱自动合并，也不根据邮箱域或第三方资料授予管理员权限。
- 随机 `state` 绑定发起登录的浏览器，设置短期有效期并原子消费一次。回调失败、用户取消、过期和重放均拒绝登录。
- 授权端点固定，网络调用设置总超时。客户端只能选择已经启用的平台，不能指定任意授权服务器或回跳站点。
- 授权完成后签发本站会话并清理临时状态，跳转到同源固定页面。第三方 access token 和 refresh token 不进入前端、日志和登录信息表，仅登录用途时不长期保存。
- 持久化必要的第三方身份映射、展示资料和登录日志。禁用账号、角色变更、退出与管理员重置密码须保持本站会话规则一致。
- 使用真实应用验证首次登录、重复登录、禁用账号、取消授权、错误回调、过期与重放、并发首次登录和密钥失效，验收通过后才展示该平台按钮。
