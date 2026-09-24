const { query, ensureSchema } = require('../../lib/db');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = decodeURIComponent(url.pathname.split('/').pop());

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const r = await query(`SELECT * FROM history WHERE id = $1`, [id]);
      if (!r.rows.length) return res.status(404).json({ error: { message: 'NOT_FOUND' } });
      return res.json(r.rows[0]);
    }

    if (req.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch (e) {
        return res.status(400).json({ error: { message: 'INVALID_JSON' } });
      }

      const allowed = ['summary', 'article', 'genre', 'summary_drive_saved', 'drive_saved'];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (body[key] === undefined) continue;
        values.push(body[key]);
        sets.push(`${key} = $${values.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: { message: '更新項目がありません' } });
      values.push(id);
      await query(`UPDATE history SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};

module.exports.config = { api: { bodyParser: false } };
