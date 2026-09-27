// Supabase Freeプランは7日間アクセスが無いと自動一時停止(pause)されるため、
// Vercel Cron(1日1回)からこのエンドポイントを叩いて軽いクエリを実行し、休止を防ぐ。
const { query, ensureSchema } = require('../../lib/db');

module.exports = async function handler(req, res) {
  // CRON_SECRETを設定している場合のみ、Vercel Cron以外からの呼び出しを拒否する
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: { message: 'UNAUTHORIZED' } });
    }
  }

  try {
    await ensureSchema();
    await query('SELECT 1');
    res.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
