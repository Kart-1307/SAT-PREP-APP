// ⚠️ dotenv MUST be the very first thing — before any other imports that read env vars
import dotenv from "dotenv";
dotenv.config({ path: '.env.local' });

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { Database } from "./src/server/db";
import { getDb } from "./src/server/mongoClient";
import { runOrchestrationPipeline, createBatchRun, processBatchRun, buildAllCombinations } from "./src/server/pipeline";
import { ensureCollections, getCollectionStats, MATH_COLLECTION_NAME, ENGLISH_COLLECTION_NAME } from './src/server/rag/qdrantClient';

// Connect (and build indexes) at boot instead of lazily on the first request —
// previously the first /api/questions or /api/configs call after `npm run dev`
// paid the full Atlas connection handshake, which is what made the question
// count look slow to load right after localhost started.
getDb()
  .then(() => console.log('[MongoDB] Connection warmed at startup.'))
  .catch(err => console.error('[MongoDB] Startup connection failed:', err));

// All questions are already embedded in Qdrant (done via scripts/resumeIndexing.ts,
// which diffs directly against Qdrant). No more batch-by-batch indexing needed at
// boot — just confirm the collections exist and report how many questions are ready.
ensureCollections()
  .then(async () => {
    const [math, english] = await Promise.all([
      getCollectionStats(MATH_COLLECTION_NAME),
      getCollectionStats(ENGLISH_COLLECTION_NAME),
    ]);
    console.log(`[RAG] Question bank ready — Math: ${math.count}, English: ${english.count}, Total: ${math.count + english.count}`);
  })
  .catch(err => console.warn('[RAG] Startup check failed (non-fatal):', err));

// Only one batch generation should ever be in flight at once, across ALL
// exam types/profiles — Gemini quota and the RAG/Qdrant/Mongo connections
// are shared, so two batches running at once (e.g. one on the SAT profile,
// one on the GRE profile) starve each other. A DB-only check
// (Database.getBatchRuns({status:"running"})) isn't enough on its own:
// two near-simultaneous requests can both read "none running" before either
// one's "running" status is actually saved. This in-memory flag is set
// synchronously the instant a request passes the check, closing that race.
let batchInProgress = false;

// Cleanup any orphaned batch runs left in "running" status from a previous killed server process
Database.getBatchRuns({ status: "running" }).then(async (runningBatches) => {
  for (const b of runningBatches) {
    console.log(`[Startup Cleanup] Marking orphaned batch ${b.batch_id} as stopped.`);
    b.status = "stopped";
    b.finished_at = new Date().toISOString();
    for (const item of b.items || []) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "skipped";
      }
    }
    await Database.saveBatchRun(b);
  }
}).catch(err => console.warn('[Startup Cleanup] Failed to cleanup running batches:', err));

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3002);

  // Middleware to parse JSON body
  app.use(express.json());

  // ----------------------------------------------------
  // API Routes
  // ----------------------------------------------------

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", env: process.env.NODE_ENV, has_key: !!process.env.GEMINI_API_KEY });
  });

  // How many exemplar questions are stored in Qdrant, per subject. Each
  // subject has its own collection (Math / Reading & Writing), so this is
  // just the two collections' point counts side by side.
  app.get("/api/rag/stats", async (req, res) => {
    try {
      const [math, english] = await Promise.all([
        getCollectionStats(MATH_COLLECTION_NAME),
        getCollectionStats(ENGLISH_COLLECTION_NAME),
      ]);
      res.json({
        Math: { collection: MATH_COLLECTION_NAME, count: math.count, ready: math.isReady },
        "Reading and Writing": { collection: ENGLISH_COLLECTION_NAME, count: english.count, ready: english.isReady },
        total: math.count + english.count,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to fetch Qdrant stats." });
    }
  });

  // Get active exam configs
  app.get("/api/configs/:exam", (req, res) => {
    const exam = req.params.exam.toLowerCase();
    const configPath = path.join(process.cwd(), "configs", `${exam}.json`);

    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, "utf-8");
        res.json(JSON.parse(configData));
      } catch (e) {
        res.status(500).json({ error: "Failed to parse exam configuration." });
      }
    } else {
      res.status(404).json({ error: `Exam configuration for '${exam}' not found.` });
    }
  });

  // Get list of questions in bank
  app.get("/api/questions/counts", async (req, res) => {
    try {
      const { exam_type } = req.query;
      const counts = await Database.getQuestionCounts(exam_type as string);
      res.json(counts);
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to fetch question counts." });
    }
  });

  app.get("/api/questions", async (req, res) => {
    const { exam_type, section, domain, status, userId } = req.query;
    const questions = await Database.getQuestions({
      exam_type: exam_type as string,
      section: section as string,
      domain: domain as string,
      status: status as "approved" | "rejected" | "escalated",
    });
    res.json(questions);
  });
  // Paginated variant — only pulls the current page from Mongo instead of
  // the whole collection. Use this for the Live Question Bank table; use
  // the plain /api/questions above only for small, fully-bounded sets
  // (e.g. status=escalated, which is normally a small subset).
  app.get("/api/questions/page", async (req, res) => {
    try {
      const { exam_type, section, domain, status, search } = req.query;
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 25));
      const result = await Database.getQuestionsPage({
        exam_type: exam_type as string,
        section: section as string,
        domain: domain as string,
        status: status as "approved" | "rejected" | "escalated",
        search: search as string,
        page,
        pageSize
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to fetch questions page." });
    }
  });
  app.get("/api/questions/export", async (req, res) => {
    const { toStagingFormatBulk } = await import("./src/server/formatter.js");
    const { from, to } = req.query;
    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from as string)) ||
      (to && !/^\d{4}-\d{2}-\d{2}$/.test(to as string))) {
      res.status(400).json({ error: "from/to must be dates in YYYY-MM-DD format." });
      return;
    }
    const questions = await Database.getQuestions({
      status: "approved",
      dateFrom: from as string,
      dateTo: to as string,
    });
    const staging = toStagingFormatBulk(questions);
    res.json(staging);
  });
  // Export every question in the bank regardless of review status
  // (approved / rejected / escalated), with full metadata intact.
  app.get("/api/questions/export-all", async (req, res) => {
    const { toStagingFormatWithStatusBulk } = await import("./src/server/formatter.js");
    const { exam_type, section, domain, from, to } = req.query;
    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from as string)) ||
      (to && !/^\d{4}-\d{2}-\d{2}$/.test(to as string))) {
      res.status(400).json({ error: "from/to must be dates in YYYY-MM-DD format." });
      return;
    }
    const questions = await Database.getQuestions({
      exam_type: exam_type as string,
      section: section as string,
      domain: domain as string,
      dateFrom: from as string,
      dateTo: to as string,
    });
    res.json(toStagingFormatWithStatusBulk(questions));
  });
  // Generate question using Orchestration loop
  app.post("/api/questions/generate", async (req, res) => {
    const { question_id, exam_type, section, domain, skill_tag, difficulty, userId } = req.body;

    if (!exam_type || !section || !domain || !skill_tag || !difficulty) {
      res.status(400).json({ error: "Missing required generation parameters." });
      return;
    }

    const configPath = path.join(process.cwd(), "configs", `${exam_type.toLowerCase()}.json`);
    if (!fs.existsSync(configPath)) {
      res.status(400).json({ error: `Config for ${exam_type} does not exist.` });
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

      // Hard ceiling on the whole request. Without this, any hang inside the
      // pipeline (a stuck model call, a dropped DB/RAG connection, etc.)
      // holds this HTTP response open indefinitely — the client-side fetch
      // would just spin forever, and since the frontend only clears its
      // "generating" lock once the fetch settles, the UI would appear stuck
      // until the page was refreshed. Racing against a timeout guarantees
      // this route always responds, and requestPipelineRunStop tells the
      // still-running pipeline (via the same stop_requested flag the Stop
      // button uses) to wind down instead of continuing to burn attempts
      // for a request the client has already given up on.
      const GENERATE_TIMEOUT_MS = 600000; // 240s
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`TIMEOUT: Generation exceeded ${GENERATE_TIMEOUT_MS / 1000}s server-side budget.`));
        }, GENERATE_TIMEOUT_MS);
      });

      const question = await Promise.race([
        runOrchestrationPipeline({
          question_id,
          exam_type,
          section,
          domain,
          skill_tag,
          difficulty,
          config,
          userId
        }),
        timeoutPromise
      ]);

      res.json({ success: true, question });
    } catch (e: any) {
      if (question_id) {
        // Best-effort — don't let a stop-request failure mask the real error.
        Database.requestPipelineRunStop(question_id).catch(() => { });
      }
      console.error("Pipeline failure:", e);
      res.status(500).json({ error: e.message || "Pipeline error during generation." });
    }
  });

  // Batch Generate: fires off one Generator/Validator pipeline run for EVERY
  // section × domain × skill × difficulty combination defined in the exam's
  // config file. This is a pure orchestration wrapper around the existing
  // single-question pipeline (same RAG rotation/reset, same validation) — it
  // does not introduce a separate generation path, and nothing here is
  // hardcoded to any specific exam. Runs in the background; the client polls
  // GET /api/batch-runs/:batch_id for live progress.
  app.post("/api/questions/generate-batch", async (req, res) => {
    const { exam_type, difficulties, sections, domains, skills, userId } = req.body;

    if (!exam_type) {
      res.status(400).json({ error: "Missing required parameter: exam_type." });
      return;
    }

    const configPath = path.join(process.cwd(), "configs", `${exam_type.toLowerCase()}.json`);
    if (!fs.existsSync(configPath)) {
      res.status(400).json({ error: `Config for ${exam_type} does not exist.` });
      return;
    }

    // Guard against triggering a second batch while ANY batch is already
    // in-flight — across all exam types/profiles, not just this one. The
    // in-memory `batchInProgress` flag is checked and set synchronously
    // (no await in between) so two near-simultaneous requests can't both
    // slip through before the DB reflects the first one as "running".
    if (batchInProgress) {
      res.status(409).json({
        error: "A batch generation is already running. Only one batch can run at a time, across all exams."
      });
      return;
    }
    // Also check the DB directly, in case the server restarted while a
    // batch was mid-run — a leftover "running" doc has to block new batches
    // even though the in-memory flag was reset by the restart.
    const alreadyRunning = await Database.getBatchRuns({ status: "running" });
    if (alreadyRunning.length > 0) {
      res.status(409).json({
        error: "A batch generation is already running. Only one batch can run at a time, across all exams.",
        batch_id: alreadyRunning[0].batch_id
      });
      return;
    }
    batchInProgress = true;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

      const sectionsFilter = Array.isArray(sections) ? sections : undefined;
      const domainsFilter = Array.isArray(domains) ? domains : undefined;
      const skillsFilter = Array.isArray(skills) ? skills : undefined;
      const difficultiesFilter = Array.isArray(difficulties) ? difficulties : undefined;

      // A custom filter combination (e.g. a section + domain that don't
      // actually pair up in the config) can legitimately produce zero
      // combinations — validate and fail loudly BEFORE persisting anything,
      // rather than saving an empty batch that would immediately report
      // "completed" with 0/0 items.
      const previewCombos = buildAllCombinations(config, difficultiesFilter, sectionsFilter, domainsFilter, skillsFilter);
      if (previewCombos.length === 0) {
        batchInProgress = false;
        res.status(400).json({ error: "No matching question combinations for the selected filters. Check that your selected sections, domains, and skills actually pair up in this exam's config." });
        return;
      }

      const batch = await createBatchRun({
        exam_type,
        config,
        difficulties: difficultiesFilter,
        sections: sectionsFilter,
        domains: domainsFilter,
        skills: skillsFilter,
        userId
      });

      // Fire and forget — the batch continues processing after we respond.
      // Release the lock whichever way this ends, so a crash can never leave
      // `batchInProgress` stuck true and block every future batch.
      processBatchRun({ batch, config, userId })
        .catch((e) => {
          console.error(`Batch pipeline crashed for ${batch.batch_id}:`, e);
        })
        .finally(() => {
          batchInProgress = false;
        });

      res.json({ success: true, batch_id: batch.batch_id, total: batch.total });
    } catch (e: any) {
      batchInProgress = false;
      console.error("Batch pipeline failure:", e);
      res.status(500).json({ error: e.message || "Batch pipeline error during generation." });
    }
  });

  // List batch runs (optionally filtered by exam_type / status) for polling & history
  app.get("/api/batch-runs", async (req, res) => {
    const { exam_type, status } = req.query;
    const runs = await Database.getBatchRuns({
      exam_type: exam_type as string,
      status: status as any,
    });
    res.json(runs);
  });

  // Get a single batch run's live progress
  app.get("/api/batch-runs/:batch_id", async (req, res) => {
    const run = await Database.getBatchRunById(req.params.batch_id);
    if (!run) {
      res.status(404).json({ error: "Batch run not found." });
      return;
    }
    res.json(run);
  });

  // Request that an in-progress batch run stop. Workers finish whatever item
  // they're already on (bounded by BATCH_ITEM_TIMEOUT_MS) and skip the rest.
  app.post("/api/batch-runs/:batch_id/stop", async (req, res) => {
    console.log(`\n[STOP] ── Stop requested for batch ${req.params.batch_id} ──`);
    const run = await Database.getBatchRunById(req.params.batch_id);
    if (!run) {
      console.log(`[STOP] Batch not found.`);
      res.status(404).json({ error: "Batch run not found." });
      return;
    }
    if (run.status !== "running") {
      console.log(`[STOP] Batch is not running (status="${run.status}") — nothing to stop.`);
      res.status(409).json({ error: "This batch run is not currently running.", status: run.status });
      return;
    }
    const updated = await Database.requestBatchRunStop(req.params.batch_id);
    console.log(`[STOP] stop_requested set on batch doc. Confirmed value in DB: ${updated?.stop_requested}`);

    if (!batchInProgress) {
      // If no active in-memory batch process is running (e.g. server was restarted mid-run),
      // mark the batch document as stopped in MongoDB immediately.
      run.status = "stopped";
      run.stop_requested = true;
      run.finished_at = new Date().toISOString();
      for (const item of run.items || []) {
        if (item.status === "pending" || item.status === "running") {
          item.status = "skipped";
        }
      }
      await Database.saveBatchRun(run);
      console.log(`[STOP] Orphaned batch ${run.batch_id} marked directly as stopped in DB.`);
      res.json({ success: true, batch: run });
      return;
    }

    // Setting stop_requested on the BATCH only stops workers from picking up
    // NEW items — it does nothing for whichever item(s) are already in
    // flight, since runOrchestrationPipeline only watches its own
    // per-question pipeline_run doc for a stop signal. Propagate the
    // request down to those so the in-flight generation is cancelled within
    // one attempt instead of running to completion (up to 2 minutes) first.
    const inFlightItems = (run.items || []).filter(i => i.status === "running" && i.question_id);
    console.log(`[STOP] ${inFlightItems.length} item(s) currently in-flight: ${inFlightItems.map(i => i.question_id).join(", ") || "(none)"}`);
    await Promise.all(
      inFlightItems.map(async (i) => {
        const stoppedRun = await Database.requestPipelineRunStop(i.question_id!);
        console.log(`[STOP]   → propagated to pipeline_run ${i.question_id} (stop_requested=${stoppedRun?.stop_requested})`);
      })
    );
    console.log(`[STOP] ── Done. Workers will pick this up on their next check. ──\n`);

    res.json({ success: true, batch: updated });
  });

  // Human Review: Approve, Reject, or Edit escalated questions
  app.post("/api/questions/review", async (req, res) => {
    const { question_id, action, updated_question, feedback, userId } = req.body;

    if (!question_id || !action) {
      res.status(400).json({ error: "Missing review parameters." });
      return;
    }

    const question = await Database.getQuestionById(question_id);
    if (!question) {
      res.status(404).json({ error: "Question not found." });
      return;
    }

    if (action === "approve") {
      await Database.updateQuestionStatus(question_id, "approved", feedback);
      res.json({ success: true, status: "approved" });
    } else if (action === "reject") {
      await Database.updateQuestionStatus(question_id, "rejected", feedback);
      res.json({ success: true, status: "rejected" });
    } else if (action === "edit") {
      if (!updated_question) {
        res.status(400).json({ error: "Missing updated question object." });
        return;
      }
      const finalQ = { ...updated_question, status: "approved" as const };
      await Database.saveQuestion(finalQ);
      res.json({ success: true, status: "approved", question: finalQ });
    } else {
      res.status(400).json({ error: "Invalid review action." });
    }
  });

  // Send a rejected question back to the Generator Agent for regeneration.
  // Re-runs the full single-question pipeline (same section/domain/skill/
  // difficulty, same RAG/validation path as /api/questions/generate) but
  // seeds attempt 1 with the rejection feedback so the generator knows what
  // to avoid instead of drafting blind. The original rejected question is
  // left untouched in the bank — this produces a brand new question_id.
  app.post("/api/questions/:question_id/regenerate", async (req, res) => {
    const { question_id } = req.params;
    const { userId } = req.body || {};

    const original = await Database.getQuestionById(question_id);
    if (!original) {
      res.status(404).json({ error: "Question not found." });
      return;
    }
    if (original.status !== "rejected") {
      res.status(400).json({ error: `Only rejected questions can be sent back to the generator (this question is "${original.status}").` });
      return;
    }

    const configPath = path.join(process.cwd(), "configs", `${original.exam_type.toLowerCase()}.json`);
    if (!fs.existsSync(configPath)) {
      res.status(400).json({ error: `Config for ${original.exam_type} does not exist.` });
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

      // Combine whatever reasoning we have for the rejection — validator
      // feedback and/or a human reviewer's override comments — into one
      // instruction for the generator. updateQuestionStatus overwrites
      // validation.feedback with the reviewer's comment when one was given,
      // so this naturally prefers the human's reasoning when present.
      const feedbackParts: string[] = [];
      if (original.validation?.feedback) {
        feedbackParts.push(original.validation.feedback);
      }
      const initialFeedback = feedbackParts.length > 0
        ? `This question was previously rejected for the following reason(s): ${feedbackParts.join(" ")} Generate a new question for this exact skill/difficulty that fully addresses this feedback — do not repeat the same mistake.`
        : `The previous attempt at this question was rejected by a human reviewer. Generate a fresh, higher-quality question for this exact skill/difficulty.`;

      const question = await runOrchestrationPipeline({
        exam_type: original.exam_type,
        section: original.section,
        domain: original.domain,
        skill_tag: original.skill_tag,
        difficulty: original.difficulty,
        config,
        userId,
        initialFeedback
      });

      res.json({ success: true, question, regenerated_from: question_id });
    } catch (e: any) {
      console.error("Regeneration pipeline failure:", e);
      res.status(500).json({ error: e.message || "Pipeline error during regeneration." });
    }
  });

  // Helpers for mapping uploaded rejected questions and compiling their feedback
  function mapUploadItemToConfig(
    item: any,
    config: any
  ): { section: string; domain: string; skill_tag: string; difficulty: string } {
    let difficulty = "Medium";
    const rawDifficulty = (item.difficulty || "").toLowerCase().trim();
    if (rawDifficulty === "easy") difficulty = "Easy";
    else if (rawDifficulty === "medium") difficulty = "Medium";
    else if (rawDifficulty === "hard") difficulty = "Hard";
    else {
      const configDiff = (config.difficulty_scale || []).find(
        (d: any) => d.label.toLowerCase() === rawDifficulty
      );
      if (configDiff) {
        difficulty = configDiff.label;
      }
    }

    let sectionName = "";
    const rawSection = (item.Section || "").toLowerCase().trim();
    const matchedSection = (config.sections || []).find((s: any) => {
      const sName = s.name.toLowerCase();
      return sName === rawSection || sName.includes(rawSection) || rawSection.includes(sName);
    });

    if (matchedSection) {
      sectionName = matchedSection.name;
    } else {
      if (rawSection.includes("math") || rawSection.includes("quant") || rawSection.includes("calc")) {
        const mathSec = (config.sections || []).find((s: any) =>
          s.name.toLowerCase().includes("math") || s.name.toLowerCase().includes("quant")
        );
        if (mathSec) sectionName = mathSec.name;
      } else if (rawSection.includes("read") || rawSection.includes("writ") || rawSection.includes("verbal") || rawSection.includes("eng")) {
        const engSec = (config.sections || []).find((s: any) =>
          s.name.toLowerCase().includes("read") || s.name.toLowerCase().includes("verbal") || s.name.toLowerCase().includes("writing")
        );
        if (engSec) sectionName = engSec.name;
      }
      if (!sectionName && config.sections && config.sections.length > 0) {
        sectionName = config.sections[0].name;
      }
    }

    const selectedSectionObj = (config.sections || []).find((s: any) => s.name === sectionName);

    let domainName = "";
    const rawCategory = (item.category || "").toLowerCase().trim();

    if (selectedSectionObj) {
      const matchedDomain = (selectedSectionObj.domains || []).find((d: any) => {
        const dName = d.name.toLowerCase();
        return dName === rawCategory || dName.includes(rawCategory) || rawCategory.includes(dName);
      });

      if (matchedDomain) {
        domainName = matchedDomain.name;
      } else {
        let maxOverlap = 0;
        let bestDomain = null;
        const catWords = new Set(rawCategory.split(/\s+/));
        for (const d of selectedSectionObj.domains || []) {
          const dWords = d.name.toLowerCase().split(/\s+/);
          const intersect = dWords.filter((w: string) => catWords.has(w));
          if (intersect.length > maxOverlap) {
            maxOverlap = intersect.length;
            bestDomain = d;
          }
        }
        if (bestDomain) {
          domainName = bestDomain.name;
        } else if (selectedSectionObj.domains && selectedSectionObj.domains.length > 0) {
          domainName = selectedSectionObj.domains[0].name;
        }
      }
    }

    const selectedDomainObj = selectedSectionObj?.domains?.find((d: any) => d.name === domainName);

    let skillTag = "";
    const rawSubSkill = (item.subSkill || "").toLowerCase().trim();

    if (selectedDomainObj) {
      const matchedSkill = (selectedDomainObj.skills || []).find((s: string) => {
        const sLower = s.toLowerCase();
        return sLower === rawSubSkill || sLower.includes(rawSubSkill) || rawSubSkill.includes(sLower);
      });

      if (matchedSkill) {
        skillTag = matchedSkill;
      } else {
        let maxOverlap = 0;
        let bestSkill = "";
        const subWords = new Set(rawSubSkill.split(/\s+/));
        for (const s of selectedDomainObj.skills || []) {
          const sWords = s.toLowerCase().split(/\s+/);
          const intersect = sWords.filter((w: string) => subWords.has(w));
          if (intersect.length > maxOverlap) {
            maxOverlap = intersect.length;
            bestSkill = s;
          }
        }
        if (bestSkill) {
          skillTag = bestSkill;
        } else if (selectedDomainObj.skills && selectedDomainObj.skills.length > 0) {
          skillTag = selectedDomainObj.skills[0];
        }
      }
    }

    return {
      section: sectionName,
      domain: domainName,
      skill_tag: skillTag,
      difficulty
    };
  }

  function compileFeedback(q: any): string {
    const parts: string[] = [];

    if (q.pipelineValidatorFeedback) {
      parts.push(`Automated pipeline feedback: ${q.pipelineValidatorFeedback}`);
    }

    if (q.reviewerNote) {
      parts.push(`Reviewer note: ${q.reviewerNote}`);
    }

    if (q.statusOverrideJustification) {
      parts.push(`Manual override justification: ${q.statusOverrideJustification}`);
    }

    if (q.checklist) {
      const ch = q.checklist;
      const checklistFailed: string[] = [];
      if (ch.formationOk === false) checklistFailed.push("structural format, options, or key validity issues");
      if (ch.answerOk === false) checklistFailed.push("answer correctness or explanation clarity issues");
      if (ch.categoryOk === false) {
        const override = ch.categoryOverride ? ` (suggested override: ${ch.categoryOverride})` : "";
        checklistFailed.push(`incorrect category/domain alignment${override}`);
      }
      if (ch.difficultyOk === false) {
        const override = ch.difficultyOverride ? ` (suggested override: ${ch.difficultyOverride})` : "";
        checklistFailed.push(`incorrect difficulty alignment${override}`);
      }
      if (checklistFailed.length > 0) {
        parts.push(`Reviewer checklist flags: The question has ${checklistFailed.join(", ")}.`);
      }
    }

    if (Array.isArray(q.comments) && q.comments.length > 0) {
      const commentTexts = q.comments
        .map((c: any) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object') {
            return c.text || c.comment || c.message || c.content || JSON.stringify(c);
          }
          return '';
        })
        .filter(Boolean);
      if (commentTexts.length > 0) {
        parts.push(`Reviewer discussion comments:\n- ${commentTexts.join('\n- ')}`);
      }
    }

    const text = parts.join('\n');
    if (!text) {
      return "This question was rejected. Please generate a fresh, higher-quality replacement.";
    }
    return text;
  }

  // POST endpoint to handle custom upload-based batch generation
  app.post("/api/questions/generate-batch-from-upload", async (req, res) => {
    const { exam_type, questions, userId } = req.body;

    if (!exam_type) {
      res.status(400).json({ error: "Missing required parameter: exam_type." });
      return;
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: "Missing or empty parameter: questions." });
      return;
    }

    const configPath = path.join(process.cwd(), "configs", `${exam_type.toLowerCase()}.json`);
    if (!fs.existsSync(configPath)) {
      res.status(400).json({ error: `Config for ${exam_type} does not exist.` });
      return;
    }

    if (batchInProgress) {
      res.status(409).json({
        error: "A batch generation is already running. Only one batch can run at a time, across all exams."
      });
      return;
    }

    const alreadyRunning = await Database.getBatchRuns({ status: "running" });
    if (alreadyRunning.length > 0) {
      res.status(409).json({
        error: "A batch generation is already running. Only one batch can run at a time, across all exams.",
        batch_id: alreadyRunning[0].batch_id
      });
      return;
    }

    batchInProgress = true;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const { v4: uuidv4 } = await import("uuid");

      const items = questions.map((q: any) => {
        const mapped = mapUploadItemToConfig(q, config);
        const feedback = compileFeedback(q);

        return {
          section: mapped.section,
          domain: mapped.domain,
          skill_tag: mapped.skill_tag,
          difficulty: mapped.difficulty,
          status: "pending" as const,
          initialFeedback: feedback
        };
      });

      const batch = {
        batch_id: `batch-${exam_type.toLowerCase()}-${uuidv4().slice(0, 8)}`,
        exam_type,
        total: items.length,
        completed: 0,
        approved: 0,
        escalated: 0,
        failed: 0,
        cancelled: 0,
        status: "running" as const,
        items,
        started_at: new Date().toISOString(),
        userId
      };

      await Database.saveBatchRun(batch);

      processBatchRun({ batch, config, userId })
        .catch((e) => {
          console.error(`Batch pipeline crashed for upload run ${batch.batch_id}:`, e);
        })
        .finally(() => {
          batchInProgress = false;
        });

      res.json({ success: true, batch_id: batch.batch_id, total: batch.total });

    } catch (e: any) {
      batchInProgress = false;
      console.error("Batch from upload pipeline failure:", e);
      res.status(500).json({ error: e.message || "Batch pipeline error during upload generation." });
    }
  });

  // Reset database back to seed questions
  app.post("/api/reset", async (req, res) => {
    const { userId } = req.body;
    await Database.reset();
    res.json({ success: true, message: "Database reseeded to 20 default SAT questions." });
  });

  // Get Validation logs (for Audits and QA analytics)
  app.get("/api/audit-logs", async (req, res) => {
    const { exam_type, limit } = req.query;
    // Previously this ignored exam_type entirely and fetched every exam's
    // full, unbounded log history on every poll tick — the main cause of
    // the lag/glitching and the tracker appearing to skip questions.
    res.json(await Database.getAuditLogs({
      exam_type: exam_type as string,
      limit: limit ? Number(limit) : undefined
    }));
  });

  // Get current active/completed pipeline runs for visual mapping
  app.get("/api/pipeline-runs", async (req, res) => {
    const { exam_type } = req.query;
    res.json(await Database.getPipelineRuns({ exam_type: exam_type as string }));
  });

  // Single run by id — used to poll/refresh the one run actually on screen
  // instead of pulling the 100 most recent full runs (each with its
  // complete step-by-step log/debug history) just to find one by id.
  app.get("/api/pipeline-runs/:question_id", async (req, res) => {
    const run = await Database.getPipelineRunById(req.params.question_id);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found." });
      return;
    }
    res.json(run);
  });

  // Latest run for a section/domain/skill/difficulty combo — batch tracking
  // needs this before the running item has a question_id yet.
  app.get("/api/pipeline-runs/by-combo/lookup", async (req, res) => {
    const { exam_type, section, domain, skill_tag, difficulty } = req.query;
    if (!section || !domain || !skill_tag || !difficulty) {
      res.status(400).json({ error: "section, domain, skill_tag, and difficulty are required." });
      return;
    }
    const run = await Database.getLatestPipelineRunByCombo({
      exam_type: exam_type as string,
      section: section as string,
      domain: domain as string,
      skill_tag: skill_tag as string,
      difficulty: difficulty as string
    });
    if (!run) {
      res.status(404).json({ error: "No matching pipeline run found." });
      return;
    }
    res.json(run);
  });

  // Request that an in-progress single-question generation stop. The current
  // attempt finishes, but no new attempt starts — no partial/incomplete
  // question is ever added, since the pipeline itself refuses to save one.
  app.post("/api/pipeline-runs/:question_id/stop", async (req, res) => {
    const run = await Database.getPipelineRunById(req.params.question_id);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found." });
      return;
    }
    if (run.status !== "running") {
      res.status(409).json({ error: "This run is not currently in progress.", status: run.status });
      return;
    }
    const updated = await Database.requestPipelineRunStop(req.params.question_id);
    res.json({ success: true, run: updated });
  });

  // ----------------------------------------------------
  // Dev & Production Asset Handlers
  // ----------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const listenOnPort = (port: number) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${port}`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && port !== 0) {
        console.warn(`Port ${port} is busy, trying ${port + 1}...`);
        server.close(() => listenOnPort(port + 1));
      } else {
        console.error("Server failed to start:", err);
        process.exit(1);
      }
    });
  };

  listenOnPort(PORT);
}

startServer();