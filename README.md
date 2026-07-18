# SAT Agent Prep

An AI-powered SAT question generation pipeline. A multi-agent system drafts, validates, and stages original SAT questions using RAG-augmented Claude generation, Gemini validation/embeddings, Qdrant vector search, and MongoDB storage.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Tailwind CSS v4, Vite 6, Lucide React, Motion |
| **Backend** | Node.js, Express 4, TSX (runtime TypeScript) |
| **AI Generation** | Anthropic Claude API (`@anthropic-ai/sdk`) — model: `claude-sonnet-4-6` |
| **AI Validation** | Google Gemini API (`@google/genai` v2) — independent scoring/rubric pass |
| **Embeddings** | Google Gemini Embedding API (`gemini-embedding-2-preview`, 768 dimensions) |
| **Vector DB** | Qdrant Cloud — stores embedded question bank for semantic RAG retrieval |
| **Database** | MongoDB Atlas — stores generated questions, audit logs, pipeline runs, RAG tracking |
| **Auth** | Firebase Authentication (Google sign-in) |
| **Math Validation** | mathjs — deterministic equation verification without AI |
| **PDF (scripts)** | pdfkit, pdf-parse, pdfjs-dist — reference scripts only, not part of main pipeline |

> **Note on the model split:** the **generator** runs on Claude; the **validator and all embeddings** (RAG indexing, RAG retrieval, and the post-generation similarity check) stay on Gemini. Anthropic has no embeddings endpoint, so vector search cannot move to Claude — only the generation step can.

---

## Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/) — used by the question generator (`claude-sonnet-4-6`)
- A [Gemini API key](https://aistudio.google.com/) — used by the validator and all embeddings
- A [Qdrant Cloud](https://cloud.qdrant.io/) cluster (free tier)
- A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster (free tier)
- A Firebase project with Authentication enabled

---

## Quick Start

```bash
npm install
# fill in .env.local (see Environment Variables below)
npm run dev
```

App runs at `http://localhost:3000` (`PORT=3002` in production deploys — see deployment guide).

---

## Environment Variables

Create `.env.local` in the project root:

```env
# ─────────────────────────────────────────────────────────────
# SAT-PREP-APP environment variables
#
# Copy this file to .env.local (the app loads .env.local, NOT .env).
# .env.local is git-ignored — NEVER commit real keys.
# ─────────────────────────────────────────────────────────────

# AI providers
ANTHROPIC_API_KEY="MY_ANTHROPIC_API_KEY"          # Claude (claude-sonnet-4-6) — question generator
GEMINI_API_KEY="MY_GEMINI_API_KEY"                # Gemini — embeddings / RAG

# Optional: separate key for the validator (falls back to GEMINI_API_KEY if unset)
VALIDATOR_GEMINI_API_KEY="MY_VALIDATOR_GEMINI_API_KEY"

# Vector DB for RAG
QDRANT_URL="https://your-cluster.qdrant.io"
QDRANT_API_KEY="MY_QDRANT_API_KEY"
QDRANT_COLLECTION="sat_question_bank"

# Database (required)
MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/satprep"

# ─────────────────────────────────────────────────────────────
# LOCAL DEVELOPMENT (interns): you only need MONGODB_URI.
# Leave ANTHROPIC_API_KEY / GEMINI_API_KEY / QDRANT_* unset to run in
# SIMULATED MODE — canned questions/validations, no paid API calls.
# ─────────────────────────────────────────────────────────────
```

Firebase client variables (`VITE_FIREBASE_*`) are also required for auth — see `.env.example` for the full list.

---

## How the Pipeline Works

```
User selects: exam / section / domain / skill / difficulty
        │
        ▼
1. RAG Retrieval
   Embeds the topic query (Gemini) → searches Qdrant for 3 semantically similar
   real SAT questions → rotates picks via MongoDB so the same 3 are never
   repeated back-to-back; resets once all relevant questions are exhausted
        │
        ▼
2. Generator Agent  (generatorAgent.ts)
   Sends the 3 exemplars + topic specs to Claude (claude-sonnet-4-6) → returns
   a new original question in JSON: question text, 4 choices, explanation,
   distractor_rationale, difficulty, domain, skill. Domain/skill/difficulty are
   always pinned to the requested values — never overwritten by the model's
   own echoed labels — so downstream alignment checks stay meaningful.
        │
        ▼
3. Pre-Validation Filters  (pipeline.ts)
   Schema check: question text present, ≥ 2 answer choices
   Math sanity check (mathSanityCheck.ts): substitutes the claimed answer back
     into the equation using mathjs — deterministic, no AI involved
   Similarity check: embeds the new question (Gemini) and cosine-compares it
     against all previously GENERATED questions in MongoDB (not the full JSON
     bank) — flags if similarity > 0.85
        │
        ▼
4. Validator Agent  (validatorAgent.ts)
   Independent Gemini call scores the question on 7 rubric checks:
   correctness · distractor quality · clarity · difficulty alignment ·
   domain/skill alignment · originality · bias sensitivity
   Returns PASS / FAIL + actionable feedback score
        │
        ▼
5. Loop / Escalation
   PASS → saved to MongoDB + appended to passed_questions.json (staging format)
   FAIL → feedback fed back to Generator for retry (up to max_attempts)
   Exceeded max attempts → escalated to human review queue in the UI
```

### Batch Generation

Batch mode ("Generate All Combinations") builds the full cross-product of every section × domain × skill × difficulty in the exam's config, then runs each combination through **the exact same pipeline above** — same RAG rotation, same pre-validation filters, same Validator Agent, same retry/escalation logic. It is a sequential orchestration wrapper, not a separate generation path.

Batch results distinguish three outcomes per item, tracked separately (not lumped into one "success" count):
- **Approved** — validator passed
- **Escalated** — exhausted `max_attempts`, needs human review
- **Failed** — hard error during generation

**Batch scope** can be either:
- **All Combinations** — the full cross-product of every section × domain × skill × difficulty in the exam config (original behavior).
- **Custom Selection** — a multi-select subset. You can pick 1+ sections, 1+ domains (unioned across every selected section), 1+ skills (unioned across every selected domain), and 1+ difficulties; the batch then runs the cross-product of just that subset. All four fields are required in custom scope — there is no partial/implicit "rest = all" fallback.

---

## Project Structure

```
├── server.ts                              Express server + all API routes
├── src/
│   ├── App.tsx                            React frontend (single-page UI)
│   ├── main.tsx                           Vite entry point
│   ├── types.ts                           Shared TypeScript types (Question, ValidationBlock, BatchRun, etc.)
│   ├── lib/
│   │   └── firebase.ts                    Firebase client auth setup
│   └── server/
│       ├── mongoClient.ts                 MongoDB singleton — one connection shared across server
│       ├── db.ts                          Database class — all CRUD (questions, logs, runs, batch runs, reset)
│       ├── seedData.ts                    20 default SAT seed questions (loaded on first run)
│       ├── pipeline.ts                    Orchestration loop: RAG → generate → validate → save; batch wrapper
│       ├── formatter.ts                   Converts internal Question → staging export format
│       ├── mathSanityCheck.ts             Deterministic math verifier using mathjs (no AI)
│       └── agents/
│           ├── generatorAgent.ts          Builds prompts and calls Claude to generate questions
│           └── validatorAgent.ts          Calls Gemini to independently score generated questions
│       └── rag/
│           ├── ragSystem.ts               RAG entry point: retrieval + MongoDB round-robin tracking
│           ├── embeddings.ts              Wraps Gemini embedding API with retry logic
│           ├── qdrantClient.ts            Qdrant client with excludeIds filter for rotation
│           └── jsonLoader.ts              Parses SAT_QB_MATH.json / SAT_QB_ENG.json for indexing
├── configs/
│   ├── sat.json                           SAT exam structure (sections, domains, skills, difficulty)
│   └── gre.json                           GRE structure (same pipeline, different config)
└── data/
    └── question-banks/json/
        ├── SAT_QB_MATH.json               Real SAT Math questions — RAG source only, never shown to users
        ├── SAT_QB_ENG.json                Real SAT English questions — RAG source only, never shown to users
        ├── questions/                     Question image assets (PNG) referenced by the JSON banks
        └── options/                       Answer choice image assets (PNG) referenced by the JSON banks
```

---

## JSON & Data Files Explained

### `configs/sat.json` and `configs/gre.json`
Define exam structure: sections → domains → skills → difficulty levels. Served live to the frontend via `GET /api/configs/:exam`. The generator uses the selected values to construct prompts. Adding a new exam requires only a new config file here — no code changes.

### `data/question-banks/json/SAT_QB_MATH.json` and `SAT_QB_ENG.json`
Large banks of real SAT questions (~8,000 questions total across both files). **These are never shown to users and never used for similarity checking.** Their only role is RAG: at startup they are embedded via the Gemini Embedding API and stored as vectors in Qdrant. After the first run, the files are not read again unless re-indexing is triggered.

### `data/question-banks/json/questions/` and `options/`
PNG image assets for question diagrams and answer choice graphs referenced by the JSON banks. Served statically for questions that contain visual content.

### `rag_indexing_status.json` *(auto-generated, not committed)*
Tracks which batches of questions have been embedded into Qdrant. Lives only on the machine running the server — not shared across users. Delete it to force a full re-embed.

```json
{
  "mathBatchesDone": [1, 2, 3, 4],
  "englishBatchesDone": [1, 2, 3, 4]
}
```

### `generated_questions.json` *(auto-generated on reset)*
Snapshot of all AI-generated approved questions exported in staging format before a DB reset. Preserved so no work is lost across resets.

---

## MongoDB Collections

| Collection | Contents |
|---|---|
| `questions` | All questions (seeds + generated). Full `Question` object with validation scores, metadata, status (`approved` / `escalated` / `rejected`). |
| `audit_logs` | Validation record per generation attempt — scores, rubric checks, feedback, timestamp. |
| `pipeline_runs` | Live pipeline state for the UI tracker — steps, logs, current attempt, final question. |
| `batch_runs` | Batch generation run state — per-item status, approved/escalated/failed counts, progress. |
| `rag_tracking` | Round-robin usage log per condition key (e.g. `Math\|Algebra\|Linear equations\|Hard`). Tracks which Qdrant IDs have been used as RAG exemplars. Cleared on DB reset. |

---

## Similarity Check — What It Actually Compares

The "checking similarity with question bank" step in the live pipeline compares the newly generated question **only against previously generated questions stored in MongoDB** — not against the 8,000-question JSON banks. It embeds the new question text and passage (Gemini), then cosine-compares it against every question in the `questions` collection. If similarity > 0.85 with any existing question it is flagged (generation still continues, but the flag is logged). This prevents the AI from re-producing near-duplicate questions over time.

---

## Resetting the Database

Use the Reset button in the UI. It will:
1. Export all generated approved questions to `generated_questions.json`
2. Reset `passed_questions.json` to seed questions only
3. Wipe all MongoDB collections (`questions`, `audit_logs`, `pipeline_runs`, `batch_runs`)
4. Re-seed the `questions` collection with the 20 default seeds
5. Clear `rag_tracking` so exemplar rotation starts fresh

To force re-embedding into Qdrant after updating the question banks:

```bash
# Windows PowerShell
'{"mathIndexed":false,"englishIndexed":false,"mathIndexed2":false,"englishIndexed2":false}' | Out-File rag_indexing_status.json -Encoding utf8

# Mac/Linux
echo '{"mathIndexed":false,"englishIndexed":false,"mathIndexed2":false,"englishIndexed2":false}' > rag_indexing_status.json
```

---

## Adding More Questions to the RAG Bank

Questions are embedded in batches of 100 via `indexMathQuestionsBatch(jsonFilePath, batchNumber)` / `indexEnglishQuestionsBatch(jsonFilePath, batchNumber)` in `ragSystem.ts`. To add questions 201–300:

1. Call `indexMathQuestionsBatch(mathJsonPath, 3)` (and the English equivalent) — batch 3 covers questions 201–300 automatically (`(batchNumber - 1) * 100` → `batchNumber * 100`).
2. Bump `totalBatches` in `initializeRAGWithJSONFiles` if you want it to run automatically on startup.
3. Already-indexed batches are tracked in `rag_indexing_status.json` and skipped automatically — safe to re-run.

No other changes needed.

---

## API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/questions` | List all questions (filterable by `exam_type`, `section`, `domain`, `status`) |
| `POST` | `/api/questions/generate` | Trigger the full generation pipeline (single question) |
| `POST` | `/api/questions/generate-batch` | Trigger batch generation. Body: `exam_type` (required), optional `sections`/`domains`/`skills`/`difficulties` string arrays to filter to a subset instead of the full cross-product |
| `GET` | `/api/batch-runs` | List batch runs (filterable by `exam_type`, `status`) |
| `GET` | `/api/batch-runs/:id` | Poll a specific batch run's progress |
| `POST` | `/api/questions/review` | Approve / reject / edit a question |
| `GET` | `/api/questions/export` | Export in staging format (`?id=` for single, bulk otherwise) |
| `GET` | `/api/audit-logs` | All validation audit logs |
| `GET` | `/api/pipeline-runs` | Live pipeline run states |
| `GET` | `/api/configs/:exam` | Exam config (sat / gre) |
| `POST` | `/api/reset` | Export → wipe → re-seed → clear RAG tracking |