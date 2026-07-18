export interface AnswerChoice {
  id: string;
  text: string;
}

export interface Explanation {
  correct_rationale: string;
  distractor_rationale: {
    [key: string]: string;
  };
}

export interface CheckResult {
  correctness: string;
  distractor_quality: string;
  clarity: string;
  difficulty_alignment: string;
  domain_skill_alignment: string;
  originality: string;
  bias_sensitivity: string;
}

export interface ValidationBlock {
  validation_status: "PASS" | "FAIL";
  accuracy_score: number;
  checks: CheckResult;
  feedback: string;
  revised_suggestion?: string;
  timestamp?: string;
  independent_derivation?: string;
}

export interface QuestionMetadata {
  created_at: string;
  model_version: string;
  config_version: string;
  exam_specific: Record<string, any>;
}

export interface Question {
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  passage: string | null;
  stimulus: string | null;
  question_text: string;
  answer_choices: AnswerChoice[];
  correct_answer: string;
  explanation: Explanation;
  similarity_score: number;
  similar_question_id: string | null;
  embedding?: number[];
  generation_attempt: number;
  validation?: ValidationBlock;
  metadata: QuestionMetadata;
  status: "approved" | "rejected" | "escalated";
}

export interface Domain {
  name: string;
  skills: string[];
}

export interface Section {
  name: string;
  question_formats: string[];
  domains: Domain[];
}

export interface DifficultyScale {
  label: string;
  definition: string;
}

export interface RubricCheck {
  id: string;
  description: string;
  weight: number;
}

export interface ValidationRubric {
  min_composite_score: number;
  zero_tolerance_checks: string[];
  checks: RubricCheck[];
}

export interface TestProfileConfig {
  exam_type: string;
  name: string;
  description: string;
  sections: Section[];
  difficulty_scale: DifficultyScale[];
  style_rules: string[];
  validation_rubric: ValidationRubric;
}

export interface PipelineStepLog {
  timestamp: string;
  type: "draft" | "critique" | "finalize" | "pre_filter" | "validate" | "decision" | "rag_retrieval";
  message: string;
  details?: any;
}

export interface PipelineRun {
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  current_attempt: number;
  max_attempts: number;
  logs: PipelineStepLog[];
  status: "running" | "completed_pass" | "completed_escalated" | "failed" | "cancelled";
  final_question?: Question;
  started_at?: string;
  stop_requested?: boolean;
}

export interface ValidationAuditLog {
  id: string;
  question_id: string;
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  accuracy_score: number;
  validation_status: "PASS" | "FAIL";
  generation_attempt: number;
  checks: CheckResult;
  feedback: string;
  timestamp: string;
}

// ─── Batch Generation Types (exam-agnostic) ──────────────────────────────────

export interface BatchRunItem {
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  question_id?: string;
  question_status?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
  last_message?: string;   // <-- add this line
  initialFeedback?: string;
}

export interface BatchRun {
  batch_id: string;
  exam_type: string;
  total: number;
  completed: number;
  // NEW: split out of `completed` so the UI can tell the difference between
  // "the pipeline finished and the question was approved" vs "the pipeline
  // finished but hit max_attempts and had to escalate to human review".
  // Previously both cases only incremented `completed`, which is why a
  // batch could report e.g. "40/50 completed" in green/success styling
  // even when most of those 40 were actually escalated, not approved.
  approved: number;
  escalated: number;
  failed: number;
  status: "running" | "completed" | "completed_with_escalations" | "completed_with_errors" | "failed" | "stopped";
  items: BatchRunItem[];
  started_at: string;
  finished_at?: string;
  userId?: string;
  stop_requested?: boolean;
}

// ─── RAG Types ────────────────────────────────────────────────────────────────

export interface RAGChunk {
  chunkId: string;
  text: string;
  vector: number[];
  metadata: {
    domain: string;
    difficulty: string;
    source: string;
    chunkIndex: number;
  };
}

export interface RAGRetrievalResult {
  exemplars: string[];
  query: {
    domain: string;
    skill: string;
    difficulty: string;
  };
  count: number;
}