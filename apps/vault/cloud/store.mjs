import { AppError } from "../server/model.mjs"

export function cloudStore(db) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args)
  async function get(id, revision) {
    const row = await statement(`SELECT r.document,r.created_at,c.updated_at FROM revisions r JOIN components c ON c.id=r.component_id WHERE c.id=? AND r.revision=${revision ? "?" : "c.revision"}`, ...[id, ...(revision ? [revision] : [])]).first()
    if (!row) throw new AppError("组件或版本不存在", 404)
    return { ...JSON.parse(row.document), createdAt: row.created_at, updatedAt: row.updated_at }
  }
  async function createMany(docs) {
    const now = new Date().toISOString()
    const values = docs.map(doc => ({ ...doc, id: crypto.randomUUID(), revision: 1 }))
    try {
      await db.batch(values.flatMap(doc => [
        statement("INSERT INTO components VALUES(?,?,?,?,?,?,?,?)", doc.id, doc.slug, doc.name, doc.category, doc.framework, doc.description, 1, now),
        statement("INSERT INTO revisions VALUES(?,?,?,?)", doc.id, 1, JSON.stringify(doc), now),
      ]))
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) throw new AppError("组件标识已存在", 409)
      throw error
    }
    return values
  }
  return {
    db, statement, get, createMany,
    async update(id, doc, expectedRevision) {
      const value = { ...doc, id, revision: expectedRevision + 1 }
      const now = new Date().toISOString()
      let result
      try {
        result = await db.batch([
          statement("INSERT INTO revisions SELECT id,?,?,? FROM components WHERE id=? AND revision=?", value.revision, JSON.stringify(value), now, id, expectedRevision),
          statement("UPDATE components SET slug=?,name=?,category=?,framework=?,description=?,revision=?,updated_at=? WHERE id=? AND revision=?", doc.slug, doc.name, doc.category, doc.framework, doc.description, value.revision, now, id, expectedRevision),
        ])
      } catch (error) {
        if (/UNIQUE constraint/.test(error.message)) throw new AppError("组件版本或标识冲突，请刷新重试", 409)
        throw error
      }
      if (!result[1].meta.changes) throw new AppError("组件已被更新，请刷新后重试", 409)
      return value
    },
    async list({ query = "", category = "", framework = "", page = 1, size = 12 }) {
      const where = "WHERE (?='' OR instr(lower(name || ' ' || description || ' ' || slug),lower(?))>0) AND (?='' OR category=?) AND (?='' OR framework=?)"
      const args = [query, query, category, category, framework, framework]
      const [items, count] = await db.batch([
        statement(`SELECT id,slug,name,category,framework,description,revision,updated_at AS updatedAt FROM components ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size),
        statement(`SELECT count(*) AS n FROM components ${where}`, ...args),
      ])
      const total = count.results[0].n
      return { items: items.results, total, page, size, pages: Math.ceil(total / size) }
    },
    async versions(id) {
      return (await statement("SELECT revision,created_at AS createdAt FROM revisions WHERE component_id=? ORDER BY revision DESC LIMIT 100", id).all()).results
    },
    async kits(page = 1, size = 24) {
      const [items, count] = await db.batch([
        statement("SELECT k.*,count(i.component_id) AS count FROM (SELECT * FROM kits ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?) k LEFT JOIN kit_items i ON i.kit_id=k.id GROUP BY k.id ORDER BY k.created_at DESC,k.id DESC", size, (page - 1) * size),
        statement("SELECT count(*) AS n FROM kits"),
      ])
      return { items: items.results, total: count.results[0].n, page, size }
    },
    async saveKit(name, docs, fixedId) {
      const id = fixedId || crypto.randomUUID()
      await db.batch([
        statement("INSERT INTO kits VALUES(?,?,?)", id, name, new Date().toISOString()),
        ...docs.map((doc, index) => statement("INSERT INTO kit_items VALUES(?,?,?,?)", id, doc.id, doc.revision, index)),
      ])
      return { id, name }
    },
    async kit(id) {
      const kit = await statement("SELECT * FROM kits WHERE id=?", id).first()
      if (!kit) throw new AppError("组件集不存在", 404)
      const rows = await statement("SELECT r.document FROM kit_items i JOIN revisions r ON r.component_id=i.component_id AND r.revision=i.revision WHERE i.kit_id=? ORDER BY i.position LIMIT 100", id).all()
      return { ...kit, items: rows.results.map(row => JSON.parse(row.document)) }
    },
  }
}
