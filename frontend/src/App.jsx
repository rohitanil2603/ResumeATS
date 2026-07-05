import { useState, useRef, useCallback, useEffect } from "react";

const API = "http://localhost:8000";

// ─── tiny hooks ───────────────────────────────────────────────────────────────
function useCategories() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/job-categories`)
      .then((r) => r.json())
      .then((d) => setCategories((d.categories || []).filter((c) => c.count > 0)))
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  return { categories, loading };
}

// ─── sub-components ───────────────────────────────────────────────────────────

function UploadZone({ file, onFile }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const accept = useCallback((f) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return;
    if (f.size > 10 * 1024 * 1024) return;
    onFile(f);
  }, [onFile]);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); accept(e.dataTransfer.files?.[0]); }}
      style={{
        display: "flex", alignItems: "center", gap: 16,
        border: `1.5px dashed ${dragging ? "#6366f1" : file ? "#374151" : "#2d3139"}`,
        borderRadius: 10, padding: "20px 18px", cursor: "pointer",
        background: dragging ? "rgba(99,102,241,0.05)" : "#111318",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <input ref={inputRef} type="file" accept=".pdf,application/pdf"
        style={{ display: "none" }} onChange={(e) => accept(e.target.files?.[0])} />

      <div style={{
        width: 38, height: 38, borderRadius: 8, flexShrink: 0,
        background: file ? "rgba(99,102,241,0.15)" : "#1c1f26",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: file ? 11 : 17,
        color: file ? "#818cf8" : "#6b7280",
        fontFamily: "monospace", fontWeight: 600,
      }}>
        {file ? "PDF" : "↑"}
      </div>

      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: file ? "#e5e7eb" : "#9ca3af", marginBottom: 2, wordBreak: "break-all" }}>
          {file ? file.name : "Drop your resume here"}
        </div>
        <div style={{ fontSize: 12.5, color: "#4b5563" }}>
          {file ? `${(file.size / 1024).toFixed(0)} KB · click to replace` : "PDF only · max 10 MB"}
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ score, size = 96 }) {
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(score, 0), 100) / 100;
  const color = score >= 75 ? "#34d399" : score >= 50 ? "#fbbf24" : "#f87171";

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1f2937" strokeWidth="9" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="9"
          strokeLinecap="round" strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontFamily: "monospace", fontSize: size * 0.23, fontWeight: 700, color, lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: 10, color: "#4b5563", marginTop: 1 }}>/ 100</span>
      </div>
    </div>
  );
}

function Pills({ items, variant = "neutral" }) {
  if (!items?.length) return <span style={{ fontSize: 13, color: "#374151" }}>None</span>;

  const bg = {
    matched: "rgba(52,211,153,0.12)",
    missing: "rgba(248,113,113,0.12)",
    neutral: "#1a1d24",
  };
  const fg = { matched: "#6ee7b7", missing: "#fca5a5", neutral: "#9ca3af" };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {items.map((item) => (
        <span key={item} style={{
          fontSize: 12.5, padding: "4px 10px", borderRadius: 20,
          background: bg[variant], color: fg[variant],
        }}>
          {item}
        </span>
      ))}
    </div>
  );
}

function Section({ label, count, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, color: "#4b5563", fontFamily: "monospace", letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {label}
        </span>
        {count != null && (
          <span style={{ fontSize: 11, background: "#1c1f26", color: "#6b7280", padding: "1px 7px", borderRadius: 10 }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ResultsPanel({ result, mode }) {
  const isCat = mode === "category";

  const score = isCat ? result.avg_ats_score : result.ats_score;
  const matchPct = isCat ? result.avg_match_percent : result.match_percent;
  const missing = isCat ? result.common_missing_skills : result.missing_skills;
  const keywords = isCat ? result.common_missing_keywords : result.missing_keywords;
  const matched = result.matched_skills || [];

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid #1c1f26", paddingTop: 24 }}>
      {/* Score header */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 28 }}>
        <ScoreRing score={score} />
        <div>
          <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {isCat ? "Average ATS score" : "ATS score"}
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", letterSpacing: "-0.01em" }}>
            {matchPct}% match
          </div>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 3 }}>
            {isCat
              ? `across ${result.jobs_sampled} ${result.category_label} postings`
              : result.job
                ? `${result.job.title} · ${result.job.company}`
                : "against the pasted job description"}
          </div>
        </div>
      </div>

      {/* Skill sections */}
      {!isCat && matched.length > 0 && (
        <Section label="Matched skills" count={matched.length}>
          <Pills items={matched} variant="matched" />
        </Section>
      )}

      <Section label={isCat ? "Skills missing across market" : "Missing skills"} count={missing.length}>
        <Pills items={missing} variant="missing" />
      </Section>

      <Section label="Missing keywords" count={keywords.length}>
        <Pills items={keywords} variant="neutral" />
      </Section>

      {result.missing_certifications?.length > 0 && (
        <Section label="Missing certifications" count={result.missing_certifications.length}>
          <Pills items={result.missing_certifications} variant="missing" />
        </Section>
      )}

      {/* Category breakdown table */}
      {isCat && result.per_job_breakdown?.length > 0 && (
        <Section label="Per-job breakdown">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {result.per_job_breakdown.map((j) => (
              <div key={j.job_id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                background: "#111318", borderRadius: 8, padding: "10px 14px",
              }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "#e5e7eb" }}>{j.title}</div>
                  <div style={{ fontSize: 12, color: "#4b5563", marginTop: 2 }}>{j.company}</div>
                </div>
                <div style={{
                  fontFamily: "monospace", fontSize: 14, fontWeight: 700,
                  color: j.ats_score >= 75 ? "#34d399" : j.ats_score >= 50 ? "#fbbf24" : "#f87171",
                }}>
                  {j.ats_score}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Resume detail (LLM extraction only) */}
      {result.resume_details && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12.5, color: "#4b5563", cursor: "pointer", fontFamily: "monospace" }}>
            Parsed resume details
          </summary>
          {[["Education", result.resume_details.education], ["Experience", result.resume_details.experience], ["Projects", result.resume_details.projects]].map(([label, items]) =>
            items?.length ? (
              <div key={label} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11.5, color: "#374151", fontFamily: "monospace", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
                {items.map((item, i) => (
                  <div key={i} style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.55, marginBottom: 4, paddingLeft: 12, borderLeft: "2px solid #1f2937" }}>{item}</div>
                ))}
              </div>
            ) : null
          )}
        </details>
      )}

      <div style={{ marginTop: 20, fontSize: 11.5, color: "#374151", fontFamily: "monospace" }}>
        extraction: {result.extraction?.method || result.extraction_method || "—"} ·{" "}
        similarity: {result.similarity_method || result.semantic_similarity_method || "—"}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function App() {
  const { categories, loading: catsLoading } = useCategories();

  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("category"); // "category" | "custom"
  const [category, setCategory] = useState("");
  const [jdText, setJdText] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null); // { message, reason } | null
  const [result, setResult] = useState(null);
  const [resultMode, setResultMode] = useState("category");

  // Auto-select first available category
  useEffect(() => {
    if (!category && categories.length) setCategory(categories[0].id);
  }, [categories, category]);

  const submit = async () => {
    if (!file) return setError({ message: "Upload a resume first." });
    if (mode === "category" && !category) return setError({ message: "Select a role category." });
    if (mode === "custom" && jdText.trim().length < 30) return setError({ message: "Paste a fuller job description." });

    setError(null);
    setResult(null);
    setStatus("loading");

    const form = new FormData();
    form.append("resume", file);

    try {
      let url;
      if (mode === "category") {
        url = `${API}/api/analyze-category`;
        form.append("category", category);
        form.append("sample_size", "5");
      } else {
        url = `${API}/api/analyze`;
        form.append("jd_text", jdText);
      }

      const res = await fetch(url, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw { message: data.error, reason: data.reason };

      setResult(data);
      setResultMode(mode);
      setStatus("done");
    } catch (err) {
      const msg = err.message?.includes("fetch")
        ? "Cannot reach backend — is it running on port 8000?"
        : err.message || "Something went wrong.";
      setError({ message: msg, reason: err.reason });
      setStatus("error");
    }
  };

  const busy = status === "loading";

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0b0e", color: "#e5e7eb",
      fontFamily: "-apple-system, 'Inter', sans-serif",
      display: "flex", justifyContent: "center", padding: "48px 20px 80px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::selection { background: #6366f1; color: #fff; }
        select, textarea { outline: none; }
        details > summary { list-style: none; }
        details > summary::-webkit-details-marker { display: none; }
      `}</style>

      <div style={{ width: "100%", maxWidth: 560 }}>

        {/* Header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1" }} />
            <span style={{ fontSize: 11, color: "#4b5563", fontFamily: "monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Resume · ATS Analyzer
            </span>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.2, color: "#f9fafb", marginBottom: 10 }}>
            How does your resume<br />stack up?
          </h1>
          <p style={{ fontSize: 14.5, color: "#6b7280", lineHeight: 1.6 }}>
            Upload your resume and match it against a job category from real postings, or paste a custom JD.
          </p>
        </div>

        {/* Card */}
        <div style={{ background: "#0f1015", border: "1px solid #1c1f26", borderRadius: 14, padding: 24 }}>

          {/* Step 1 */}
          <div style={{ marginBottom: 24 }}>
            <Label>Resume</Label>
            <UploadZone file={file} onFile={(f) => { setFile(f); setResult(null); setStatus("idle"); }} />
          </div>

          {/* Step 2 */}
          <div style={{ marginBottom: 24 }}>
            <Label>Match against</Label>

            {/* Mode toggle */}
            <div style={{ display: "flex", gap: 0, background: "#111318", borderRadius: 8, padding: 3, marginBottom: 14 }}>
              {[["category", "Job category"], ["custom", "Custom JD"]].map(([val, lbl]) => (
                <button key={val} onClick={() => { setMode(val); setResult(null); }}
                  style={{
                    flex: 1, padding: "7px 0", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: 500, transition: "all 0.15s",
                    background: mode === val ? "#1c1f26" : "transparent",
                    color: mode === val ? "#e5e7eb" : "#4b5563",
                  }}>
                  {lbl}
                </button>
              ))}
            </div>

            {mode === "category" ? (
              catsLoading ? (
                <div style={{ fontSize: 13, color: "#374151", padding: "10px 0" }}>Loading categories…</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {categories.map((c) => (
                    <button key={c.id} onClick={() => setCategory(c.id)} style={{
                      padding: "7px 14px", borderRadius: 20, border: "1px solid",
                      fontSize: 13, cursor: "pointer", transition: "all 0.15s",
                      borderColor: category === c.id ? "#6366f1" : "#1c1f26",
                      background: category === c.id ? "rgba(99,102,241,0.12)" : "#111318",
                      color: category === c.id ? "#818cf8" : "#6b7280",
                    }}>
                      {c.label}
                      <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>{c.count}</span>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <textarea
                value={jdText} onChange={(e) => setJdText(e.target.value)}
                placeholder="Paste the full job description here…"
                rows={7}
                style={{
                  width: "100%", background: "#111318", border: "1px solid #1c1f26",
                  borderRadius: 8, padding: "12px 14px", color: "#e5e7eb",
                  fontSize: 13.5, lineHeight: 1.6, resize: "vertical", fontFamily: "inherit",
                }}
              />
            )}
          </div>

          {error && (
            <div style={{
              marginBottom: 16, padding: "12px 14px", borderRadius: 8,
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
            }}>
              <div style={{ fontSize: 13, color: "#fca5a5", fontWeight: 500, marginBottom: error.reason ? 6 : 0 }}>
                {error.reason === "rate_limited" && "⚡ Daily limit reached"}
                {error.reason === "no_api_key" && " No API key configured"}
                {error.reason === "auth_error" && " Invalid API key"}
                {error.reason === "models_unavailable" && " No models available"}
                {error.reason === "extraction_failed" && " Extraction failed"}
                {!error.reason && "Error"}
              </div>
              <div style={{ fontSize: 13, color: "#f87171", lineHeight: 1.55 }}>
                {error.message}
              </div>

            </div>
          )}

          <button onClick={submit} disabled={busy} style={{
            width: "100%", padding: "12px 0", borderRadius: 8, border: "none",
            background: busy ? "#1c1f26" : "#6366f1", color: busy ? "#4b5563" : "#fff",
            fontSize: 14.5, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
            transition: "background 0.15s",
          }}>
            {busy ? "Analyzing…" : "Analyze resume →"}
          </button>

          {result && <ResultsPanel result={result} mode={resultMode} />}
        </div>

        <div style={{ marginTop: 28, fontSize: 12, color: "#1f2937", textAlign: "center", lineHeight: 1.7 }}>
          Resume text stays local. Only metadata is sent to OpenRouter for extraction.
        </div>
      </div>
    </div>
  );
}

function Label({ children }) {
  return (
    <div style={{
      fontSize: 11.5, color: "#4b5563", fontFamily: "monospace",
      textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10,
    }}>
      {children}
    </div>
  );
}