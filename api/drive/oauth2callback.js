const drive = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  if (!code) return res.status(400).send('認証コードがありません');
  try {
    await drive.exchangeCodeForTokens(code);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send('<html><body>Google Driveと連携しました。このタブは閉じて構いません。<script>window.close();</script></body></html>');
  } catch (e) {
    res.status(500).send(`連携に失敗しました: ${e.message}`);
  }
};
