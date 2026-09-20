const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });
  try {
    await drive.disconnect();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
