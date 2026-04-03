/**
 * RBXAI — Multi-Provider Smart Proxy
 * Groq + Google Gemini + OpenRouter + Cloudflare AI
 * By.DevFahmi
 *
 * SETUP Vercel → Settings → Environment Variables:
 *
 *  GROQ_API_KEY_1        = gsk_...        (console.groq.com/keys)
 *  GROQ_API_KEY_2        = gsk_...
 *  ...hingga GROQ_API_KEY_10
 *
 *  GEMINI_API_KEY_1      = AIza...        (aistudio.google.com/apikey)
 *  GEMINI_API_KEY_2      = AIza...
 *  ...hingga GEMINI_API_KEY_10
 *
 *  OPENROUTER_API_KEY_1  = sk-or-...      (openrouter.ai/keys)
 *  OPENROUTER_API_KEY_2  = sk-or-...
 *  ...hingga OPENROUTER_API_KEY_5
 *
 *  CF_ACCOUNT_ID         = abc123...      (dash.cloudflare.com → AI)
 *  CF_API_TOKEN          = xxx...
 *
 * Rotasi otomatis: Groq → Gemini → OpenRouter → Cloudflare
 * Jika 429/401 → coba kombinasi berikutnya (maks ~80+ kombinasi)
 */

// Vercel body size & response config
export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
    responseLimit: false,
  },
};

// ── Model pools ───────────────────────────────────────────────────

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'llama3-70b-8192',
  'mixtral-8x7b-32768',
];

const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.0-pro',
];

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'google/gemma-2-9b-it:free',
  'mistralai/mistral-7b-instruct:free',
  'qwen/qwen-2-7b-instruct:free',
];

const CF_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/google/gemma-7b-it',
];

// ── Collect keys from env ─────────────────────────────────────────

function collectKeys(prefix, max = 10) {
  const keys = [];
  for (let i = 1; i <= max; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k && k.trim().length > 8) keys.push(k.trim());
  }
  // Fallback: key tanpa nomor
  if (keys.length === 0) {
    const plain = process.env[prefix];
    if (plain && plain.trim().length > 8) keys.push(plain.trim());
  }
  return keys;
}

// ── Provider callers ──────────────────────────────────────────────

async function callGroq(key, model, messages, maxTokens) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  const data = await res.json();
  if (res.ok) {
    return { status: 200, text: data.choices?.[0]?.message?.content || '' };
  }
  return { status: res.status, text: null };
}

async function callGemini(key, model, messages, maxTokens) {
  const sysMsg  = messages.find(m => m.role === 'system');
  const history = messages.filter(m => m.role !== 'system');

  const body = {
    contents: history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };
  if (sysMsg) {
    body.systemInstruction = { parts: [{ text: sysMsg.content }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (res.ok) {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { status: 200, text };
  }

  // Gemini pakai RESOURCE_EXHAUSTED untuk rate limit
  const errMsg = data?.error?.message || '';
  const is429  = res.status === 429 || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota');
  return { status: is429 ? 429 : res.status, text: null };
}

async function callOpenRouter(key, model, messages, maxTokens) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://rbxai.vercel.app',
      'X-Title': 'RBXAI',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  const data = await res.json();
  if (res.ok) {
    return { status: 200, text: data.choices?.[0]?.message?.content || '' };
  }
  return { status: res.status, text: null };
}

async function callCloudflare(model, messages, maxTokens) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token     = process.env.CF_API_TOKEN;
  if (!accountId || !token) return { status: 401, text: null };

  const sysMsg  = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'system', content: sysMsg }, ...history],
        max_tokens: maxTokens,
      }),
    }
  );
  const data = await res.json();

  if (res.ok && data.success) {
    return { status: 200, text: data.result?.response || '' };
  }
  const is429 = res.status === 429 || JSON.stringify(data).includes('rate limit');
  return { status: is429 ? 429 : res.status, text: null };
}

// ── Main Handler ──────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system, max_tokens } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // Ambil 6 pesan terakhir saja — cegah 413 & hemat token
  const trimmed    = messages.slice(-6);
  const safeMax    = Math.min(max_tokens || 2048, 2048);
  const fullMsgs   = [{ role: 'system', content: system || '' }, ...trimmed];

  // Kumpulkan keys
  const groqKeys       = collectKeys('GROQ_API_KEY');
  const geminiKeys     = collectKeys('GEMINI_API_KEY');
  const openrouterKeys = collectKeys('OPENROUTER_API_KEY', 5);
  const hasCF          = !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN);

  if (groqKeys.length === 0 && geminiKeys.length === 0 && openrouterKeys.length === 0 && !hasCF) {
    return res.status(500).json({ error: 'Tidak ada API Key yang dikonfigurasi di server.' });
  }

  // Build attempt list: Groq → Gemini → OpenRouter → Cloudflare
  const attempts = [];

  for (const key of groqKeys) {
    for (const model of GROQ_MODELS) {
      attempts.push({ provider: 'groq', key, model });
    }
  }
  for (const key of geminiKeys) {
    for (const model of GEMINI_MODELS) {
      attempts.push({ provider: 'gemini', key, model });
    }
  }
  for (const key of openrouterKeys) {
    for (const model of OPENROUTER_MODELS) {
      attempts.push({ provider: 'openrouter', key, model });
    }
  }
  if (hasCF) {
    for (const model of CF_MODELS) {
      attempts.push({ provider: 'cloudflare', model });
    }
  }

  // Rotasi semua kombinasi
  const invalidKeys = new Set();

  for (const attempt of attempts) {
    // Skip key yang sudah 401
    if (attempt.key && invalidKeys.has(attempt.key)) continue;

    try {
      let result;

      if (attempt.provider === 'groq') {
        result = await callGroq(attempt.key, attempt.model, fullMsgs, safeMax);
      } else if (attempt.provider === 'gemini') {
        result = await callGemini(attempt.key, attempt.model, fullMsgs, safeMax);
      } else if (attempt.provider === 'openrouter') {
        result = await callOpenRouter(attempt.key, attempt.model, fullMsgs, safeMax);
      } else if (attempt.provider === 'cloudflare') {
        result = await callCloudflare(attempt.model, fullMsgs, safeMax);
      } else {
        continue;
      }

      // ✅ Sukses
      if (result.status === 200 && result.text) {
        res.setHeader('X-Provider', attempt.provider);
        res.setHeader('X-Model', attempt.model);
        return res.status(200).json({ content: [{ text: result.text }] });
      }

      // 429 Rate limit → coba berikutnya
      if (result.status === 429) continue;

      // 401 Key invalid → tandai, skip semua model dari key ini
      if (result.status === 401 && attempt.key) {
        invalidKeys.add(attempt.key);
        continue;
      }

      // Error lain → skip ke berikutnya juga (jangan stop)
      continue;

    } catch (e) {
      // Network error → lanjut
      continue;
    }
  }

  // Semua kombinasi habis
  return res.status(429).json({
    error:
      `Semua provider sedang rate limit. ` +
      `Tunggu 1 menit lalu coba lagi.`,
  });
}
