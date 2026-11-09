// 自動処理(GitHub Actionsで実行): Driveの音声のうち文字起こし済みでないものを
// 「文字起こし → タイトル → Driveに保存 → 要約 → 要約もDriveに保存」まで処理する。
//   - 定期実行(1日2回): 未処理の音声(0.5MB以下の保留ファイルと、AUTO_SINCEより前の録音は除く)
//   - Web画面からの手動起動: FILE_IDS に指定されたファイルだけ(処理済みでも再処理。開始日は無視)
// 環境変数: AUTO_SOURCE_FOLDER_ID(対象フォルダ。無ければ GOOGLE_DRIVE_FOLDER_ID)、AUTO_SINCE(YYYY-MM-DD)、MAX_FILES_PER_RUN
const { processDriveFile, AUDIO_EXT, HOLD_MAX_BYTES } = require('../lib/grokJob');

// 対象の選び方(単体で試験できるよう関数に分けている)
function selectTargets(all, processedIds, { requested = [], since = '', max = 30 } = {}) {
  let targets;
  if (requested.length) {
    const byId = new Map(all.map((f) => [f.id, f]));
    targets = requested.map((id) => byId.get(id)).filter((f) => f && AUDIO_EXT.test(f.name));
  } else {
    targets = all.filter((f) => {
      if (!AUDIO_EXT.test(f.name) || processedIds.has(f.id) || !(Number(f.size) > HOLD_MAX_BYTES)) return false;
      if (since) {
        const m = f.name.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!m || m[1] < since) return false; // 日付が読めない、または開始日より前は対象外
      }
      return true;
    });
  }
  targets.sort((a, b) => a.name.localeCompare(b.name, 'ja')); // 古い順
  return { targets: targets.slice(0, max), total: targets.length };
}

async function main() {
  const drive = require('../lib/googleDrive');
  const { query, ensureSchema } = require('../lib/db');
  const folderId = (process.env.AUTO_SOURCE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  const uploadFolderId = (process.env.GOOGLE_DRIVE_UPLOAD_FOLDER_ID || '').trim();
  if (!folderId || !uploadFolderId) throw new Error('AUTO_SOURCE_FOLDER_ID / GOOGLE_DRIVE_UPLOAD_FOLDER_ID が必要です');
  if (!(await drive.isConnected())) throw new Error('Google Driveが連携されていません(Webで「Driveと連携」をしてください)');

  const requested = (process.env.FILE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const since = (process.env.AUTO_SINCE || '').trim();
  const max = Number(process.env.MAX_FILES_PER_RUN) > 0 ? Number(process.env.MAX_FILES_PER_RUN) : 30; // 想定外の費用を防ぐ上限
  await ensureSchema();
  const all = await drive.listFilesInFolder(folderId);
  const processed = requested.length ? new Set() : new Set((await query(`SELECT file_id FROM drive_processed`)).rows.map((r) => r.file_id));
  const { targets, total } = selectTargets(all, processed, { requested, since, max });
  console.log(requested.length
    ? `手動指定: ${requested.length}件中、フォルダ内の音声が見つかったのは${total}件`
    : `定期実行: 開始日${since || '(指定なし)'}以降で未処理の音声は${total}件`);
  if (total > targets.length) console.log(`1回の上限(${max}件)のため、残り${total - targets.length}件は次回に回します`);

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

module.exports = { selectTargets };
if (require.main === module) {
  main().catch((e) => { console.error(`エラー: ${e.message}`); process.exitCode = 1; }).finally(() => process.exit());
}
