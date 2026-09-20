// Vercel Hobbyプランはデプロイあたり最大12関数までのため、
// 元は9本あったapi/drive/*.jsをこの1本の動的ルートに統合した。
// URLパス(/api/drive/status, /api/drive/list等)はすべて変更していないので、
// フロントエンドのfetch先やGoogle Cloud ConsoleのリダイレクトURI登録はそのまま使える。
const drive = require('../../lib/googleDrive');
const { query, ensureSchema } = require('../../lib/db');

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function handleStatus(req, res) {
  res.json({
    configured: drive.isConfigured(),
    connected: await drive.isConnected(),
    defaultFolderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
    uploadFolderId: (process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID || '').trim(),
  });
}

async function handleAuthUrl(req, res) {
  const client = await drive.getOAuth2Client();
  res.json({ url: drive.getAuthUrl(client) });
}

async function handleOauth2Callback(req, res, url) {
  const code = url.searchParams.get('code');
  if (!code) return res.status(400).send('認証コードがありません');
  await drive.exchangeCodeForTokens(code);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send('<html><body>Google Driveと連携しました。このタブは閉じて構いません。<script>window.close();</script></body></html>');
}

async function handleDisconnect(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });
  await drive.disconnect();
  res.json({ ok: true });
}

async function handleList(req, res, url) {
  const folderId = url.searchParams.get('folderId') || (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!folderId) return res.status(400).json({ error: { message: 'フォルダIDが指定されていません' } });
  const files = await drive.listFilesInFolder(folderId);
  if (!files.length) return res.json({ files });

  await ensureSchema();
  const sourceKeys = files.map((f) => `drive:${f.id}`);
  const historyRes = await query(
    `SELECT DISTINCT ON (source_key) source_key, id, summary, summary_drive_saved
     FROM history WHERE source_key = ANY($1)
     ORDER BY source_key, processed_at DESC`,
    [sourceKeys]
  );
  const historyBySourceKey = new Map(historyRes.rows.map((r) => [r.source_key, r]));

  const processedRes = await query(`SELECT file_id FROM drive_processed WHERE file_id = ANY($1)`, [files.map((f) => f.id)]);
  const processedSet = new Set(processedRes.rows.map((r) => r.file_id));

  const enriched = files.map((f) => {
    const history = historyBySourceKey.get(`drive:${f.id}`);
    return {
      ...f,
      processed: processedSet.has(f.id),
      historyId: history ? history.id : null,
      summarized: !!(history && history.summary),
      summarySavedToDrive: !!(history && history.summary_drive_saved),
    };
  });
  res.json({ files: enriched });
}

async function handleText(req, res, url) {
  const fileId = url.searchParams.get('fileId');
  if (!fileId) return res.status(400).json({ error: { message: 'fileIdが指定されていません' } });
  const content = await drive.getTextFileContent(fileId);
  res.json({ content });
}

async function handleDownload(req, res, url) {
  const fileId = url.searchParams.get('fileId');
  if (!fileId) return res.status(400).json({ error: { message: 'fileIdが指定されていません' } });
  const meta = await drive.getFileMetadata(fileId);
  const buffer = await drive.getFileBuffer(fileId);
  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  res.setHeader('X-File-Name', encodeURIComponent(meta.name || 'audio'));
  res.status(200).send(buffer);
}

async function handleFolderName(req, res, url) {
  const folderId = (url.searchParams.get('folderId') || '').trim();
  if (!folderId) return res.json({ name: null });
  try {
    const meta = await drive.getFileMetadata(folderId);
    res.json({ name: meta.name });
  } catch (e) {
    res.json({ name: null, error: e.message });
  }
}

async function handleUploadText(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });
  const body = await readJsonBody(req);
  const { fileName, content, folderId, target, historyId } = body;
  if (!content) return res.status(400).json({ error: { message: '保存する内容がありません' } });
  const targetFolderId = folderId || (process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID || '').trim();
  if (!targetFolderId) return res.status(400).json({ error: { message: '保存先フォルダIDが設定されていません' } });
  const file = await drive.uploadTextFile(targetFolderId, fileName || 'output.txt', content);
  if (target === 'summary' && historyId) {
    await ensureSchema();
    await query(`UPDATE history SET summary_drive_saved = 1 WHERE id = $1`, [historyId]);
  }
  res.json({ ok: true, file });
}

const HANDLERS = {
  status: handleStatus,
  'auth-url': handleAuthUrl,
  oauth2callback: handleOauth2Callback,
  disconnect: handleDisconnect,
  list: handleList,
  text: handleText,
  download: handleDownload,
  'folder-name': handleFolderName,
  'upload-text': handleUploadText,
};

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = url.pathname.split('/').pop();
  const fn = HANDLERS[action];
  if (!fn) return res.status(404).json({ error: { message: `不明なアクション: ${action}` } });
  try {
    await fn(req, res, url);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: { message: e.message } });
  }
};

module.exports.config = { api: { bodyParser: false } };
