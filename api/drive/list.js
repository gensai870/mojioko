const drive = require('../../lib/googleDrive');
const { query, ensureSchema } = require('../../lib/db');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const folderId = url.searchParams.get('folderId') || (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!folderId) return res.status(400).json({ error: { message: 'フォルダIDが指定されていません' } });
  try {
    const files = await drive.listFilesInFolder(folderId);
    if (!files.length) return res.json({ files });

    await ensureSchema();
    const sourceKeys = files.map((f) => `drive:${f.id}`);
    // 各ファイルの最新の履歴行(要約済みかどうか等)をまとめて取得
    const historyRes = await query(
      `SELECT DISTINCT ON (source_key) source_key, id, summary, summary_drive_saved
       FROM history WHERE source_key = ANY($1)
       ORDER BY source_key, processed_at DESC`,
      [sourceKeys]
    );
    const historyBySourceKey = new Map(historyRes.rows.map((r) => [r.source_key, r]));

    const processedRes = await query(`SELECT file_id FROM drive_processed WHERE file_id = ANY($1)`, [files.map((f) => f.id)]);
    const processedSet = new Set(processedRes.rows.map((r) => r.file_id));

    const enriched = files.map((f) => {
      const history = historyBySourceKey.get(`drive:${f.id}`);
      return {
        ...f,
        processed: processedSet.has(f.id),
        historyId: history ? history.id : null,
        summarized: !!(history && history.summary),
        summarySavedToDrive: !!(history && history.summary_drive_saved),
      };
    });
    res.json({ files: enriched });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
