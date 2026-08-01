/**
 * 区分マスタ全置換。移植元: GAS.txt 353-365行 saveCategories。
 */
export async function saveCategories(db, env, categories) {
  const rows = (categories || [])
    .filter((c) => c && c.code)
    .map((c) => ({
      code: String(c.code),
      name: String(c.name || ''),
      parent: String(c.parent || ''),
      color: String(c.color || ''),
      sort: Number(c.order) || 0,
      active: c.active ? 1 : 0
    }));

  const stmts = [db.prepare('DELETE FROM categories')];
  for (const r of rows) {
    stmts.push(
      db.prepare('INSERT INTO categories (code, name, parent, color, sort, active) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(r.code, r.name, r.parent, r.color, r.sort, r.active)
    );
  }
  await db.batch(stmts);

  return { ok: true, count: rows.length };
}
