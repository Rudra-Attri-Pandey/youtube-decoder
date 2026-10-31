/* YouTube Decoder backend — Express server.
 * Modes:
 *   - AI mode:         GEMINI_API_KEY (preferred) or OMNIROUTE_API_KEY set.
 *   - Transcript-only: no key configured. Returns real transcript segments
 *                      with { simulated:false, ai:false }. NEVER fakes insights.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const APP_DIR = __dirname;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const OMNI_KEY = (process.env.OMNIROUTE_API_KEY || '').trim();
const OMNI_BASE = (process.env.OMNIROUTE_BASE_URL || '').trim().replace(/\/+$/, '');
const OMNI_MODEL = (process.env.OMNIROUTE_MODEL || 'default').trim();
const AI_MODE = Boolean(GEMINI_KEY || OMNI_KEY);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3010')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Security middleware -------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / non-browser
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7' }));

// Sensitive-file guard: never expose secrets, DBs, or server internals.
const SENSITIVE = /(\.env(\.|$)|package(-lock)?\.json|\.db$|\.sqlite3?$|transcript_helper\.py|(^|\/)server\.js$|\.map$)/i;
app.use((req, res, next) => {
  if (SENSITIVE.test(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(APP_DIR, { dotfiles: 'deny', index: 'index.html' }));

// --- YouTube URL validation ----------------------------------------------
const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  if (host === 'youtu.be') {
    const m = u.pathname.match(/^\/([A-Za-z0-9_-]{11})/);
    return m && ID_RE.test(m[1]) ? m[1] : null;
  }
  // youtube.com family: watch?v=, /shorts/, /embed/, /live/, /v/
  const v = u.searchParams.get('v');
  if (v && ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// --- Helpers --------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** Deterministic extractive fallback built ONLY from the real transcript. */
function extractiveInsights(segments) {
  const n = segments.length;
  const picks = n <= 5 ? segments : [0, 1, 2, 3, 4].map((i) => segments[Math.floor((i * n) / 5)]);
  return picks.map((s) => ({
    time: fmtTime(s.start),
    text: s.text.length > 220 ? s.text.slice(0, 217) + '…' : s.text,
    cat: 'Transcript',
    conf: '—',
  }));
}

function pythonBin() {
  for (const c of ['python', 'python3']) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 5000 });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return 'python';
}

function fetchTranscriptPython(videoId) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [path.join(APP_DIR, 'transcript_helper.py'), videoId], {
      timeout: 45000, windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, error: 'python spawn failed' }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (parsed.ok && Array.isArray(parsed.segments) && parsed.segments.length) {
          return resolve({ ok: true, segments: parsed.segments, via: 'youtube-transcript-api' });
        }
        resolve({ ok: false, error: parsed.error || err || 'no transcript' });
      } catch { resolve({ ok: false, error: err || 'unparseable helper output' }); }
    });
  });
}

function parseVtt(vtt) {
  const segs = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\s*\n/);
  const ts = /(\d+:)?(\d+):(\d+)\.(\d+)\s*-->\s*(\d+:)?(\d+):(\d+)\.(\d+)/;
  const toSec = (h, m, s) => (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const idx = lines.findIndex((l) => ts.test(l));
    if (idx < 0) continue;
    const m = lines[idx].match(ts);
    const text = lines.slice(idx + 1).join(' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (segs.length && segs[segs.length - 1].text === text) continue; // dedupe repeats
    segs.push({ start: toSec(m[1], m[2], m[3]), dur: 0, text });
  }
  for (let i = 0; i < segs.length; i++) {
    segs[i].dur = i + 1 < segs.length
      ? Math.max(1, Math.round((segs[i + 1].start - segs[i].start) * 10) / 10) : 4;
  }
  return segs;
}

/** Fallback: yt-dlp auto/manual subs -> VTT -> segments. */
function fetchTranscriptYtDlp(videoId) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-'));
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const tryBins = [
      [pythonBin(), ['-m', 'yt_dlp']],
      ['yt-dlp', []],
      [path.join(APP_DIR, 'yt-dlp.exe'), []],
    ];
    (function attempt(i) {
      if (i >= tryBins.length) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return resolve({ ok: false, error: 'yt-dlp not available' });
      }
      const [bin, prefix] = tryBins[i];
      const args = [...prefix, '--skip-download', '--no-playlist',
        '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*',
        '--sub-format', 'vtt', '--output', path.join(tmp, '%(id)s.%(ext)s'),
        '--quiet', '--no-warnings', url];
      const child = spawn(bin, args, { timeout: 90000, windowsHide: true });
      child.on('error', () => attempt(i + 1));
      child.on('close', (code) => {
        if (code !== 0) return attempt(i + 1);
        try {
          const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.vtt'));
          const en = files.filter((f) => /\.en[^.]*\.vtt$/i.test(f));
          const pick = en[0] || files[0];
          if (!pick) return attempt(i + 1);
          const segs = parseVtt(fs.readFileSync(path.join(tmp, pick), 'utf8'));
          fs.rmSync(tmp, { recursive: true, force: true });
          if (segs.length) return resolve({ ok: true, segments: segs, via: 'yt-dlp' });
          return resolve({ ok: false, error: 'yt-dlp produced no parseable cues' });
        } catch (e) { return resolve({ ok: false, error: String(e && e.message || e) }); }
      });
    })(0);
  });
}

async function fetchTitle(videoId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.title === 'string' ? j.title : null;
  } catch { return null; }
}

// --- LLM ------------------------------------------------------------------
const INSIGHT_PROMPT = (transcript) => (
  'You analyze YouTube video transcripts. From the transcript below (lines start with [MM:SS]), '
  + 'extract exactly 5 key insights ordered chronologically.\n'
  + 'Return ONLY a JSON array (no markdown, no prose) of exactly 5 objects with keys:\n'
  + '{"time": "MM:SS timestamp from the transcript", "text": "one-sentence insight, max 25 words", '
  + '"cat": "short category of 1-2 words", "conf": "High or Medium or Low"}\n\n'
  + 'TRANSCRIPT:\n' + transcript
);

function sanitizeInsights(arr) {
  if (!Array.isArray(arr)) return null;
  const clean = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const time = String(it.time || '').match(/^\d{1,3}:\d{2}(?::\d{2})?$/) ? String(it.time) : null;
    const text = String(it.text || '').trim().slice(0, 300);
    if (!time || !text) continue;
    clean.push({
      time,
      text,
      cat: String(it.cat || 'General').trim().slice(0, 30) || 'General',
      conf: ['High', 'Medium', 'Low'].includes(it.conf) ? it.conf : 'Medium',
    });
  }
  return clean.length ? clean : null;
}

function extractJsonArray(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function transcriptForPrompt(segments) {
  const lines = segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`);
  let joined = lines.join('\n');
  if (joined.length > 12000) joined = joined.slice(0, 12000) + '\n…(truncated)';
  return joined;
}

const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

async function callGemini(segments) {
  const prompt = INSIGHT_PROMPT(transcriptForPrompt(segments));
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 1500 },
        }),
      }
    );
    if (r.ok) {
      const j = await r.json();
      lastErr = null;
      var geminiJson = j;
      break;
    }
    lastErr = new Error(`Gemini ${model} HTTP ${r.status}`);
    if (r.status === 400) break; // bad request/key — retrying another model won't help
  }
  if (lastErr) throw lastErr;
  const j = geminiJson;
  const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && j.candidates[0].content.parts && j.candidates[0].content.parts.map((p) => p.text || '').join('');
  const insights = sanitizeInsights(extractJsonArray(text));
  if (!insights) throw new Error('Gemini returned unparseable JSON');
  return insights;
}

async function callOmniRoute(segments) {
  if (!OMNI_BASE) throw new Error('OMNIROUTE_BASE_URL not configured');
  const r = await fetch(`${OMNI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OMNI_KEY}` },
    body: JSON.stringify({
      model: OMNI_MODEL,
      messages: [
        { role: 'system', content: 'Return only the requested JSON array, no prose.' },
        { role: 'user', content: INSIGHT_PROMPT(transcriptForPrompt(segments)) },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) throw new Error(`OmniRoute HTTP ${r.status}`);
  const j = await r.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = extractJsonArray(text); }
  const arr = Array.isArray(parsed) ? parsed : (parsed && (parsed.insights || parsed.data));
  const insights = sanitizeInsights(arr);
  if (!insights) throw new Error('OmniRoute returned unparseable JSON');
  return insights;
}

// --- API ------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: AI_MODE ? 'ai' : 'transcript-only', ai: AI_MODE, simulated: false });
});

app.post('/api/decode', async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing "url" string in request body.' });
  }
  if (url.length > 2000) {
    return res.status(400).json({ error: 'URL exceeds 2000 character limit.' });
  }
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Supported: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/.',
    });
  }

  let tr = await fetchTranscriptPython(videoId);
  let via = tr.via;
  if (!tr.ok) {
    const fb = await fetchTranscriptYtDlp(videoId);
    if (fb.ok) { tr = fb; via = fb.via; }
  }
  if (!tr.ok || !tr.segments || !tr.segments.length) {
    return res.status(422).json({
      error: 'No transcript or captions found for this video. The video may have captions disabled, be private/age-restricted, or be unavailable. No insights were generated.',
      videoId,
    });
  }
  const segments = tr.segments.slice(0, 2000);
  const [title] = await Promise.all([fetchTitle(videoId)]);

  // AI insights only when a key is configured; otherwise honest transcript mode.
  if (AI_MODE) {
    try {
      const insights = GEMINI_KEY ? await callGemini(segments) : await callOmniRoute(segments);
      return res.json({
        videoId, title, mode: 'ai', ai: true, simulated: false,
        provider: GEMINI_KEY ? 'gemini' : 'omniroute',
        transcriptVia: via, segmentCount: segments.length, segments, insights,
      });
    } catch (e) {
      return res.json({
        videoId, title, mode: 'transcript-only', ai: false, simulated: false,
        transcriptVia: via, segmentCount: segments.length, segments,
        insights: extractiveInsights(segments),
        notice: `AI insight generation failed (${(e && e.message) || e}); showing real transcript instead. Add a valid API key to retry.`,
      });
    }
  }
  return res.json({
    videoId, title, mode: 'transcript-only', ai: false, simulated: false,
    transcriptVia: via, segmentCount: segments.length, segments,
    insights: extractiveInsights(segments),
    notice: 'Transcript only — add GEMINI_API_KEY or OMNIROUTE_API_KEY for AI insights.',
  });
});

// --- Boot: PORT or first free 30xx ----------------------------------------
function listenOn(port) {
  if (port > 3099) { console.error('No free port in 3010-3099.'); process.exit(1); }
  const server = net.createServer();
  server.once('error', () => listenOn(port + 1));
  server.once('listening', () => {
    server.close(() => {
      app.listen(port, () => {
        console.log(`[decoder] listening on http://localhost:${port}`);
        console.log(`[decoder] mode: ${AI_MODE ? 'AI (provider: ' + (GEMINI_KEY ? 'gemini' : 'omniroute') + ')' : 'TRANSCRIPT-ONLY (no GEMINI_API_KEY / OMNIROUTE_API_KEY set — add one for AI insights)'}`);
        console.log(`[decoder] CORS origins: ${CORS_ORIGINS.join(', ')}`);
      });
    });
  });
  server.listen(port);
}
module.exports = app;

// Guarded so `require('./server')` (e.g. serverless) does not start a listener.
// Direct `node server.js` behavior is unchanged.
if (require.main === module) {
  listenOn(Number(process.env.PORT) || 3010);
}
