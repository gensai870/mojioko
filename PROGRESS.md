# mojioko Web版(試験) 進捗まとめ

このファイルは `mojioko-web`(Vercel試験版)専用の記録です。ローカル版(`ローカルソフト/`)のCLAUDE.mdとは別管理。

## 背景・方針

- チームメンバー(特にWindows)がローカル版のセットアップ(Nodeバージョン不一致、Xcode Command Line Tools、`better-sqlite3`のビルド失敗)で繰り返しつまずいたため、**Vercelで試験的に使えるWeb版**を作成。
- 位置づけは**一時的な試験運用**。将来的に本番運用が固まったら常時起動サーバー(Render/Railway/VPS等)に移行する前提。
- リポジトリ: https://github.com/gensai870/mojioko
- デプロイ先: https://mojioko.vercel.app (Vercelプロジェクト `mojioko`, プロジェクトID `prj_dpyS714iAojlKjuQVIaEnOW6Z0Wd`)

## アーキテクチャ上の主な決定

1. **ジョブ制御はブラウザが行う(サーバーは常駐しない)**。Vercelサーバーレス関数の実行時間制限に対応するため、音声はブラウザ側で分割し、1セグメントずつステートレスなプロキシへ送る。既存オンライン版(`index.html`)の実装パターンを踏襲。
2. **Groq APIキーは各自がブラウザに入力し`localStorage`に保存**。サーバーには一切保存しない。チームのGroqレート制限を個人ごとに分散させる、ローカル版の設計思想を維持。
3. **429レート制限の待機・リトライもクライアント側**(`parseRetryAfterMs`をブラウザJSに移植)。サーバー関数は待たずに即座に応答する。
4. **永続化はSupabase(Postgres)**。当初Turso(libSQL)を検討したが、ユーザー希望によりSupabaseへ変更。`pg`ライブラリで生SQLを実行し、SQLite方言との差分(`?`→`$1`、`datetime('now')`→`now()`)のみ書き換え。ジョブキュー用テーブル(`jobs`/`job_segments`)はクライアント駆動方式のため不要と判断し除外。
5. **Google Drive連携は共有の単一接続**(ローカル版と同じ単一テナント前提)。OAuthトークンはSupabaseの`drive_tokens`テーブルに保存(旧`data/tokens.json`相当)。

## 実装済み

### Stage 1: 文字起こしコア機能
- `api/whisper.js`: Groq Whisperへのステートレスプロキシ。`x-groq-key`ヘッダーで受け取ったキーを転送。
- `public/audioSplit.js`: オンライン版から移植した音声分割エンジン(WAV/MP3/OGGストリーミング分割 + フォールバック)。16kHzモノWAVに変換。
- `public/app.js`: Groqキー管理、429リトライ、分割アップロードループ、出力整形(`formatters.js`移植)。
- `public/index.html` / `style.css`: フロントUI。

### DB基盤
- `lib/db.js`: Supabase(Postgres)接続 + スキーマ初期化。`history`, `usage_counters`, `drive_processed`, `custom_templates`, `settings`, `drive_tokens` テーブル。
- 環境変数 `SUPABASE_DB_URL` (Vercelに設定済み)。

### Stage 5: Google Drive連携
- `lib/googleDrive.js`: OAuth2クライアント、トークンのSupabase読み書き、フォルダ一覧、テキスト/バイナリ読み込み、アップロード。
- `api/drive/*.js`: status, auth-url, oauth2callback, disconnect, list, text, download, upload-text, folder-name。
- フロントに「Driveと連携」「フォルダID(履歴チップで複数切り替え可)」「一覧を取得」を追加。
- 音声ファイルは「文字起こしに使う」ボタンでDriveから取得→そのまま通常の文字起こしフローに投入可能。
- テキストファイル(既存の文字起こし結果)は「読み込む」ボタンで結果欄に読み込み可能。
- 環境変数 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_DRIVE_UPLOAD_FOLDER_ID` (Vercelに設定済み)。ローカル版と同じGoogle Cloudプロジェクトを再利用し、リダイレクトURI `https://mojioko.vercel.app/api/drive/oauth2callback` を追加登録済み。
- **注意点**: Vercelの環境変数UIは値の末尾に改行が混入しやすく、`client_id`の完全一致検証で`invalid_client`エラーになったため、`lib/googleDrive.js`側で環境変数読み込み時に必ず`.trim()`する対策済み。

### 使用量メーター
- ヘッダーに「1時間 残り Xm」「1日 残り Xm」のミニバー、Groq/Driveの接続状態を示すドット表示を追加。
- ローカル版はチーム共有の単一Groqキーだったためサーバー側で集計していたが、Web版は各自のキーを使うため**ブラウザごと(localStorage)に追跡**する設計に変更。
- 1時間の残りはGroqのWhisperレスポンスヘッダー(`x-ratelimit-*-audio-seconds`)の実測値を優先使用。1日はGroq側に実測手段がないため、ローカル版同様UTC日境界によるこのアプリ独自の目安推定。

### レイアウト調整
- 進捗ログ・開始ボタンのカードを「④ Google Driveから読み込む」の直前に移動。

## 未実装(今後の作業)

- **Stage 3: 要約・note記事・SNS投稿生成**(`api/chat.js`)。ローカル版の`groqChat.js`・`summaryTemplates.js`・各種プロンプトを移植する必要あり。
- **Drive一覧のバッジ/アクションメニュー**: ローカル版と同じ「✓済」「要約済」等のステータスバッジ、「再文字起こし」「要約に進む」「その他▾(要約をドライブに保存/note記事を提案/X用投稿を生成/Insta用投稿を生成)」の導線をDriveファイル一覧に追加する(ユーザー依頼、着手中)。
- **Stage 4: 履歴CRUD**(`api/history.js`)。
- 簡易パスワードロック(`APP_PASSWORD`相当)、設定タブ。
- TPM(要約用チャットモデルのトークン/分)メーター — Stage 3実装後に追加予定。ローカル版と同じ考え方(Groqレスポンスヘッダーの実測値)。

## 既知の制約(試験版としての割り切り)

- バッチ処理はブラウザタブを開いたままにする必要がある(サーバー側常駐ワーカーが無いため)。
- OSネイティブ通知は無し。
- 非常に長い録音はセグメント数分のHTTP往復が発生し、ローカル版より体感速度が落ちる可能性がある(ただしタイムアウトでは失敗しなくなる)。

## 検証状況

- 文字起こし: 本番URLで実ファイルを使い動作確認済み。
- Drive連携: OAuth接続・フォルダ一覧・音声ダウンロード→文字起こし投入まで実際に動作確認済み(30MBの`.ogg`ファイルで確認)。
- 使用量メーター・レイアウト変更: pushしてデプロイ済み(このMD作成時点でデプロイ確認中)。
