import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AppError } from "./model.mjs"

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, "vault.sqlite"))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
    INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
    CREATE TABLE IF NOT EXISTS components(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, framework TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions(component_id TEXT NOT NULL REFERENCES components(id), revision INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(component_id,revision));
    CREATE TABLE IF NOT EXISTS kits(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_items(kit_id TEXT NOT NULL REFERENCES kits(id), component_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(kit_id,component_id), FOREIGN KEY(component_id,revision) REFERENCES revisions(component_id,revision));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `)
  if (db.prepare("SELECT version FROM schema_version").get().version !== 1)
    throw new Error("数据库版本不兼容")
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE")
    try {
      const value = fn()
      db.exec("COMMIT")
      return value
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
  }
  function get(id, revision) {
    const row = db
      .prepare(
        `SELECT r.document,r.created_at,c.updated_at FROM revisions r JOIN components c ON c.id=r.component_id WHERE c.id=? AND r.revision=${revision ? "?" : "c.revision"}`,
      )
      .get(...(revision ? [id, revision] : [id]))
    if (!row) throw new AppError("组件或版本不存在", 404)
    return {
      ...JSON.parse(row.document),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  function insert(document) {
    if (db.prepare("SELECT id FROM components WHERE slug=?").get(document.slug))
      throw new AppError(`组件标识 ${document.slug} 已存在，请修改标识`, 409)
    const id = randomUUID()
    const now = new Date().toISOString()
    const value = { ...document, id, revision: 1 }
    db.prepare("INSERT INTO components VALUES(?,?,?,?,?,?,?,?)").run(
      id,
      document.slug,
      document.name,
      document.category,
      document.framework,
      document.description,
      1,
      now,
    )
    db.prepare("INSERT INTO revisions VALUES(?,?,?,?)").run(
      id,
      1,
      JSON.stringify(value),
      now,
    )
    return value
  }
  return {
    db,
    transaction,
    get,
    createMany: (docs) => transaction(() => docs.map(insert)),
    update(id, doc, expectedRevision) {
      return transaction(() => {
        const current = get(id)
        if (current.revision !== expectedRevision)
          throw new AppError("组件已被更新，请刷新后重试", 409)
        const duplicate = db
          .prepare("SELECT id FROM components WHERE slug=? AND id<>?")
          .get(doc.slug, id)
        if (duplicate) throw new AppError("组件标识已存在", 409)
        const value = { ...doc, id, revision: current.revision + 1 }
        const now = new Date().toISOString()
        db.prepare(
          "UPDATE components SET slug=?,name=?,category=?,framework=?,description=?,revision=?,updated_at=? WHERE id=?",
        ).run(
          doc.slug,
          doc.name,
          doc.category,
          doc.framework,
          doc.description,
          value.revision,
          now,
          id,
        )
        db.prepare("INSERT INTO revisions VALUES(?,?,?,?)").run(
          id,
          value.revision,
          JSON.stringify(value),
          now,
        )
        return value
      })
    },
    list({ query = "", category = "", framework = "", page = 1, size = 12 }) {
      const where = `WHERE (?='' OR instr(lower(name || ' ' || description || ' ' || slug),lower(?))>0) AND (?='' OR category=?) AND (?='' OR framework=?)`
      const args = [query, query, category, category, framework, framework]
      const items = db
        .prepare(
          `SELECT * FROM components ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, size, (page - 1) * size)
      const total = db
        .prepare(`SELECT count(*) AS n FROM components ${where}`)
        .get(...args).n
      return {
        items: items.map((r) => ({ ...r, updatedAt: r.updated_at })),
        total,
        page,
        size,
        pages: Math.ceil(total / size),
      }
    },
    versions: (id) =>
      db
        .prepare(
          "SELECT revision,created_at AS createdAt FROM revisions WHERE component_id=? ORDER BY revision DESC LIMIT 100",
        )
        .all(id),
    kits(page = 1, size = 24) {
      const items = db
        .prepare(
          "SELECT k.*,count(i.component_id) AS count FROM kits k LEFT JOIN kit_items i ON i.kit_id=k.id GROUP BY k.id ORDER BY k.created_at DESC,k.id DESC LIMIT ? OFFSET ?",
        )
        .all(size, (page - 1) * size)
      return {
        items,
        total: db.prepare("SELECT count(*) AS n FROM kits").get().n,
        page,
        size,
      }
    },
    saveKit(name, selection) {
      return transaction(() => {
        const id = randomUUID()
        db.prepare("INSERT INTO kits VALUES(?,?,?)").run(
          id,
          name,
          new Date().toISOString(),
        )
        selection.forEach((item, index) => {
          const doc = get(item.id, item.revision)
          db.prepare("INSERT INTO kit_items VALUES(?,?,?,?)").run(
            id,
            doc.id,
            doc.revision,
            index,
          )
        })
        return { id, name }
      })
    },
    kit(id) {
      const kit = db.prepare("SELECT * FROM kits WHERE id=?").get(id)
      if (!kit) throw new AppError("组件集不存在", 404)
      return {
        ...kit,
        items: db
          .prepare(
            "SELECT component_id AS id,revision FROM kit_items WHERE kit_id=? ORDER BY position",
          )
          .all(id)
          .map((i) => get(i.id, i.revision)),
      }
    },
  }
}
