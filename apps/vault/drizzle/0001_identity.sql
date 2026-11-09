CREATE TABLE IF NOT EXISTS identity_users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL CHECK(role IN ('admin','visitor')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, auth_version INTEGER NOT NULL DEFAULT 1);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_users_created ON identity_users(created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_sessions_user ON identity_sessions(user_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_sessions_expiry ON identity_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_login_logs(id TEXT PRIMARY KEY, user_id TEXT, username TEXT NOT NULL, provider TEXT NOT NULL, success INTEGER NOT NULL, reason TEXT NOT NULL, ip_hash TEXT NOT NULL, user_agent TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_login_logs_created ON identity_login_logs(created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_rate_limits_expiry ON identity_rate_limits(expires_at);
