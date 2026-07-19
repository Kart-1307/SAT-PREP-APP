import fs from "fs/promises";
import path from "path";
import { getDb } from "./mongoClient";
import { toStagingFormatBulk } from "./formatter";
import { SEED_QUESTIONS } from "./seedData";
import { Question, ValidationAuditLog, PipelineRun, BatchRun } from "../types";
import { resetExemplarUsage } from "./rag/ragSystem";

const QUESTIONS_COL = "questions";
const AUDIT_LOGS_COL = "audit_logs";
const PIPELINE_RUNS_COL = "pipeline_runs";
const BATCH_RUNS_COL = "batch_runs";

export class Database {

  public static async getQuestions(filters?: {
    exam_type?: string;
    section?: string;
    domain?: string;
    status?: "approved" | "rejected" | "escalated";
    limit?: number;
    // Embedding vectors (768-3072 floats per question) are only needed by
    // the similarity-check step. Every other caller — including the
    // frontend's polling GET /api/questions, hit every 0.8-1.5s while
    // generation is running — was pulling this huge payload for every
    // question in the bank on every single tick, which is what made the
    // tab lock up / "Not Responding" as the bank grew. Default to excluding
    // it; only runSimilarityCheck opts in.
    includeEmbeddings?: boolean;
  }): Promise<Question[]> {
    const db = await getDb();
    const query: any = {};
    if (filters?.exam_type) query.exam_type = filters.exam_type;
    if (filters?.section) query.section = filters.section;
    if (filters?.domain) query.domain = filters.domain;
    if (filters?.status) query.status = filters.status;
    const options: any = {};
    if (!filters?.includeEmbeddings) {
      options.projection = { embedding: 0 };
    }
    // No limit by default (exports/reset need the full set) — callers on a
    // tight polling loop should pass an explicit limit to keep payloads small.
    let cursor = db.collection(QUESTIONS_COL).find(query, options);
    if (filters?.limit) cursor = cursor.limit(filters.limit);
    const docs = await cursor.toArray();
    return docs as unknown as Question[];
  }

  public static async getQuestionById(id: string): Promise<Question | undefined> {
    const db = await getDb();
    const doc = await db.collection(QUESTIONS_COL).findOne({ question_id: id });
    return doc as unknown as Question | undefined;
  }

  public static async saveQuestion(q: Question): Promise<void> {
    const db = await getDb();
    await db.collection(QUESTIONS_COL).replaceOne(
      { question_id: q.question_id },
      q,
      { upsert: true }
    );
  }

  public static async updateQuestionStatus(
    id: string,
    status: "approved" | "rejected" | "escalated",
    feedback?: string
  ): Promise<void> {
    const db = await getDb();
    const update: any = { $set: { status } };
    if (feedback) update.$set["validation.feedback"] = feedback;
    await db.collection(QUESTIONS_COL).updateOne({ question_id: id }, update);
  }

  public static async deleteQuestion(id: string): Promise<void> {
    const db = await getDb();
    await db.collection(QUESTIONS_COL).deleteOne({ question_id: id });
  }

  public static async getAuditLogs(filters?: { exam_type?: string; limit?: number }): Promise<ValidationAuditLog[]> {
    const db = await getDb();
    const query: any = {};
    if (filters?.exam_type) query.exam_type = filters.exam_type;
    // Polling loops only need recent logs — cap like getPipelineRuns does,
    // otherwise this collection scan grows (and gets re-sent) forever.
    const limit = filters?.limit ?? 200;
    const docs = await db.collection(AUDIT_LOGS_COL)
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return docs as unknown as ValidationAuditLog[];
  }

  public static async addAuditLog(log: ValidationAuditLog): Promise<void> {
    const db = await getDb();
    await db.collection(AUDIT_LOGS_COL).replaceOne(
      { id: log.id },
      log,
      { upsert: true }
    );
  }

  public static async getPipelineRuns(filters?: {
    exam_type?: string;
    limit?: number;
  }): Promise<PipelineRun[]> {
    const db = await getDb();
    const query: any = {};
    if (filters?.exam_type) query.exam_type = filters.exam_type;
    // Cap results — polling loops only ever need recent runs.
    const limit = filters?.limit ?? 100;
    const docs = await db.collection(PIPELINE_RUNS_COL)
      .find(query)
      .sort({ started_at: -1 })
      .limit(limit)
      .toArray();
    return docs as unknown as PipelineRun[];
  }

  public static async savePipelineRun(run: PipelineRun): Promise<void> {
    const db = await getDb();
    // updateOne + $set (merge), NOT replaceOne (full swap). This process
    // holds its own in-memory `run` object, which never has
    // `stop_requested` set on it locally — that field only ever gets set
    // externally via requestPipelineRunStop's own $set. A replaceOne here
    // would blindly overwrite the whole document with this stale in-memory
    // copy on every single log step (draft/validate/decision), silently
    // erasing any stop request that arrived in between. $set only touches
    // the fields present in `run`, leaving stop_requested alone.
    await db.collection(PIPELINE_RUNS_COL).updateOne(
      { question_id: run.question_id },
      { $set: run },
      { upsert: true }
    );
  }

  public static async getPipelineRunById(question_id: string): Promise<PipelineRun | undefined> {
    const db = await getDb();
    const doc = await db.collection(PIPELINE_RUNS_COL).findOne({ question_id });
    return doc ? (doc as unknown as PipelineRun) : undefined;
  }

  public static async requestPipelineRunStop(question_id: string): Promise<PipelineRun | undefined> {
    const db = await getDb();
    const existing = await db.collection(PIPELINE_RUNS_COL).findOne({ question_id });
    if (!existing) return undefined;
    await db.collection(PIPELINE_RUNS_COL).updateOne(
      { question_id },
      { $set: { stop_requested: true } }
    );
    return { ...(existing as unknown as PipelineRun), stop_requested: true };
  }

  // ─── Batch Run methods ──────────────────────────────────────────────

  public static async getBatchRuns(filters?: {
    exam_type?: string;
    status?: "running" | "completed" | "completed_with_escalations" | "completed_with_errors" | "failed" | "stopped";
  }): Promise<BatchRun[]> {
    const db = await getDb();
    const query: any = {};
    if (filters?.exam_type) query.exam_type = filters.exam_type;
    if (filters?.status) query.status = filters.status;
    const docs = await db.collection(BATCH_RUNS_COL)
      .find(query)
      .sort({ started_at: -1 })
      .toArray();
    return docs as unknown as BatchRun[];
  }

  public static async getBatchRunById(id: string): Promise<BatchRun | undefined> {
    const db = await getDb();
    const doc = await db.collection(BATCH_RUNS_COL).findOne({ batch_id: id });
    return doc as unknown as BatchRun | undefined;
  }

  public static async saveBatchRun(run: BatchRun): Promise<void> {
    const db = await getDb();
    // Same fix as savePipelineRun above: merge via $set, don't replace the
    // whole document. processBatchRun's in-memory `batch` object never
    // carries `stop_requested` locally, so a replaceOne here (called after
    // every single item finishes) would silently wipe out a stop request
    // that a /stop call had just set moments earlier via its own $set.
    await db.collection(BATCH_RUNS_COL).updateOne(
      { batch_id: run.batch_id },
      { $set: run },
      { upsert: true }
    );
  }

  public static async requestBatchRunStop(batch_id: string): Promise<BatchRun | undefined> {
    const db = await getDb();
    const existing = await db.collection(BATCH_RUNS_COL).findOne({ batch_id });
    if (!existing) return undefined;
    await db.collection(BATCH_RUNS_COL).updateOne(
      { batch_id },
      { $set: { stop_requested: true } }
    );
    return { ...(existing as unknown as BatchRun), stop_requested: true };
  }

  public static async reset(): Promise<void> {
    const db = await getDb();

    const approvedDocs = await db.collection(QUESTIONS_COL)
      .find({ status: "approved" })
      .toArray();
    const approvedQuestions = approvedDocs as unknown as Question[];

    const seedIds = new Set(SEED_QUESTIONS.map(q => q.question_id));
    const generatedApproved = approvedQuestions.filter(q => !seedIds.has(q.question_id));

    // Export generated questions before reset
    const exportPath = path.join(process.cwd(), "generated_questions.json");
    await fs.writeFile(
      exportPath,
      JSON.stringify(toStagingFormatBulk(generatedApproved), null, 2),
      "utf8"
    );

    // Clear all collections
    await db.collection(QUESTIONS_COL).deleteMany({});
    await db.collection(AUDIT_LOGS_COL).deleteMany({});
    await db.collection(PIPELINE_RUNS_COL).deleteMany({});
    await db.collection(BATCH_RUNS_COL).deleteMany({});

    // Re-seed with default questions
    for (const seedQuestion of SEED_QUESTIONS) {
      await db.collection(QUESTIONS_COL).insertOne({ ...seedQuestion } as any);
    }

    // Clear RAG exemplar rotation history so next generations
    // start fresh without stale used-ID tracking
    await resetExemplarUsage();

    console.log('[MongoDB] ✅ Database reset and reseeded successfully');
  }
}