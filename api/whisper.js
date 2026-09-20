// Groq Whisper プロキシ(ステートレス、1セグメント分のみ)。
// ブラウザ側で音声を分割し、1セグメントずつここへ送る(Vercelの実行時間制限に収めるため)。
// APIキーはサーバーに保存せず、毎回ブラウザから x-groq-key ヘッダーで受け取ってGroqへ転送する。
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-groq-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'METHOD_NOT_ALLOWED' } });

  const apiKey = req.headers['x-groq-key'];
  if (!apiKey) return res.status(400).json({ error: { message: 'Groq APIキーが指定されていません' } });

  const contentType = req.headers['content-type'] || '';

  try {
    let groqRes;

    if (contentType.includes('application/json')) {
      // URLモード: URLから音声を取得してGroqへfileとして転送
      const chunks = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { url, model, language, response_format } = body;
      if (!url) return res.status(400).json({ error: { message: 'MISSING_URL' } });

      const audioRes = await fetch(url);
      if (!audioRes.ok) return res.status(502).json({ error: { message: `音声URLの取得に失敗しました(status ${audioRes.status})` } });
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      let ext = 'mp4';
      try {
        const pathname = new URL(url).pathname;
        const m = pathname.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
        if (m) ext = m[1].toLowerCase();
      } catch (_) {}

      const form = new FormData();
      form.append('file', new Blob([audioBuffer]), `audio.${ext}`);
      form.append('model', model || 'whisper-large-v3-turbo');
      if (response_format) form.append('response_format', response_format);
      if (language && language !== 'auto') form.append('language', language);

      groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else if (contentType.includes('multipart/form-data')) {
      // ファイルモード: multipartをそのままGroqへ転送
      const chunks = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const rawBody = Buffer.concat(chunks);

      groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType },
        body: rawBody,
      });
    } else {
      return res.status(400).json({ error: { message: 'EXPECTED_MULTIPART_OR_JSON' } });
    }

    // Groqのレート制限情報はそのままヘッダーごと転送し、ブラウザ側で待機・再送を判断する
    for (const key of ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-limit-audio-seconds', 'x-ratelimit-remaining-audio-seconds', 'x-ratelimit-reset-audio-seconds']) {
      const v = groqRes.headers.get(key);
      if (v) res.setHeader(key, v);
    }

    const respContentType = groqRes.headers.get('content-type') || '';
    if (respContentType.includes('application/json')) {
      const data = await groqRes.json();
      return res.status(groqRes.status).json(data);
    }
    const text = await groqRes.text();
    return res.status(groqRes.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: { message: `プロキシエラー: ${e.message}` } });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
