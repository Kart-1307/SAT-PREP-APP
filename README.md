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
| **Observability** | Langfuse — LLM application tracing, cost tracking, and optimization analytics |
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
- Optional: A [Langfuse](https://langfuse.com/) account for tracing and analytics

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

# Analytics / Observability
LANGFUSE_SECRET_KEY="MY_LANGFUSE_SECRET_KEY"
LANGFUSE_PUBLIC_KEY="MY_LANGFUSE_PUBLIC_KEY"
LANGFUSE_BASE_URL="https://cloud.langfuse.com"

# ─────────────────────────────────────────────────────────────
# LOCAL DEVELOPMENT (interns): you only need MONGODB_URI.
# Leave ANTHROPIC_API_KEY / GEMINI_API_KEY / QDRANT_* unset to run in
# SIMULATED MODE — canned questions/validations, no paid API calls.
# ─────────────────────────────────────────────────────────────
```

Firebase client variables (`VITE_FIREBASE_*`) are also required for auth — see `.env.example` for the full list.

---

## Startup Connection Pool Warming

To ensure that the app starts up responsively:
1. **MongoDB Connection Warming**: The MongoDB client establishes its connection pool synchronously at boot (`server.ts` startup), preventing early request timeouts or lag during the initial API calls.
2. **Qdrant Collection Status Check**: The system validates that the Math and Reading collections exist in Qdrant and reports the loaded question counts at boot.

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

### Pre-Validation: Deterministic Math Sanity Check

If the generator produces a question containing a structured verification block (`equation_lhs`, `equation_rhs`, `variable`, `variable_value` in metadata), the pipeline executes a pre-validation check using **mathjs** instead of an LLM. It substitutes the variable value back into the equation LHS and RHS and checks for mathematical equivalence. If they do not match, the question fails immediately. If no structured verification block is provided (e.g. word problems, geometry), the check is skipped and correctness is evaluated in the Validator Agent step.

---

## Batch Generation & Stop Logic

Batch mode ("Generate All Combinations") builds the full cross-product of every section × domain × skill × difficulty in the exam's config, then runs each combination through **the exact same pipeline above** — same RAG rotation, same pre-validation filters, same Validator Agent, same retry/escalation logic. It is a sequential orchestration wrapper, not a separate generation path.

Batch results distinguish three outcomes per item, tracked separately (not lumped into one "success" count):
- **Approved** — validator passed
- **Escalated** — exhausted `max_attempts`, needs human review
- **Failed** — hard error during generation

**Batch scope** can be either:
- **All Combinations** — the full cross-product of every section × domain × skill × difficulty in the exam config (original behavior).
- **Custom Selection** — a multi-select subset. You can pick 1+ sections, 1+ domains (unioned across every selected section), 1+ skills (unioned across every selected domain), and 1+ difficulties; the batch then runs the cross-product of just that subset. All four fields are required in custom scope — there is no partial/implicit "rest = all" fallback.

### In-Progress Stopping and Cancellation
When stopping a batch run via `/api/batch-runs/:batch_id/stop`:
1. The batch state is set to `stop_requested`, which prevents workers from starting new combinations.
2. The stop command is **propagated down** to any currently in-flight single-question pipelines, terminating active LLM loops gracefully within the current attempt instead of leaving workers processing items for up to 2 minutes.

---

## Regeneration & Human Review

The platform provides dedicated API endpoints and frontend controls to handle questions that fail automated scoring or require manual corrections.

### Single Question Regeneration
For questions marked as `rejected` in the system, administrators can trigger a regeneration via:
`POST /api/questions/:question_id/regenerate`
- This endpoint extracts all review notes (automated pipeline failure feedback, human reviewer comments, override justifications, checklist flags).
- It compiles them into an `initialFeedback` instruction (e.g., *"This question was previously rejected because... Generate a new question that addresses this feedback..."*).
- The pipeline runs attempt 1 seeded with this instruction instead of starting blind, allowing the generator to produce a compliant replacement.

### Batch Generation from CSV / Upload
If you have custom metadata lists of rejected questions from external sources, you can generate replacement batches via:
`POST /api/questions/generate-batch-from-upload`
- Takes an array of raw questions, categories, reviewer notes, and manual checklist comments.
- Maps their sections, domains, skills, and difficulties to the active exam config structure.
- Resolves all reviewer notes, checklists, and manual override comments into a detailed feedback prompt for each entry.
- Triggers a batch run queue that generates replacements for each uploaded item using the same RAG and validation pipeline.

---

## LLM Prompt Caching & Token Optimization

To make generation cost-effective and resilient under high load, the Generator Agent employs the following strategies:

### Anthropic Prompt Caching
The prompt structure is split into two components:
1. **Static Prompt** (Cached): Contains exam specifications, RAG exemplar context, and the JSON output schema/rules. This block is marked with a `cache_control` ephemeral breakpoint.
2. **Dynamic Trailer** (Uncached): Contains the specific instructions to generate exactly $N$ questions. 
By caching the static block, subsequent calls in the same batch or matching domains benefit from Anthropic's **90% discount on cache-read input tokens**, with only the dynamic suffix invalidating cache blocks.

### SDK-Level Timeout and Retry Optimization
In single/batch generation calls, the generator instructs the Anthropic SDK with `{ timeout: 45000, maxRetries: 0 }`. 
- Skipping internal SDK retries prevents slow or rate-limited requests from stack-multiplying internally (e.g. 3 attempts × 45s), which would blow past the batch item's 120s budget.
- This lets the outer orchestration pipeline handle backoffs and retry feedback loops explicitly and gracefully.

### Langfuse Tracing
All LLM generation and validation trace calls log detailed metadata to Langfuse. To ensure billing accuracy, token metrics are sent using Langfuse's exact `usageDetails` API, splitting tokens into:
- `input` (raw prompt tokens)
- `output` (generated tokens)
- `cache_creation_input_tokens` (costing +25% one-time write charge)
- `cache_read_input_tokens` (costing -90% read charge)

---

## Math Difficulty Calibration

Difficulty tags in SAT exams are strictly calibrated to avoid common generator errors:
- **"Hard" Math Calibration**: Hard questions must not use college-level curricula (e.g., calculus, obscure advanced trigonometry, multi-page algebraic derivations, ugly numbers). Rather, difficulty is introduced through multi-step reasoning, combining 2-3 standard topics (Algebra I/II, Geometry, basic stats/trig), or wordy, abstract framing.
- **Graph & Figure Questions**: Since the system does not use visual graphics in raw pipeline outputs, graph-based questions are textually simulated in the `stimulus` field (e.g., *"Line k passes through points (-2, 5) and (4, -1)..."*), allowing algebraic reconstruction.

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
│       ├── langfuse.ts                    Langfuse client manager (observability tracer)
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
| `POST` | `/api/batch-runs/:batch_id/stop` | Request to stop an in-progress batch generation. Propagates down to cancel active items. |
| `POST` | `/api/questions/review` | Approve / reject / edit a question |
| `POST` | `/api/questions/:question_id/regenerate` | Send a rejected question back for generation, seeded with feedback. |
| `POST` | `/api/questions/generate-batch-from-upload` | Trigger custom batch generation from uploaded questions requiring reviews. |
| `GET` | `/api/questions/export` | Export in staging format (`?id=` for single, bulk otherwise) |
| `GET` | `/api/audit-logs` | All validation audit logs |
| `GET` | `/api/pipeline-runs` | Live pipeline run states |
| `POST` | `/api/pipeline-runs/:question_id/stop` | Stop/cancel a single in-flight pipeline run attempt. |
| `GET` | `/api/configs/:exam` | Exam config (sat / gre) |
| `POST` | `/api/reset` | Export → wipe → re-seed → clear RAG tracking |
