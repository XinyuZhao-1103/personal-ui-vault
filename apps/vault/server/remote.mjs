import { lookup } from "node:dns/promises"
import https from "node:https"
import ipaddr from "ipaddr.js"
import { AppError } from "./model.mjs"

export function isPublicAddress(address) {
  let ip = ipaddr.parse(address)
  if (ip.kind() === "ipv6" && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address()
  return ip.range() === "unicast"
}
export async function fetchPublicJson(
  input,
  config,
  redirects = 0,
  deadline = Date.now() + config.fetchTimeout,
) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new AppError("Registry URL 无效")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new AppError("远程导入仅接受公网 HTTPS 443 地址")
  if (redirects > 3) throw new AppError("Registry 重定向过多")
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new AppError("Registry 读取超时", 504)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  let timer
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError("Registry DNS 查询超时", 504)),
        remaining,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new AppError("Registry 地址必须指向公网，禁止内网和本机地址")
  const address = addresses[0]
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          Accept: "application/json",
          "User-Agent": "21st-SelfHosted-Vault/0.1",
        },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume()
          if (!response.headers.location)
            return reject(new AppError("Registry 重定向缺少地址"))
          try {
            fetchPublicJson(
              new URL(response.headers.location, url).href,
              config,
              redirects + 1,
              deadline,
            ).then(resolve, reject)
          } catch {
            reject(new AppError("Registry 重定向地址无效"))
          }
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          reject(new AppError(`Registry 返回 HTTP ${response.statusCode}`, 502))
          return
        }
        const chunks = []
        let size = 0
        response.on("data", (chunk) => {
          size += chunk.length
          if (size > config.maxBytes)
            request.destroy(new AppError("Registry 响应超过大小上限", 413))
          else chunks.push(chunk)
        })
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch {
            reject(new AppError("Registry 响应不是有效 JSON"))
          }
        })
        response.on("error", reject)
      },
    )
    const timeout = setTimeout(
      () => request.destroy(new AppError("Registry 读取超时", 504)),
      Math.max(1, deadline - Date.now()),
    )
    request.on("close", () => clearTimeout(timeout))
    request.on("error", reject)
  })
}
