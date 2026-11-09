import { z } from "zod"

// 两种运行环境共用同一份认证配置，密钥仅从运行时环境读取。
export function identityConfig(env, origin) {
  const integer = (value, min, max) => z.coerce.number().int().min(min).max(max).default(value)
  const values = z.object({
    VAULT_ADMIN_USERNAME: z.string().regex(/^[a-zA-Z0-9_.@-]{3,64}$/).default("admin"),
    VAULT_PASSWORD: z.string().min(12).max(256).optional(),
    VAULT_SESSION_HOURS: integer(24, 1, 168),
    VAULT_LOGIN_WINDOW_SECONDS: integer(300, 60, 3600),
    VAULT_LOGIN_MAX_ATTEMPTS: integer(10, 3, 30),
    VAULT_PASSWORD_ITERATIONS: integer(100000, 100000, 100000),
    VAULT_MAX_SESSIONS_PER_USER: integer(10, 1, 30),
    VAULT_LOGIN_LOG_RETENTION_DAYS: integer(90, 1, 365),
    VAULT_LOGIN_LOG_MAX_ROWS: integer(10000, 100, 100000),
    VAULT_LOGIN_RATE_LIMIT_MAX_KEYS: integer(10000, 100, 100000),
    VAULT_AUDIT_HASH_KEY: z.string().min(32).max(256).optional(),
    VAULT_SERVICE_TOKEN: z.string().min(32).max(512).optional(),
    VAULT_OAUTH_GITHUB_CLIENT_ID: z.string().max(256).default(""),
    VAULT_OAUTH_GITHUB_CLIENT_SECRET: z.string().max(512).default(""),
    VAULT_OAUTH_GOOGLE_CLIENT_ID: z.string().max(256).default(""),
    VAULT_OAUTH_GOOGLE_CLIENT_SECRET: z.string().max(512).default(""),
    VAULT_OAUTH_WECHAT_APP_ID: z.string().max(256).default(""),
    VAULT_OAUTH_WECHAT_APP_SECRET: z.string().max(512).default(""),
  }).parse(env)
  return {
    origin,
    secureCookie: origin.startsWith("https://"),
    bootstrapUsername: values.VAULT_ADMIN_USERNAME.toLowerCase(),
    bootstrapPassword: values.VAULT_PASSWORD,
    sessionHours: values.VAULT_SESSION_HOURS,
    loginWindowSeconds: values.VAULT_LOGIN_WINDOW_SECONDS,
    loginMaxAttempts: values.VAULT_LOGIN_MAX_ATTEMPTS,
    passwordIterations: values.VAULT_PASSWORD_ITERATIONS,
    maxSessionsPerUser: values.VAULT_MAX_SESSIONS_PER_USER,
    loginLogRetentionDays: values.VAULT_LOGIN_LOG_RETENTION_DAYS,
    loginLogMaxRows: values.VAULT_LOGIN_LOG_MAX_ROWS,
    loginRateLimitMaxKeys: values.VAULT_LOGIN_RATE_LIMIT_MAX_KEYS,
    auditHashKey: values.VAULT_AUDIT_HASH_KEY || values.VAULT_PASSWORD,
    serviceToken: values.VAULT_SERVICE_TOKEN,
    // OAuth 授权流程尚未启用。配置存在也不会自动打开登录入口。
    providers: [],
  }
}
