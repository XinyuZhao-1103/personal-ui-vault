// 让本地 SQLite 与 D1 使用相同的预处理 SQL 及原子批处理语义。
export function identityDatabase(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = db.prepare(sql)
          return {
            async first() { return statement.get(...args) || null },
            async all() { return { results: statement.all(...args) } },
            async run() { return { meta: { changes: Number(statement.run(...args).changes) } } },
            execute() {
              if (statement.columns().length) return { results: statement.all(...args), meta: { changes: 0 } }
              return { meta: { changes: Number(statement.run(...args).changes) } }
            },
          }
        },
      }
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = statements.map(statement => statement.execute())
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  }
}
