// 同じ日付・同じタイトルの履歴がすでにあれば、タイトルの後ろに _2, _3 … を付けて重複を避ける。
// Web(api/history)と自動処理(scripts/auto-process.js)の両方から使う。
const { query } = require('./db');

async function makeUniqueTitle(title, fileName, excludeId) {
  const m = (fileName || '').match(/(\d{4}-\d{2}-\d{2})/);
  if (!title || !m) return title;
  const rows = await query(
    `SELECT title FROM history WHERE title IS NOT NULL AND file_name LIKE $1 AND ($2::text IS NULL OR id <> $2)`,
    [`${m[1]}%`, excludeId || null]
  );
  const taken = new Set(rows.rows.map((r) => r.title));
  if (!taken.has(title)) return title;
  let n = 2;
  while (taken.has(`${title}_${n}`)) n++;
  return `${title}_${n}`;
}

module.exports = { makeUniqueTitle };
