const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: { message: 'INVALID_JSON' } });
  }
  const { fileName, content, folderId } = body;
  if (!content) return res.status(400).json({ error: { message: '保存する内容がありません' } });
  const targetFolderId = folderId || process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID;
  if (!targetFolderId) return res.status(400).json({ error: { message: '保存先フォルダIDが設定されていません' } });
  try {
    const file = await drive.uploadTextFile(targetFolderId, fileName || 'output.txt', content);
    res.json({ ok: true, file });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};

module.exports.config = { api: { bodyParser: false } };
