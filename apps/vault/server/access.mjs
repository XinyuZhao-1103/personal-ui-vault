import { AppError } from "./model.mjs"

// 访客的 POST 仅开放不产生持久化写入的预览与导出。
export function authorizeVault(user, pathname, method, readerToken = false) {
  if (!user && !readerToken) throw new AppError("请先登录", 401)
  if (user?.role === "admin") return
  if (pathname.startsWith("/api/admin/") || pathname.startsWith("/api/tokens") || pathname.startsWith("/api/sync/") || pathname === "/mcp" || pathname === "/api/catalog/bootstrap")
    throw new AppError("需要管理员权限", 403)
  const readable = /^\/api\/(components(?:\/[^/]+(?:\/versions)?)?|kits(?:\/[^/]+)?|registry\/[^/]+)$/.test(pathname)
  if (["GET", "HEAD"].includes(method) && readable) return
  if (user && method === "POST" && ["/api/preview", "/api/export", "/api/export/check"].includes(pathname)) return
  throw new AppError("访客仅可浏览、预览和导出组件", 403)
}
