# Resume ATS Analyzer — Backend (MVP)

Express server matching the `ResumeUpload.jsx` frontend's `/api/analyze` call.

## Setup

```bash
npm install
cp .env.example .env
# fill in OPENROUTER_API_KEY (or OPENAI_API_KEY) and JOBS_CSV_PATH in .env
npm start
```

Server runs on `http://localhost:8000` by default (matches `API_BASE_URL` in the frontend).

If no API key is set, or OpenRouter is unreachable/rate-limited, the server falls back
automatically to the dictionary-based extractor — the app never hard-fails on the LLM step.

## Endpoints

- `GET /api/health` — sanity check, returns how many jobs loaded from CSV
- `GET /api/jobs?search=engineer&limit=20` — powers the frontend's job dropdown
- `POST /api/analyze` — multipart form:
  - `resume`: PDF file (required)
  - `job_id`: id from `/api/jobs`, **or**
  - `jd_text`: pasted job description (30+ chars)

  Returns ATS score, matched/missing skills, missing keywords.

## What's real vs. placeholder

- PDF text extraction (`pdf-parse`) — real
- Skill/keyword extraction — real, via an OpenRouter LLM call (`openai/gpt-oss-120b:free`,
  rolling back to `qwen/qwen3-4b:free` on failure). Falls back to the old dictionary matcher
  if no API key is set or every model in the rollback list fails.
- Semantic similarity — **real**, via local `all-MiniLM-L6-v2` embeddings
  (`@xenova/transformers`, ONNX, no API key or per-request cost). Falls back to
  skill/keyword overlap only if the embedding model fails to load. Check
  `semantic_similarity_method` in the response to see which path ran.
- Experience/education/formatting/grammar scoring — fixed at full marks for now (Phase 7 stub).
  LLM extraction does pull `education`/`experience`/`projects`/`certificates` from the resume
  (see `resume_details` in the response) — they're just not scored yet.

**Note on first run:** the embedding model (~90MB) downloads from Hugging Face the first
time the server starts and caches locally after that. The server starts loading it
immediately on boot (see the "Loading embedding model..." log line) so it's usually ready
before your first real request, but the very first `/api/analyze` call after a fresh
install may be slower while the download finishes.

## Next steps

1. Add LLM calls for suggestions and bullet-point rewrites (Phase 9-13).
2. Move `JOBS` from an in-memory CSV load to Postgres/MySQL per the original architecture doc.
3. If cosine similarity scores cluster too tightly (common with MiniLM on short texts),
   consider re-scaling the raw score before feeding it into `computeScore` — e.g. a simple
   min-max stretch based on observed score ranges from real test data.