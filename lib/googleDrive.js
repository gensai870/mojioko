// Google Drive連携: ローカル版のservices/driveClient.jsを移植。
// トークンの読み書き先だけ data/tokens.json → Supabaseのdrive_tokensテーブル(1行共有接続)に変更。
const { google } = require('googleapis');
const { query, ensureSchema } = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

// Vercelの環境変数UIは値の末尾に改行が混入しやすく、Googleのclient_id検証は
// 空白混入を許さず invalid_client(401) になるため、読み込み時に必ずtrimする。
function clientId() {
  return (process.env.GOOGLE_CLIENT_ID || '').trim();
}
function clientSecret() {
  return (process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function redirectUri() {
  return `${(process.env.PUBLIC_BASE_URL || 'https://mojioko.vercel.app').trim()}/api/drive/oauth2callback`;
}

function isConfigured() {
  return !!(clientId() && clientSecret());
}

async function loadTokens() {
  await ensureSchema();
  const r = await query(`SELECT refresh_token, access_token, expiry_date FROM drive_tokens WHERE id = 'shared'`);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (!row.refresh_token && !row.access_token) return null;
  return {
    refresh_token: row.refresh_token || undefined,
    access_token: row.access_token || undefined,
    expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
  };
}

async function saveTokens(tokens) {
  const existing = (await loadTokens()) || {};
  const merged = { ...existing, ...tokens };
  await query(
    `INSERT INTO drive_tokens (id, refresh_token, access_token, expiry_date, updated_at)
     VALUES ('shared', $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET refresh_token = $1, access_token = $2, expiry_date = $3, updated_at = now()`,
    [merged.refresh_token || null, merged.access_token || null, merged.expiry_date || null]
  );
}

async function isConnected() {
  const t = await loadTokens();
  return !!(t && (t.refresh_token || t.access_token));
}

async function getOAuth2Client() {
  if (!isConfigured()) {
    throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRETが設定されていません(Vercelの環境変数を確認してください)');
  }
  const client = new google.auth.OAuth2(clientId(), clientSecret(), redirectUri());
  const tokens = await loadTokens();
  if (tokens) client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens(newTokens).catch((e) => console.error('drive token save failed:', e.message));
  });
  return client;
}

function getAuthUrl(client) {
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

async function exchangeCodeForTokens(code) {
  const client = await getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
  return tokens;
}

async function disconnect() {
  await query(`DELETE FROM drive_tokens WHERE id = 'shared'`);
}

async function getDriveClient() {
  const auth = await getOAuth2Client();
  return google.drive({ version: 'v3', auth });
}

async function listFilesInFolder(folderId) {
  const drive = await getDriveClient();
  let files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
    files = files.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function getFileMetadata(fileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get({ fileId, fields: 'id, name, mimeType, size', supportsAllDrives: true });
  return res.data;
}

// テキストファイル(.txt等)とGoogleドキュメントの両方に対応
async function getTextFileContent(fileId) {
  const drive = await getDriveClient();
  const meta = await drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true });
  if (meta.data.mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true });
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

async function uploadTextFile(folderId, fileName, content) {
  const drive = await getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: folderId ? [folderId] : undefined },
    media: { mimeType: 'text/plain', body: content },
    supportsAllDrives: true,
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

module.exports = {
  isConfigured,
  isConnected,
  getOAuth2Client,
  getAuthUrl,
  exchangeCodeForTokens,
  disconnect,
  listFilesInFolder,
  getFileMetadata,
  getTextFileContent,
  uploadTextFile,
};
