/**
 * カレンダー取込の区分記憶をタイトルでupsert。移植元: GAS.txt 457-479行 saveImportMap。
 */
export async function saveImportMap(db, env, entries) {
  entries = entries || [];
  if (!entries.length) return { ok: true, count: 0 };

  const stmts = entries
    .filter((e) => e && e.title)
    .map((e) =>
      db.prepare(
        'INSERT INTO import_map (title, code, sub) VALUES (?, ?, ?) ' +
        'ON CONFLICT(title) DO UPDATE SET code = excluded.code, sub = excluded.sub'
      ).bind(String(e.title), String(e.code || ''), String(e.sub || ''))
    );
  if (stmts.length) await db.batch(stmts);

  return { ok: true, count: entries.length };
}
