const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const folderId = url.searchParams.get('folderId') || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return res.status(400).json({ error: { message: 'フォルダIDが指定されていません' } });
  try {
    const files = await drive.listFilesInFolder(folderId);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
