#!/usr/bin/env node
/*
 * Джарвис — мост для сцен «Центра управления AI-аудитом».
 *
 * Отдаёт две сцены (v4 «сфера» и v5 «мозг»), отвечает на голосовые вопросы
 * через Claude API и озвучивает ответы: Yandex SpeechKit → системный `say` (macOS)
 * → голос браузера (если сервер говорить не может, сцена переключается сама).
 *
 * Запуск:  cp .env.example .env  (вписать ANTHROPIC_API_KEY)
 *          npm install && npm start  → http://localhost:8321
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

loadEnv(path.join(__dirname, '.env'));

const Anthropic = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT || 8321);
const HOST = process.env.JARVIS_BIND_HOST || '127.0.0.1';
const MODEL = process.env.JARVIS_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.JARVIS_EFFORT || 'low'; // голосовой диалог: важнее скорость, чем глубина

const SCENES = {
  '/v4': 'scene-v4-sfera.html', '/sfera': 'scene-v4-sfera.html',
  '/v5': 'scene-v5-mozg.html', '/mozg': 'scene-v5-mozg.html',
};
const DEFAULT_SCENE = process.env.JARVIS_DEFAULT_SCENE === 'v4' ? 'scene-v4-sfera.html' : 'scene-v5-mozg.html';

const SYSTEM = process.env.JARVIS_SYSTEM || [
  'Ты — Джарвис, голосовой ассистент «Центра управления AI-аудитом» для селлеров маркетплейсов.',
  'Отвечай по-русски, КРАТКО — одно-три предложения, произносимым разговорным текстом:',
  'без markdown, без списков, без кода, без эмодзи; числа и проценты — так, как их читают вслух.',
  'Стиль — вежливый дворецкий-инженер: спокойно, точно, с лёгкой иронией; обращение «сэр» уместно, но не в каждой фразе.',
  'У тебя нет доступа к файлам, почте, базам данных и внешним системам. Если просят что-то сделать или',
  'узнать конкретные цифры — честно скажи, что в этой версии ты только собеседник. Цифры и факты не выдумывай.',
].join(' ');

/* ================= .env без зависимостей ================= */
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/* ================= мозг: Claude API ================= */
let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // ключ — ANTHROPIC_API_KEY или профиль `ant auth login`
  return client;
}

function cleanHistory(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw.slice(-24) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content || '').slice(0, 4000).trim();
    if (content) out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function ask(history) {
  const messages = cleanHistory(history);
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('Пустой вопрос.');
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: EFFORT },
    // при отказе классификатора безопасности запрос сам перейдёт на запасную модель
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages,
  });
  if (response.stop_reason === 'refusal') return 'На этот вопрос я, увы, не отвечу, сэр.';
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  return text || 'Я задумался и промолчал. Повторите, пожалуйста.';
}

/* ================= голос ================= */
const RATE = 48000;

function splitSentences(text) {
  const parts = String(text).match(/[^.!?…]+[.!?…]+[»")\]]*|[^.!?…]+$/g) || [];
  return parts.map((p) => p.trim()).filter(Boolean).flatMap((p) => {
    const chunks = [];
    let rest = p;
    while (rest.length > 240) { // лимит Yandex на один запрос
      const cut = rest.lastIndexOf(' ', 240);
      const at = cut > 120 ? cut : 240;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  });
}

async function yandexPcm(text) {
  const res = await fetch('https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis', {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
      'x-folder-id': process.env.YANDEX_FOLDER_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      outputAudioSpec: { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: RATE } },
      hints: [{ voice: process.env.YANDEX_VOICE || 'zhanar_ru' }, ...(process.env.YANDEX_ROLE ? [{ role: process.env.YANDEX_ROLE }] : [{ role: 'friendly' }])],
      loudnessNormalizationType: 'LUFS',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yandex ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const chunks = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const data = JSON.parse(line)?.result?.audioChunk?.data;
    if (data) chunks.push(Buffer.from(data, 'base64'));
  }
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) throw new Error('Yandex вернул пустой звук');
  return pcm;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (err) => (err ? reject(err) : resolve())));
}

/* Порядок: Yandex SpeechKit (если есть ключи) → `say` macOS → ошибка (сцена говорит голосом браузера). */
async function speak(text) {
  if (process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID && process.platform === 'darwin') {
    try {
      const parts = splitSentences(text);
      const pcms = await Promise.all(parts.map(yandexPcm));
      const glued = [];
      pcms.forEach((p, i) => { // пауза по знаку: склейка звучит как цельная фраза
        glued.push(p);
        if (i < pcms.length - 1) glued.push(Buffer.alloc(Math.round(RATE * (/[?!][»")\]]*$/.test(parts[i]) ? 0.42 : 0.38)) * 2));
      });
      const file = path.join(os.tmpdir(), `jarvis-say-${process.pid}-${Date.now()}.wav`);
      fs.writeFileSync(file, wav(Buffer.concat(glued)));
      try { await run('afplay', [file]); } finally { fs.unlink(file, () => {}); }
      return;
    } catch (e) {
      console.warn('[голос] Yandex не сработал, перехожу на системный голос:', e.message);
    }
  }
  if (process.platform === 'darwin') {
    await run('say', ['-v', process.env.JARVIS_SAY_VOICE || 'Milena', '-r', '165', text]);
    return;
  }
  throw new Error('Серверного голоса нет — сцена скажет голосом браузера.');
}

/* ================= микрофонная эстафета: Джарвис слушает только в одной вкладке ================= */
let micHolder = null; // {id, lastSeen}
let micWant = null;   // желание пульта: null — не вмешивался
const MIC_TTL = 15000;
function micClaim(id) {
  if (!id) return false;
  const now = Date.now();
  if (micHolder && micHolder.id !== id && now - micHolder.lastSeen < MIC_TTL) return false;
  micHolder = { id, lastSeen: now };
  return true;
}

/* ================= HTTP ================= */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', reject);
  });
}
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const INDEX = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Джарвис</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020614;color:#eaf6ff;font:16px/1.5 system-ui,Arial}
main{padding:24px;text-align:center}a{display:inline-block;margin:10px;padding:14px 26px;border:1px solid #2fd8ff66;border-radius:12px;color:#7fe9ff;text-decoration:none}
a:hover{background:#2fd8ff22}p{opacity:.6;font-size:14px}</style></head><body><main><h1>Джарвис</h1>
<a href="/v4">v4 · сфера</a><a href="/v5">v5 · мозг</a><p>Клавиша V — включить слушание · «Джарвис, …» — вопрос · <code>?demo</code> — смена состояний без микрофона</p></main></body></html>`;

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && SCENES[pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, SCENES[pathname])));
    }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && pathname === '/scene') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, DEFAULT_SCENE)));
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, model: MODEL, effort: EFFORT, yandex: Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID) });
    }
    // в этой версии фоновых задач нет — очередь докладов всегда пуста
    if (req.method === 'GET' && pathname === '/announcements') return json(res, 200, { items: [] });
    if (req.method === 'POST' && pathname === '/ask') {
      const body = await readJson(req);
      return json(res, 200, { reply: await ask(body.messages) });
    }
    if (req.method === 'POST' && pathname === '/say') {
      const body = await readJson(req);
      const text = String(body.text || '').slice(0, 1200);
      if (!text) throw new Error('Пустой текст.');
      try { await speak(text); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && pathname === '/mic/claim') {
      const body = await readJson(req);
      return json(res, 200, { ok: micClaim(String(body.clientId || '')) });
    }
    if (req.method === 'POST' && pathname === '/mic/release') {
      const body = await readJson(req);
      if (micHolder && micHolder.id === String(body.clientId || '')) micHolder = null;
      return json(res, 200, { ok: true });
    }
    // пульт с телефона: /mic/remote?on=1 — включить слушание, ?on=0 — выключить
    if (pathname === '/mic/remote') {
      micWant = new URL(req.url, 'http://localhost').searchParams.get('on') === '1';
      return json(res, 200, { ok: true, said: micWant ? 'Слушаю.' : 'Микрофон выключен.' });
    }
    if (pathname === '/mic/remote/state') return json(res, 200, { want: micWant });
    res.writeHead(404); res.end('not found');
  } catch (err) {
    let message = String(err.message || err);
    if (err instanceof Anthropic.AuthenticationError) message = 'Нет доступа к Claude API — проверьте ANTHROPIC_API_KEY в .env';
    else if (err instanceof Anthropic.RateLimitError) message = 'Claude API просит подождать — повторите через минуту';
    else if (err instanceof Anthropic.APIError) message = `Claude API ${err.status}: ${err.message}`;
    json(res, 500, { error: message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Джарвис: http://localhost:${PORT}  (v4 — /v4, v5 — /v5)`);
  console.log(`Модель: ${MODEL}, effort ${EFFORT}. Голос: ${process.env.YANDEX_API_KEY ? 'Yandex SpeechKit' : process.platform === 'darwin' ? 'системный say' : 'браузер'}`);
});
