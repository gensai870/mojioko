// Driveの音声ファイルをそのままブラウザに返す。
// クライアント側の分割・Whisperアップロード処理(app.jsのcurrentFile)にそのまま渡すために使う。
const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const fileId = url.searchParams.get('fileId');
  if (!fileId) return res.status(400).json({ error: { message: 'fileIdが指定されていません' } });
  try {
    const meta = await drive.getFileMetadata(fileId);
    const buffer = await drive.getFileBuffer(fileId);
    res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    res.setHeader('X-File-Name', encodeURIComponent(meta.name || 'audio'));
    res.status(200).send(buffer);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
