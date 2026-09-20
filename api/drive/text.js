// 既存の文字起こし結果(.txt / Googleドキュメント)をDriveから読み込む。
// 要約・note記事・SNS投稿生成の入力として、再文字起こしせずここから直接使う想定。
const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const fileId = url.searchParams.get('fileId');
  if (!fileId) return res.status(400).json({ error: { message: 'fileIdが指定されていません' } });
  try {
    const content = await drive.getTextFileContent(fileId);
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
};
