// Groqチャット補完のステートレスプロキシ(要約・note記事・SNS投稿生成)。
// ローカル版のgroqChat.js相当だが、429時にサーバー側でsleepして待つことはしない
// (Vercel関数のタイムアウトに引っかかるため)。429はそのままクライアントへ返し、待って再送するのはブラウザ側。
const { SUMMARIZE_PROMPT, PROPOSE_PROMPT, GENERATE_PROMPT, SOCIAL_PROMPTS } = require('../lib/promptTemplates');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';

function buildMessages(promptType, content) {
  switch (promptType) {
    case 'summarize':
      return [{ role: 'system', content: SUMMARIZE_PROMPT }, { role: 'user', content }];
    case 'article-propose':
      return [{ role: 'system', content: PROPOSE_PROMPT }, { role: 'user', content: `【要約】\n${content}` }];
    case 'article-generate':
      return [{ role: 'system', content: GENERATE_PROMPT }, { role: 'user', content }];
    case 'social-x':
      return [{ role: 'system', content: SOCIAL_PROMPTS.x }, { role: 'user', content }];
    case 'social-instagram':
      return [{ role: 'system', content: SOCIAL_PROMPTS.instagram }, { role: 'user', content }];
    default:
      return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-groq-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });

  const apiKey = req.headers['x-groq-key'];
  if (!apiKey) return res.status(400).json({ error: { message: 'Groq APIキーが指定されていません' } });

  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: { message: 'INVALID_JSON' } });
  }

  const { promptType, content, maxTokens } = body;
  const messages = buildMessages(promptType, content);
  if (!messages) return res.status(400).json({ error: { message: `不明なpromptType: ${promptType}` } });

  try {
    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_CHAT_MODEL, messages, temperature: 0.7, max_tokens: maxTokens || 2000 }),
    });

    for (const key of ['x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']) {
      const v = groqRes.headers.get(key);
      if (v) res.setHeader(key, v);
    }

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(groqRes.status).json(data);

    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: { message: `プロキシエラー: ${e.message}` } });
  }
};

module.exports.config = { api: { bodyParser: false } };
