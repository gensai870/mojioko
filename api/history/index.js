// 履歴の作成のみを扱う。一覧・検索はStage 4で別途実装予定、
// 今のところはDriveの「✓済/要約済」バッジ判定に必要な最小限の機能のみ。
const crypto = require('crypto');
const { query, ensureSchema } = require('../../lib/db');
const { makeUniqueTitle } = require('../../lib/titles');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    if (!url.searchParams.get('uniqueTitle')) return res.status(400).json({ error: { message: 'BAD_REQUEST' } });
    try {
      await ensureSchema();
      const title = await makeUniqueTitle(
        url.searchParams.get('title') || '',
        url.searchParams.get('fileName') || '',
        url.searchParams.get('excludeId') || null
      );
      return res.json({ title });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message } });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });

  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: { message: 'INVALID_JSON' } });
  }

  const { fileName, sourceType, sourceKey, outputFormat, mode, fullText, title } = body;
  if (!fullText) return res.status(400).json({ error: { message: 'fullTextが指定されていません' } });

  try {
    await ensureSchema();
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO history (id, file_name, source_type, source_key, output_format, mode, full_text, title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, fileName || null, sourceType || null, sourceKey || null, outputFormat || null, mode || 'transcript', fullText, title || null]
    );
    if (sourceType === 'drive' && sourceKey) {
      const fileId = sourceKey.replace(/^drive:/, '');
      await query(
        `INSERT INTO drive_processed (file_id, file_name)
         VALUES ($1, $2)
         ON CONFLICT (file_id) DO UPDATE SET file_name = $2, processed_at = now()`,
        [fileId, fileName || null]
      );
    }
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
