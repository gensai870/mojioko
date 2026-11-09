// 自動処理(GitHub Actionsで実行): Driveの音声のうち文字起こし済みでないものを
// 「文字起こし → タイトル → Driveに保存 → 要約 → 要約もDriveに保存」まで処理する。
//   - 定期実行(1日2回): 未処理の音声すべて(0.5MB以下の保留ファイルは除く)
//   - Web画面からの手動起動: FILE_IDS に指定されたファイルだけ(処理済みでも再処理)
const drive = require('../lib/googleDrive');
const { query, ensureSchema } = require('../lib/db');
const { processDriveFile, AUDIO_EXT, HOLD_MAX_BYTES } = require('../lib/grokJob');

const MAX_FILES = Number(process.env.MAX_FILES_PER_RUN || 30); // 1回あたりの上限(想定外の費用発生を防ぐ)

async function main() {
  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  const uploadFolderId = (process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID || '').trim();
  if (!folderId || !uploadFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID / GOOGLE_DRIVE_UPLOAD_FOLDER_ID が必要です');
  if (!(await drive.isConnected())) throw new Error('Google Driveが連携されていません(Webで「Driveと連携」をしてください)');

  const requested = (process.env.FILE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  await ensureSchema();
  const all = await drive.listFilesInFolder(folderId);
  let targets;
  if (requested.length) {
    const byId = new Map(all.map((f) => [f.id, f]));
    targets = requested.map((id) => byId.get(id)).filter((f) => f && AUDIO_EXT.test(f.name));
    console.log(`手動指定: ${requested.length}件中、フォルダ内の音声が見つかったのは${targets.length}件`);
  } else {
    const processed = new Set((await query(`SELECT file_id FROM drive_processed`)).rows.map((r) => r.file_id));
    targets = all.filter((f) => AUDIO_EXT.test(f.name) && !processed.has(f.id) && Number(f.size) > HOLD_MAX_BYTES);
    console.log(`定期実行: 音声${all.filter((f) => AUDIO_EXT.test(f.name)).length}件のうち、未処理は${targets.length}件`);
  }
  targets.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (targets.length > MAX_FILES) {
    console.log(`1回の上限(${MAX_FILES}件)を超えるため、残り${targets.length - MAX_FILES}件は次回に回します`);
    targets = targets.slice(0, MAX_FILES);
  }

  let ok = 0;
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    const log = (m) => console.log(`[${i + 1}/${targets.length}] ${m}`);
    try {
      await processDriveFile(f, uploadFolderId, log);
      ok++;
    } catch (e) {
      failed.push(f.name);
      console.error(`[${i + 1}/${targets.length}] 失敗: ${f.name}: ${e.message}`);
      if (e.fatal) { console.error('キー不正または残高不足のため、以降の処理を中止します'); break; }
    }
  }
  console.log(`終了: 成功${ok}件、失敗${failed.length}件${failed.length ? `(${failed.join('、')})` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exitCode = 1; }).finally(() => process.exit());
