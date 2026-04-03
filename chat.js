/**
 * RBXAI — Multi-Provider Smart Proxy
 * Provider: Groq + Google Gemini + OpenRouter + Cloudflare AI
 * By.DevFahmi
 */

// Vercel: naikkan body size limit & tambah timeout
export const config = {
  api: {
    bodyParser: { sizeLimit: '4mb' },
    responseLimit: false,
  },
};
 *
 * ═══════════════════════════════════════════════════════════════
 *  SETUP — Vercel → Settings → Environment Variables
 * ═══════════════════════════════════════════════════════════════
 *
 *  ── GROQ (console.groq.com/keys) ─────────────────────────────
 *  GROQ_API_KEY_1   = gsk_...
 *  GROQ_API_KEY_2   = gsk_...
 *  ...hingga GROQ_API_KEY_10
 *
 *  ── GOOGLE GEMINI (aistudio.google.com/apikey) ───────────────
 *  GEMINI_API_KEY_1 = AIza...
 *  GEMINI_API_KEY_2 = AIza...
 *  ...hingga GEMINI_API_KEY_10
 *
 *  ── OPENROUTER (openrouter.ai/keys) ──────────────────────────
 *  OPENROUTER_API_KEY_1 = sk-or-...
 *  OPENROUTER_API_KEY_2 = sk-or-...
 *  ...hingga OPENROUTER_API_KEY_5
 *
 *  ── CLOUDFLARE AI (dash.cloudflare.com → AI → Workers AI) ───
 *  CF_ACCOUNT_ID        = your_account_id
 *  CF_API_TOKEN         = your_api_token
 *
 * ═══════════════════════════════════════════════════════════════
 *  ROTASI: Groq → Gemini → OpenRouter → Cloudflare
 *  Jika satu provider/key/model 429 → otomatis next
 *  Total kombinasi maks: ~80+ percobaan per request
 * ═══════════════════════════════════════════════════════════════
 */

// ──────────────────────────────────────────────────────────────
//  PROVIDER DEFINITIONS
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
//  HELPER: Collect keys from env
// ──────────────────────────────────────────────────────────────

function collectKeys(prefix, max = 10) {
  const keys = [];
  for (let i = 1; i <= max; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k && k.trim().length > 8) keys.push(k.trim());
  }
  // fallback tanpa nomor
  const plain = process.env[prefix];
  if (keys.length === 0 && plain && plain.trim().length > 8) {
    keys.push(plain.trim());
  }
  return keys;
}

// ──────────────────────────────────────────────────────────────
//  CALLER: Groq  (OpenAI-compatible)
// ──────────────────────────────────────────────────────────────

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
  return { status: res.status, data };
}

// ──────────────────────────────────────────────────────────────
//  CALLER: Google Gemini
// ──────────────────────────────────────────────────────────────

async function callGemini(key, model, messages, maxTokens) {
  // Pisahkan system message dari history
  const system = messages.find(m => m.role === 'system');
  const history = messages.filter(m => m.role !== 'system');

  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system.content }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  // Map Gemini response ke format standar
  if (res.ok) {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { status: 200, text };
  }

  // Gemini returns 429 sebagai RESOURCE_EXHAUSTED
  const code = data?.error?.code || res.status;
  const msg  = data?.error?.message || '';
  const is429 = code === 429 || code === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
  return { status: is429 ? 429 : code, data };
}

// ──────────────────────────────────────────────────────────────
//  CALLER: OpenRouter  (OpenAI-compatible)
// ──────────────────────────────────────────────────────────────

async function callOpenRouter(key, model, messages, maxTokens) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://rbxai.vercel.app',
      'X-Title': 'RBXAI Roblox Script Engine',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ──────────────────────────────────────────────────────────────
//  CALLER: Cloudflare Workers AI
// ──────────────────────────────────────────────────────────────

async function callCloudflare(model, messages, maxTokens) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token     = process.env.CF_API_TOKEN;
  if (!accountId || !token) return { status: 401, data: { error: { message: 'CF not configured' } } };

  // Cloudflare: pisahkan system dari messages
  const system  = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role:'system', content: system }, ...history], max_tokens: maxTokens }),
    }
  );
  const data = await res.json();

  if (res.ok && data.success) {
    return { status: 200, text: data.result?.response || '' };
  }
  const is429 = res.status === 429 || JSON.stringify(data).includes('rate limit');
  return { status: is429 ? 429 : res.status, data };
}

// ──────────────────────────────────────────────────────────────
//  EXTRACT TEXT from OpenAI-compatible response
// ──────────────────────────────────────────────────────────────

function extractText(data) {
  return data?.choices?.[0]?.message?.content || null;
}

// ──────────────────────────────────────────────────────────────
//  MAIN HANDLER
// ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  const { messages, system, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // ── Trim messages agar tidak 413 ──────────────────────────────
  // Selalu ambil: system + 6 pesan terakhir saja
  // Ini cukup untuk konteks percakapan tanpa membebani payload
  const trimmed = messages.slice(-6);

  // Token limit yang aman
  const safeMax = Math.min(max_tokens || 2048, 2048);

  // Messages dengan system digabungkan (untuk provider OpenAI-compat)
  const fullMessages = [
    { role: 'system', content: system || '' },
    ...trimmed,
  ];

  // Kumpulkan semua keys
  const groqKeys        = collectKeys('GROQ_API_KEY');
  const geminiKeys      = collectKeys('GEMINI_API_KEY');
  const openrouterKeys  = collectKeys('OPENROUTER_API_KEY', 5);
  const hasCF           = !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN);

  const totalProviders = (groqKeys.length > 0 ? 1 : 0) +
                         (geminiKeys.length > 0 ? 1 : 0) +
                         (openrouterKeys.length > 0 ? 1 : 0) +
                         (hasCF ? 1 : 0);

  if (totalProviders === 0) {
    return res.status(500).json({ error: 'Tidak ada API Key yang dikonfigurasi di server.' });
  }

  // ── Build attempt list ────────────────────────────────────────
  // Urutan: Groq → Gemini → OpenRouter → Cloudflare
  const attempts = [];

  // Groq: key luar, model dalam
  for (const key of groqKeys) {
    for (const model of GROQ_MODELS) {
      attempts.push({ provider: 'groq', key, model });
    }
  }

  // Gemini: key luar, model dalam
  for (const key of geminiKeys) {
    for (const model of GEMINI_MODELS) {
      attempts.push({ provider: 'gemini', key, model });
    }
  }

  // OpenRouter: key luar, model dalam (semua model free)
  for (const key of openrouterKeys) {
    for (const model of OPENROUTER_MODELS) {
      attempts.push({ provider: 'openrouter', key, model });
    }
  }

  // Cloudflare: satu set model (tidak pakai key terpisah)
  if (hasCF) {
    for (const model of CF_MODELS) {
      attempts.push({ provider: 'cloudflare', model });
    }
  }

  // ── Rotate through all attempts ──────────────────────────────
  let skipKey = null; // untuk skip semua model dari key yang 401

  for (const attempt of attempts) {
    // Skip jika key ini sudah 401
    if (skipKey && attempt.key === skipKey) continue;
    skipKey = null;

    try {
      let status, text, data;

      if (attempt.provider === 'groq') {
        ({ status, data } = await callGroq(attempt.key, attempt.model, fullMessages, safeMax));
        if (status === 200) text = extractText(data);
      }
      else if (attempt.provider === 'gemini') {
        const r = await callGemini(attempt.key, attempt.model, fullMessages, safeMax);
        status = r.status; text = r.text; data = r.data;
      }
      else if (attempt.provider === 'openrouter') {
        ({ status, data } = await callOpenRouter(attempt.key, attempt.model, fullMessages, safeMax));
        if (status === 200) text = extractText(data);
      }
      else if (attempt.provider === 'cloudflare') {
        const r = await callCloudflare(attempt.model, fullMessages, safeMax);
        status = r.status; text = r.text; data = r.data;
      }

      // ✅ Sukses
      if (status === 200 && text) {
        res.setHeader('X-Provider', attempt.provider);
        res.setHeader('X-Model', attempt.model);
        return res.status(200).json({ content: [{ text }] });
      }

      // 429 Rate limit → coba berikutnya
      if (status === 429) continue;

      // 401 Invalid key → skip semua model untuk key ini
      if (status === 401) { skipKey = attempt.key; continue; }

      // Error fatal lain (400, 500) → stop, jangan retry
      const errMsg = data?.error?.message || `HTTP ${status}`;
      return res.status(status).json({ error: errMsg });

    } catch (e) {
      // Network error → coba berikutnya
      continue;
    }
  }

  // ── Semua habis ──────────────────────────────────────────────
  return res.status(429).json({
    error:
      `Semua provider sedang rate limit (${attempts.length} kombinasi dicoba). ` +
      `Tunggu 1 menit lalu coba lagi.`,
  });
}
