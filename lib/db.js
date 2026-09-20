// Supabase(Postgres)接続。
// クライアント駆動方式(ブラウザが分割・進捗管理)のため、ローカル版にあった
// jobs/job_segments(サーバー常駐ジョブ管理用)テーブルはここでは不要。
// 履歴・設定・テンプレート・使用量カウンタ・Drive連携の永続化のみを担う。
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) throw new Error('SUPABASE_DB_URL が設定されていません');
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

let initPromise = null;
async function ensureSchema() {
  if (!initPromise) {
    initPromise = query(`
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        file_name TEXT,
        source_type TEXT,
        source_key TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        output_format TEXT,
        mode TEXT,
        full_text TEXT,
        translated_text TEXT,
        drive_saved INTEGER DEFAULT 0,
        summary TEXT,
        article TEXT,
        genre TEXT,
        summary_drive_saved INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_counters (
        bucket TEXT PRIMARY KEY,
        seconds DOUBLE PRECISION NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS drive_processed (
        file_id TEXT PRIMARY KEY,
        file_name TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS custom_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'カスタム',
        prompt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS drive_tokens (
        id TEXT PRIMARY KEY DEFAULT 'shared',
        refresh_token TEXT,
        access_token TEXT,
        expiry_date BIGINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  return initPromise;
}

module.exports = { query, ensureSchema };
