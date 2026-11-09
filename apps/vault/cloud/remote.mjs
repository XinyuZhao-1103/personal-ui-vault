import { AppError } from "../server/model.mjs"

// Workers 无原始 DNS/TCP 接口，远程导入采用显式域名白名单并逐跳校验。
export async function fetchPublicJson(input, config, redirects = 0, deadline = Date.now() + config.fetchTimeout) {
  return JSON.parse(await fetchAllowedText(input, config, redirects, deadline))
}

export async function fetchAllowedText(input, config, redirects = 0, deadline = Date.now() + config.fetchTimeout) {
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || !config.registryHosts.includes(url.hostname))
    throw new AppError("远程地址不在已配置的 HTTPS 来源白名单中", 403)
  if (redirects > 3) throw new AppError("远程地址重定向过多")
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new AppError("远程读取超时", 504)
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(remaining),
    headers: { Accept: "application/json, text/plain", "User-Agent": "Personal-UI-Vault" },
  })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel()
    return fetchAllowedText(new URL(response.headers.get("location"), url), config, redirects + 1, deadline)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError(`远程来源返回 HTTP ${response.status}`, 502)
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > config.maxBytes) throw new AppError("远程文件超过大小上限", 413)
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}
