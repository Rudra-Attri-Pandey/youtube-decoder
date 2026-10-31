# YouTube Video Decoder (real backend)

Paste a YouTube URL → the server fetches its **real captions**, optionally
asks an LLM for **5 timestamped insights**, and the browser exports the real
data as **CSV / TXT / Markdown / JSON** (plus copy-to-clipboard).

No fake data: every insight row comes from the video's actual transcript.
Without an API key the app runs in **transcript-only mode** and says so.

---

## Run

```bash
npm install
npm start        # http://localhost:3010 (or first free 3010-3099)
```

Python 3 with `youtube-transcript-api` is used for captions
(`pip install youtube-transcript-api`); `yt-dlp` (`pip install yt-dlp`)
is the automatic fallback. No API key needed for transcript mode.

Optional AI insights — copy `.env.example` to `.env` and set one:

| Var | Effect |
| --- | ------ |
| `GEMINI_API_KEY` | AI insights via Gemini 2.0 Flash (tried first) |
| `OMNIROUTE_API_KEY` | Fallback LLM via OpenAI-compatible `OMNIROUTE_BASE_URL/chat/completions` (`OMNIROUTE_MODEL`, default `default`) |
| `PORT` | Preferred port (default `3010`) |
| `CORS_ORIGINS` | Comma-separated allowed origins (default `http://localhost:3010`) |

## API

`POST /api/decode` with `{ "url": "<youtube url>" }`
(supports `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`).

| Status | Meaning |
| ------ | ------- |
| 200 | `{ videoId, title, mode: "ai" \| "transcript-only", ai, simulated: false, insights[{time,text,cat,conf}], segments[{start,dur,text}], segmentCount, notice? }` |
| 400 | Not a YouTube URL (or missing/oversize `url`) |
| 422 | Video has no captions / is private / unavailable — no insights invented |
| 429 | Rate-limited |

`GET /api/health` → `{ ok, mode, ai, simulated: false }`.

## Honest capability list

- ✅ Real caption fetching (`youtube-transcript-api`, `yt-dlp` fallback)
- ✅ Strict YouTube URL validation (`watch`, `youtu.be`, `shorts`, `embed`)
- ✅ Real AI insights when `GEMINI_API_KEY`/`OMNIROUTE_API_KEY` is set
- ✅ Transcript-only mode with extractive (non-AI) rows when no key
- ✅ Real CSV / TXT / MD / JSON exports + copy-to-clipboard, all from live data
- ✅ Helmet, CORS allowlist, rate limiting, `.env`/`*.db` file guard
- ❌ No DOCX / PPTX / MP3 / IPYNB generation (removed — they were fake plaintext)
- ❌ No insights for videos without captions (returns 422 instead of inventing)
