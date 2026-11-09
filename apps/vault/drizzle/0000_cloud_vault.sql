CREATE TABLE components(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, framework TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX components_updated ON components(updated_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE revisions(component_id TEXT NOT NULL REFERENCES components(id), revision INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(component_id,revision));
--> statement-breakpoint
CREATE TABLE kits(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX kits_created ON kits(created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE kit_items(kit_id TEXT NOT NULL REFERENCES kits(id), component_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(kit_id,component_id), FOREIGN KEY(component_id,revision) REFERENCES revisions(component_id,revision));
--> statement-breakpoint
CREATE TABLE api_tokens(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE sync_runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, summary TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX sync_runs_started ON sync_runs(started_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE sync_candidates(id TEXT PRIMARY KEY, repository TEXT NOT NULL, source_path TEXT NOT NULL, commit_sha TEXT NOT NULL, document TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository,source_path,commit_sha));
--> statement-breakpoint
CREATE INDEX candidates_updated ON sync_candidates(updated_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
