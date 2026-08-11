import fs from "fs/promises";
import path from "path";
import { getDb } from "./mongoClient";
import { toStagingFormatBulk, cleanQuestionText } from "./formatter";
import { SEED_QUESTIONS } from "./seedData";
import { Question, ValidationAuditLog, PipelineRun, BatchRun } from "../types";
import { resetExemplarUsage } from "./rag/ragSystem";

const QUESTIONS_COL = "questions";
const AUDIT_LOGS_COL = "audit_logs";
const PIPELINE_RUNS_COL = "pipeline_runs";
const BATCH_RUNS_COL = "batch_runs";

export class Database {

  private static buildQuestionQuery(filters?: {
    exam_type?: string;
    section?: string;
    domain?: string;
    status?: "approved" | "rejected" | "escalated";
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }): any {
    const query: any = {};
    if (filters?.exam_type) query.exam_type = { $regex: new RegExp(`^${filters.exam_type}$`, 'i') };
    if (filters?.section) query.section = filters.section;
    if (filters?.domain) query.domain = filters.domain;
    if (filters?.status) query.status = filters.status;
    if (filters?.dateFrom || filters?.dateTo) {
      const range: any = {};
      if (filters.dateFrom) range.$gte = `${filters.dateFrom}T00:00:00.000Z`;
      if (filters.dateTo) range.$lte = `${filters.dateTo}T23:59:59.999Z`;
      // created_at is stored as an ISO string (see generatorAgent.ts), so
      // lexicographic string comparison lines up with chronological order.
      query["metadata.created_at"] = range;
    }
    if (filters?.search) {
      const safe = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [
        { question_text: rx },
        { passage: rx },
        { skill_tag: rx },
        { question_id: rx }
      ];
    }
    return query;
  }

  public static async getQuestions(filters?: {
    exam_type?: string;
    section?: string;
    domain?: string;
    status?: "approved" | "rejected" | "escalated";
    limit?: number;
    includeEmbeddings?: boolean;
    // Inclusive date range filter, matched against metadata.created_at.
    // Pass plain "YYYY-MM-DD" strings — dateFrom is treated as the start
    // of that day and dateTo as the end of that day, so a single-day
    // range (dateFrom === dateTo) still returns everything created on it.
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Question[]> {
    const db = await getDb();
    const query = this.buildQuestionQuery(filters);
    const options: any = {};
    if (!filters?.includeEmbeddings) {
      options.projection = { embedding: 0 };
    }
    // Newest questions first, so freshly generated questions show up on
    // page 1 instead of the very last page of the bank.
    let cursor = db.collection(QUESTIONS_COL).find(query, options).sort({ "metadata.created_at": -1 });
    if (filters?.limit) cursor = cursor.limit(filters.limit);
    const docs = await cursor.toArray();
    const rawQuestions = docs as unknown as Question[];
    return rawQuestions.map(q => ({
      ...q,
      question_text: cleanQuestionText(q.question_text)
    }));
  }

  // Real server-side pagination: only pulls the page actually shown on
  // screen, plus a count for the current filter set, instead of the entire
  // collection on every load/poll tick.
  public static async getQuestionsPage(filters: {
    exam_type?: string;
    section?: string;
    domain?: string;
    status?: "approved" | "rejected" | "escalated";
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;      // 1-indexed
    pageSize: number;
  }): Promise<{ questions: Question[]; total: number }> {
    const db = await getDb();
    const query = this.buildQuestionQuery(filters);
    const skip = Math.max(0, (filters.page - 1) * filters.pageSize);

    const [docs, total] = await Promise.all([
      db.collection(QUESTIONS_COL)
        .find(query, { projection: { embedding: 0 } })
        .sort({ "metadata.created_at": -1 })
        .skip(skip)
        .limit(filters.pageSize)
        .toArray(),
      db.collection(QUESTIONS_COL).countDocuments(query)
    ]);

    const questions = (docs as unknown as Question[]).map(q => ({
      ...q,
      question_text: cleanQuestionText(q.question_text)
    }));
    return { questions, total };
  }

  public static async getQuestionCounts(exam_type?: string): Promise<{ approved: number; escalated: number; total: number }> {
    const db = await getDb();
    const query: any = {};
    if (exam_type) query.exam_type = { $regex: new RegExp(`^${exam_type}$`, 'i') };

    const [approved, escalated] = await Promise.all([
      db.collection(QUESTIONS_COL).countDocuments({ ...query, status: "approved" }),
      db.collection(QUESTIONS_COL).countDocuments({ ...query, status: "escalated" })
    ]);

    return {
      approved,
      escalated,
      total: approved + escalated
    };
  }

  public static async getQuestionById(id: string): Promise<Question | undefined> {
    const db = await getDb();
    const doc = await db.collection(QUESTIONS_COL).findOne({ question_id: id });
    if (!doc) return undefined;
    const q = doc as unknown as Question;
    return {
      ...q,
      question_text: cleanQuestionText(q.question_text)
    };
  }

  public static async saveQuestion(q: Question): Promise<void> {
    const db = await getDb();
    const cleanedQuestion = {
      ...q,
      question_text: cleanQuestionText(q.question_text)
    };
    await db.collection(QUESTIONS_COL).replaceOne(
      { question_id: q.question_id },
      cleanedQuestion,
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

  // Latest run for a section/domain/skill/difficulty combo — batch tracking
  // needs this before the running item has a question_id yet.
  public static async getLatestPipelineRunByCombo(params: {
    exam_type?: string;
    section: string;
    domain: string;
    skill_tag: string;
    difficulty: string;
  }): Promise<PipelineRun | undefined> {
    const db = await getDb();
    const query: any = {
      section: params.section,
      domain: params.domain,
      skill_tag: params.skill_tag,
      difficulty: params.difficulty
    };
    if (params.exam_type) query.exam_type = params.exam_type;
    const doc = await db.collection(PIPELINE_RUNS_COL)
      .find(query)
      .sort({ started_at: -1 })
      .limit(1)
      .next();
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