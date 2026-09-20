// フォルダ履歴に実際のフォルダ名を添えて表示するために使う
const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const folderId = (url.searchParams.get('folderId') || '').trim();
  if (!folderId) return res.json({ name: null });
  try {
    const meta = await drive.getFileMetadata(folderId);
    res.json({ name: meta.name });
  } catch (e) {
    res.json({ name: null, error: e.message });
  }
};
