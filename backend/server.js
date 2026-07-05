require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const { parse: parseCsv } = require("csv-parse/sync");
const { pipeline } = require("@xenova/transformers");

const app = express();
const PORT = process.env.PORT || 8000;

const JOBS_CSV_PATH = path.resolve(process.env.JOBS_CSV_PATH || "./jobs.csv");

// ─── OpenRouter ────────────────────────────────────────────────────────────────
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Multiple accounts → automatic key rotation on 429. Each free account
// gets 50 req/day, so two accounts effectively doubles your daily budget.
const OPENROUTER_API_KEYS = [
    process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
].filter(Boolean);

if (OPENROUTER_API_KEYS.length === 0) {
    console.warn("[llm] No API keys — extraction will use dictionary fallback.");
} else {
    console.log(`[llm] ${OPENROUTER_API_KEYS.length} API key(s) loaded.`);
}

// Preferred models in priority order. fetchLiveModels() intersects this list
// with what's actually available on OpenRouter right now, preserving order.
// Add or reorder here if your preferred models change.
const PREFERRED_MODELS = [
    "openai/gpt-oss-120b:free",
    "deepseek/deepseek-chat-v3-0324:free",
    'openai/gpt-4o-mini',
    'meta-llama/llama-3.1-8b-instruct',
    'google/gemma-2-9b-it',
    'microsoft/phi-3-mini-128k-instruct',
    "moonshotai/kimi-k2:free",
    "deepseek/deepseek-r1-0528:free",
    "qwen/qwen3-235b-a22b:free",
    "deepseek/deepseek-r1:free",
    "meta-llama/llama-3.3-70b-instruct:free",
];

// Populated at boot by fetchLiveModels(); falls back to PREFERRED_MODELS if
// the fetch fails. Only models confirmed live are kept in this list.
let ACTIVE_MODELS = [...PREFERRED_MODELS];

async function fetchLiveModels() {
    if (!OPENROUTER_API_KEYS[0]) return;
    try {
        const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEYS[0]}` },
        });
        const data = await res.json();
        const liveIds = new Set(
            (data.data || [])
                .filter((m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0")
                .map((m) => m.id)
        );
        // Keep only preferred models that are currently live, in preferred order.
        // Fall back to the full preferred list if nothing matched (API schema change etc).
        const filtered = PREFERRED_MODELS.filter((m) => liveIds.has(m));
        ACTIVE_MODELS = filtered.length ? filtered : [...PREFERRED_MODELS];
        console.log(`[llm] Active models: ${ACTIVE_MODELS.join(", ")}`);
    } catch (err) {
        console.warn("[llm] Could not fetch live models, using preferred list:", err.message);
    }
}

fetchLiveModels();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        file.mimetype === "application/pdf"
            ? cb(null, true)
            : cb(new Error("Only PDF files are accepted"));
    },
});

// ─── Jobs store ────────────────────────────────────────────────────────────────
let JOBS = [];

function loadJobs() {
    if (!fs.existsSync(JOBS_CSV_PATH)) {
        console.warn(`[jobs] CSV not found at ${JOBS_CSV_PATH}`);
        return;
    }
    const rows = parseCsv(fs.readFileSync(JOBS_CSV_PATH, "utf8"), {
        columns: true, skip_empty_lines: true, relax_quotes: true,
    });
    JOBS = rows.map((r) => ({
        id: r.id || "",
        title: r.title || "",
        company: r.company || "",
        location: r.location || "",
        description: r.description || "",
        skills: r.skills || "",
    }));
    console.log(`[jobs] Loaded ${JOBS.length} jobs from ${JOBS_CSV_PATH}`);
}

loadJobs();

// ─── Role categories ───────────────────────────────────────────────────────────
const ROLE_CATEGORIES = [
    { id: "sde", label: "Software Engineer", keywords: ["software engineer", "sde", "software developer", "developer ii", "developer iii", "development engineer"] },
    { id: "full_stack", label: "Full Stack Developer", keywords: ["full stack", "full-stack", "fullstack"] },
    { id: "backend", label: "Backend Developer", keywords: ["backend", "back end", "back-end"] },
    { id: "frontend", label: "Frontend Developer", keywords: ["frontend", "front end", "front-end", "ui developer", "web developer"] },
    { id: "ai_ml", label: "AI / ML Engineer", keywords: ["ai engineer", "ai backend", "ai-native", "ai python", "machine learning", "ml engineer", "applied ai", "ai engg"] },
    { id: "devops", label: "DevOps / Cloud Engineer", keywords: ["devops", "site reliability", "sre", "cloud engineer", "platform engineer", "infrastructure engineer"] },
    { id: "data", label: "Data Engineer / Scientist", keywords: ["data engineer", "data scientist", "data analyst", "analytics engineer"] },
    { id: "mobile", label: "Mobile Developer", keywords: ["android", "ios developer", "mobile developer", "react native"] },
    { id: "qa", label: "QA / Test Engineer", keywords: ["qa engineer", "quality assurance", "test engineer", "automation test"] },
];

function jobMatchesCategory(job, categoryId) {
    const cat = ROLE_CATEGORIES.find((c) => c.id === categoryId);
    if (!cat) return false;
    const title = job.title.toLowerCase();
    return cat.keywords.some((kw) => title.includes(kw));
}

// ─── Embeddings ────────────────────────────────────────────────────────────────
const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
let embedderPromise = null;

function getEmbedder() {
    if (!embedderPromise) {
        console.log(`[embedder] Loading ${EMBEDDING_MODEL}…`);
        embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL);
    }
    return embedderPromise;
}

getEmbedder()
    .then(() => console.log("[embedder] Ready."))
    .catch((err) => console.warn("[embedder] Preload failed:", err.message));

// Embed the head AND tail of the text, then average + re-normalise.
// Useful for long JDs where requirements appear after the company-culture intro.
async function embedText(text) {
    const embedder = await getEmbedder();
    const head = text.slice(0, 2000);
    const tail = text.length > 2000 ? text.slice(-2000) : null;

    if (!tail || tail === head) {
        const out = await embedder(head, { pooling: "mean", normalize: true });
        return Array.from(out.data);
    }

    const [vH, vT] = await Promise.all([
        embedder(head, { pooling: "mean", normalize: true }),
        embedder(tail, { pooling: "mean", normalize: true }),
    ]);
    const avg = Array.from(vH.data).map((v, i) => (v + vT.data[i]) / 2);
    const norm = Math.sqrt(avg.reduce((s, v) => s + v * v, 0));
    return avg.map((v) => v / norm);
}

function cosineSimilarity(a, b) {
    // Vectors are L2-normalised, so dot product = cosine similarity.
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

// MiniLM raw scores for resume/JD pairs cluster in ~0.25–0.70 even for
// good matches. Re-scale to [0,1] so match_percent reads intuitively.
// Adjust these after testing ~20 real resume/JD pairs.
const SIM_MIN = 0.25;
const SIM_MAX = 0.70;

function rescaleSim(raw) {
    return Math.max(0, Math.min(1, (raw - SIM_MIN) / (SIM_MAX - SIM_MIN)));
}

async function computeSemanticSimilarity(resumeText, jdText) {
    try {
        const [rVec, jVec] = await Promise.all([embedText(resumeText), embedText(jdText)]);
        return rescaleSim(cosineSimilarity(rVec, jVec));
    } catch (err) {
        console.warn("[embedder] Similarity failed, using overlap fallback:", err.message);
        return null;
    }
}

// ─── JD text extraction (category scoring only) ────────────────────────────────
// Used exclusively in /api/analyze-category to extract JD skills from each
// sampled job without making N LLM calls. Not used for resume parsing —
// that always goes through the LLM.
const JD_SKILL_DICTIONARY = [
    "python", "java", "javascript", "typescript", "react", "node", "node.js", "express",
    "fastapi", "flask", "django", "docker", "kubernetes", "aws", "azure", "gcp",
    "sql", "postgresql", "mysql", "mongodb", "redis", "kafka", "rest api", "graphql",
    "ci/cd", "git", "microservices", "agile", "scrum", "html", "css", "tailwind",
    "next.js", "vue", "angular", "spring", "spring boot", "c++", "c#", "go", "rust",
    "machine learning", "deep learning", "nlp", "pandas", "numpy", "tensorflow",
    "pytorch", "scikit-learn", "spark", "hadoop", "terraform", "jenkins", "linux",
    "bash", "elasticsearch", "rabbitmq", "grpc", "websockets", "socket.io", "jwt",
];

function jdExtractSkills(text) {
    const lower = text.toLowerCase();
    return JD_SKILL_DICTIONARY.filter((s) => lower.includes(s));
}

function jdExtractKeywords(text, limit = 20) {
    const stop = new Set([
        "the", "and", "for", "with", "you", "your", "our", "are", "will", "have", "this",
        "that", "from", "who", "role", "team", "work", "experience", "job", "about", "able",
        "also", "into", "such", "more", "some", "than", "when", "been", "they", "what",
        "which", "would", "should", "could", "their", "other", "well", "each", "both",
        "time", "year", "help", "make", "need", "like", "good", "strong", "looking",
        "skills", "using", "based", "join", "build", "across", "ability", "within",
        "company", "working", "bonus", "ideal", "candidate", "position", "opportunity",
        "responsible", "requirements", "qualifications",
    ]);
    const freq = {};
    text.toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 3 && !stop.has(w))
        .forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

// ─── LLM calls ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripJsonFences(content) {
    return content
        .trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, "")   // remove <think> blocks (qwen, deepseek-r1)
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/, "")
        .replace(/```\s*$/, "")
        .trim();
}

// Iterates over (model × key) pairs. On 429 tries the next key immediately
// (fresh quota). On 404 skips the model entirely (it's been removed).
// Throws a structured LlmError with a human-readable `reason` so the API
// response tells the user exactly what went wrong instead of silently
// falling back to inaccurate dictionary-based results.
class LlmError extends Error {
    constructor(reason, detail) {
        super(detail || reason);
        this.reason = reason; // short code for the frontend to key on
        this.detail = detail; // human-readable sentence shown to the user
    }
}

async function callOpenRouterJSON(systemPrompt, userPrompt) {
    if (OPENROUTER_API_KEYS.length === 0)
        throw new LlmError("no_api_key", "No OpenRouter API key is configured. Add OPENROUTER_API_KEY to your .env file.");

    const models = ACTIVE_MODELS.length ? ACTIVE_MODELS.slice(0, 4) : PREFERRED_MODELS;

    // Track why each attempt failed so we can report the most useful reason.
    let allRateLimited = true;
    let allUnavailable = true;
    let lastErr;

    for (const model of models) {
        for (const [idx, apiKey] of OPENROUTER_API_KEYS.entries()) {
            const tag = `${model} (key${idx + 1})`;
            try {
                const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model,
                        max_tokens: 800,
                        temperature: 0.1,
                        response_format: { type: "json_object" },
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userPrompt },
                        ],
                    }),
                });

                if (res.status === 429) {
                    console.warn(`[llm] ${tag} rate-limited`);
                    await sleep(300);
                    lastErr = new LlmError("rate_limited", `Daily free-tier limit reached on all accounts. Resets at midnight UTC.`);
                    allUnavailable = false;
                    throw lastErr;
                }

                if (res.status === 401 || res.status === 403) {
                    console.warn(`[llm] ${tag} auth error`);
                    lastErr = new LlmError("auth_error", `API key ${idx + 1} was rejected (${res.status}). Check that OPENROUTER_API_KEY is correct in your .env file.`);
                    allRateLimited = false; allUnavailable = false;
                    throw lastErr;
                }

                if (res.status === 404) {
                    console.warn(`[llm] ${tag} model unavailable — removing from list`);
                    ACTIVE_MODELS = ACTIVE_MODELS.filter((m) => m !== model);
                    allRateLimited = false;
                    throw new Error("404_SKIP_MODEL");
                }

                if (!res.ok) {
                    const txt = await res.text().catch(() => "");
                    allRateLimited = false; allUnavailable = false;
                    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 150)}`);
                }

                const data = await res.json();
                const content = data?.choices?.[0]?.message?.content;
                if (!content) {
                    allRateLimited = false; allUnavailable = false;
                    throw new Error("Empty response from model");
                }

                const cleaned = stripJsonFences(content);
                if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
                    allRateLimited = false; allUnavailable = false;
                    throw new Error(`Model returned non-JSON: ${cleaned.slice(0, 80)}`);
                }

                const parsed = JSON.parse(cleaned);
                console.log(`[llm] ${tag} → OK`);
                return { parsed, modelUsed: model };
            } catch (err) {
                console.warn(`[llm] ${tag} failed — ${err.message}`);
                lastErr = err;
                if (err.message === "404_SKIP_MODEL") break; // skip remaining keys for this model
            }
        }
    }

    // All (model × key) combinations failed — build the most useful error message.
    if (lastErr instanceof LlmError) throw lastErr;

    if (allRateLimited)
        throw new LlmError("rate_limited", "All API keys have hit their daily free-tier limit (50 req/day). Resets at midnight UTC. Add a second account key or top up credits at openrouter.ai.");

    if (allUnavailable)
        throw new LlmError("models_unavailable", `None of the preferred models are currently available on OpenRouter. Check https://openrouter.ai/models for the current free model list and update PREFERRED_MODELS in server.js.`);

    throw new LlmError("extraction_failed", `LLM extraction failed after trying all models. Last error: ${lastErr?.message || "unknown"}`);
}

// Single prompt extracts both resume and JD — half the API calls vs two separate prompts.
const EXTRACTION_PROMPT = `You extract structured data from a resume AND a job description.
Respond with ONLY a valid JSON object. No markdown, no commentary, no thinking tags.
Schema:
{
  "resume": {
    "skills": string[],
    "education": string[],
    "experience": string[],
    "projects": string[],
    "certificates": string[]
  },
  "jd": {
    "skills": string[],
    "certifications": string[],
    "keywords": string[]
  }
}
Resume rules:
- skills: technical tools, languages, frameworks — lowercase, deduplicated
- Other arrays: one short summary string per item found in that section
- Empty array if section is absent. Never invent information.
JD rules:
- skills: required technical tools, languages, frameworks — lowercase, deduplicated
- certifications: named credentials only (e.g. "aws-saa", "az-204") — keep OUT of skills
- keywords: concrete methodologies a candidate could add (e.g. "agile", "ci/cd", "data migration")
- EXCLUDE from keywords: culture copy, benefits, DEI statements, work-hour / location policy
- Max 20 items per JD array`;

async function extractBothData(resumeText, jdText) {
    // No silent fallback — if the LLM fails, the routes catch and return a
    // structured error with the exact reason so the user knows what to fix.
    if (OPENROUTER_API_KEYS.length === 0)
        throw new LlmError("no_api_key", "No OpenRouter API key configured. Add OPENROUTER_API_KEY to your .env file.");

    const { parsed, modelUsed } = await callOpenRouterJSON(
        EXTRACTION_PROMPT,
        `RESUME:\n${resumeText.slice(0, 4000)}\n\n---\n\nJOB DESCRIPTION:\n${jdText.slice(0, 3000)}`
    );

    if (!parsed.resume || !parsed.jd)
        throw new LlmError("extraction_failed", "Model returned an unexpected response structure. Try again — this is usually transient.");

    const clean = (arr) => (arr || []).map((s) => String(s).toLowerCase().trim());
    return {
        resumeData: {
            skills: clean(parsed.resume.skills),
            education: parsed.resume.education || [],
            experience: parsed.resume.experience || [],
            projects: parsed.resume.projects || [],
            certificates: parsed.resume.certificates || [],
            model: modelUsed,
        },
        jdData: {
            skills: clean(parsed.jd.skills),
            keywords: clean(parsed.jd.keywords),
            certifications: clean(parsed.jd.certifications),
            model: modelUsed,
        },
    };
}

// ─── Scoring ───────────────────────────────────────────────────────────────────
// Two-tier skill matching:
//   Tier 1 — exact match in the extracted skill list (technical terms)
//   Tier 2 — substring match in raw resume text (catches soft terms like
//             "problem solving" that appear in bullet points but not skill lists)
function computeScore({ resumeSkills, jdSkills, jdKeywords, resumeText, semanticSimilarity }) {
    const skillSet = new Set(resumeSkills.map((s) => s.toLowerCase()));
    const textLower = resumeText.toLowerCase();

    const matchedSkills = jdSkills.filter((s) => skillSet.has(s) || textLower.includes(s));
    const missingSkills = jdSkills.filter((s) => !skillSet.has(s) && !textLower.includes(s));
    const missingKeywords = jdKeywords.filter((k) => !textLower.includes(k));

    const skillPct = jdSkills.length ? matchedSkills.length / jdSkills.length : 1;
    const keywordPct = jdKeywords.length ? (jdKeywords.length - missingKeywords.length) / jdKeywords.length : 1;

    const sim = semanticSimilarity ?? (skillPct + keywordPct) / 2;

    const score = Math.round(100 * (0.50 * sim + 0.35 * skillPct + 0.15 * keywordPct));

    return {
        ats_score: Math.max(0, Math.min(100, score)),
        match_percent: Math.round(sim * 100),
        similarity_method: semanticSimilarity != null ? "embeddings" : "overlap-fallback",
        resume_skills: resumeSkills,
        jd_skills: jdSkills,
        matched_skills: matchedSkills,
        missing_skills: missingSkills,
        missing_keywords: missingKeywords,
    };
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", jobs_loaded: JOBS.length, active_models: ACTIVE_MODELS });
});

// Returns each role bucket with a live job count.
// Frontend uses this to hide empty categories.
app.get("/api/job-categories", (_req, res) => {
    const categories = ROLE_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label,
        count: JOBS.filter((j) => jobMatchesCategory(j, c.id)).length,
    }));
    res.json({ categories });
});

// GET /api/jobs?category=backend&search=python&limit=20
app.get("/api/jobs", (req, res) => {
    const { search = "", category = "", limit = 20 } = req.query;
    const q = String(search).toLowerCase();

    let results = JOBS;
    if (category) results = results.filter((j) => jobMatchesCategory(j, category));
    if (q) results = results.filter((j) =>
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        j.location.toLowerCase().includes(q)
    );

    res.json({
        jobs: results.slice(0, Number(limit)).map(({ id, title, company, location }) => ({ id, title, company, location })),
        total_matched: results.length,
    });
});

// POST /api/analyze — single JD match (job_id from CSV or pasted jd_text)
app.post("/api/analyze", upload.single("resume"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Missing resume file." });

        const { job_id, jd_text } = req.body;
        let jdText = "", jobMeta = null;

        if (job_id) {
            const job = JOBS.find((j) => j.id === job_id);
            if (!job) return res.status(404).json({ error: `Job '${job_id}' not found.` });
            jdText = job.description || `${job.title} ${job.skills}`;
            jobMeta = { id: job.id, title: job.title, company: job.company, location: job.location };
        } else if (jd_text?.trim().length >= 30) {
            jdText = jd_text.trim();
        } else {
            return res.status(400).json({ error: "Provide job_id or jd_text (30+ chars)." });
        }

        const resumeText = (await pdfParse(req.file.buffer)).text || "";
        if (resumeText.trim().length < 50)
            return res.status(422).json({ error: "Couldn't extract text — is this a scanned PDF?" });

        // LLM extraction and embedding similarity are independent; run in parallel.
        const [{ resumeData, jdData }, semanticSimilarity] = await Promise.all([
            extractBothData(resumeText, jdText),
            computeSemanticSimilarity(resumeText, jdText),
        ]);

        const scoring = computeScore({ resumeSkills: resumeData.skills, jdSkills: jdData.skills, jdKeywords: jdData.keywords || [], resumeText, semanticSimilarity });
        const textLow = resumeText.toLowerCase();
        const missingCerts = (jdData.certifications || []).filter((c) => !textLow.includes(c));

        res.json({
            job: jobMeta,
            resume_char_count: resumeText.length,
            extraction: { method: resumeData.method, model: resumeData.model || null },
            required_certifications: jdData.certifications || [],
            missing_certifications: missingCerts,
            resume_details: resumeData.method === "llm" ? {
                education: resumeData.education, experience: resumeData.experience,
                projects: resumeData.projects, certificates: resumeData.certificates,
            } : undefined,
            ...scoring,
        });
    } catch (err) {
        console.error("[analyze]", err.message);
        if (err instanceof LlmError) {
            return res.status(503).json({ error: err.detail, reason: err.reason });
        }
        res.status(500).json({ error: err.message || "Internal server error." });
    }
});

// POST /api/analyze-category — match resume against a role category
// Samples up to `sample_size` JDs from the category spread across different
// companies, scores each with local embeddings + dictionary (1 LLM call total),
// and returns averaged scores + skills missing across the market for that role.
app.post("/api/analyze-category", upload.single("resume"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Missing resume file." });

        const category = req.body.category;
        const sampleSize = Math.min(10, Math.max(1, parseInt(req.body.sample_size) || 5));
        if (!category) return res.status(400).json({ error: "Provide a category." });

        const pool = JOBS.filter((j) => jobMatchesCategory(j, category));
        if (pool.length === 0) return res.status(404).json({ error: `No jobs for category '${category}'.` });

        // Spread samples across the pool so we don't pick 5 jobs from the same company.
        const sorted = [...pool].sort((a, b) => a.company.localeCompare(b.company));
        const step = Math.max(1, Math.floor(sorted.length / sampleSize));
        const sampled = Array.from({ length: sampleSize }, (_, i) => sorted[Math.min(i * step, sorted.length - 1)]);

        const resumeText = (await pdfParse(req.file.buffer)).text || "";
        if (resumeText.trim().length < 50)
            return res.status(422).json({ error: "Couldn't extract text — is this a scanned PDF?" });

        // One LLM call to extract resume skills (using first JD as context).
        const firstJd = sampled[0].description || sampled[0].title;
        const [{ resumeData }, resumeVec] = await Promise.all([
            extractBothData(resumeText, firstJd).then(({ resumeData }) => ({ resumeData })),
            embedText(resumeText).catch(() => null),
        ]);

        // Score against each sampled JD — embeddings only, no further LLM calls.
        const jobResults = await Promise.all(sampled.map(async (job) => {
            const jdText = job.description || `${job.title} ${job.skills}`;
            const jdSkills = jdExtractSkills(jdText);
            const jdKeywords = jdExtractKeywords(jdText, 20);

            let sim = null;
            if (resumeVec) {
                try { sim = rescaleSim(cosineSimilarity(resumeVec, await embedText(jdText))); }
                catch (_) { }
            }

            const s = computeScore({ resumeSkills: resumeData.skills, jdSkills, jdKeywords, resumeText, semanticSimilarity: sim });
            return {
                job_id: job.id, title: job.title, company: job.company, location: job.location,
                ats_score: s.ats_score, match_percent: s.match_percent,
                matched_skills: s.matched_skills, missing_skills: s.missing_skills, missing_keywords: s.missing_keywords,
            };
        }));

        const avg = (key) => Math.round(jobResults.reduce((s, r) => s + r[key], 0) / jobResults.length);

        // Skills / keywords missing in ≥40% of sampled JDs are "market gaps" for this role.
        const freq = (key) => {
            const f = {};
            for (const r of jobResults) for (const v of r[key]) f[v] = (f[v] || 0) + 1;
            const threshold = Math.ceil(jobResults.length * 0.4);
            return Object.entries(f).filter(([, c]) => c >= threshold).sort((a, b) => b[1] - a[1]).map(([v]) => v);
        };

        const catInfo = ROLE_CATEGORIES.find((c) => c.id === category);
        res.json({
            category,
            category_label: catInfo?.label || category,
            total_jobs_in_category: pool.length,
            jobs_sampled: jobResults.length,
            extraction_method: resumeData.method,
            resume_skills: resumeData.skills,
            avg_ats_score: avg("ats_score"),
            avg_match_percent: avg("match_percent"),
            common_missing_skills: freq("missing_skills"),
            common_missing_keywords: freq("missing_keywords"),
            per_job_breakdown: jobResults,
        });
    } catch (err) {
        console.error("[analyze-category]", err.message);
        if (err instanceof LlmError) {
            return res.status(503).json({ error: err.detail, reason: err.reason });
        }
        res.status(500).json({ error: err.message || "Internal server error." });
    }
});

// Multer file-type / size errors
app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError || err.message === "Only PDF files are accepted")
        return res.status(400).json({ error: err.message });
    next(err);
});

app.listen(PORT, () => console.log(`[server] Running on http://localhost:${PORT}`));