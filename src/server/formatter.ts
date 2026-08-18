import { Question } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Converts internal Question objects → staging/local export format
// (matches staging-questions.json schema exactly)
// ─────────────────────────────────────────────────────────────────────────────

export interface StagingQuestion {
  id: string;
  category: string;
  passage_intro?: string | null;
  passage: string | null;
  stimulus: string | null;
  question: string;
  choices: Record<string, string>;
  correct_answer: string;
  explanation: string;
  module: string;
  Section: string;
  difficulty: string;
}

// Consolidate interfaces: Make LocalJsonQuestion an alias of StagingQuestion
// so any file importing it doesn't break.
export type LocalJsonQuestion = StagingQuestion;

function toStagingSection(section: string): string {
  const s = section.toLowerCase();
  if (s.includes('math')) return 'Math';
  if (s.includes('reading') || s.includes('writing') || s.includes('english')) return 'Reading_Writing';
  return section; 
}

function toStagingDifficulty(difficulty: string): string {
  return difficulty.toLowerCase();
}

function toStagingModule(question: Question): string {
  const meta = question.metadata?.exam_specific as Record<string, string> | undefined;
  if (meta?.module) return meta.module;
  const d = question.difficulty.toLowerCase();
  return d === 'hard' ? 'Module 2' : 'Module 1';
}

function toStagingChoices(answerChoices: Question['answer_choices']): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const choice of answerChoices) {
    choices[choice.id] = choice.text;
  }
  return choices;
}

function toStagingExplanation(explanation: Question['explanation']): string {
  if (typeof explanation === 'string') return explanation;
  return explanation.correct_rationale || '';
}

export function cleanQuestionText(text: string | null | undefined): string {
  if (!text) return '';
  return String(text).trim();
}

// The single source of truth for the transformation
export function toStagingFormat(question: Question): StagingQuestion {
  return {
    id:             question.question_id,
    category:       question.domain,
    passage_intro:  question.passage_intro ?? null,
    passage:        question.passage ?? null,
    stimulus:       question.stimulus ?? null,
    question:       cleanQuestionText(question.question_text),
    choices:        toStagingChoices(question.answer_choices),
    correct_answer: question.correct_answer,
    explanation:    toStagingExplanation(question.explanation),
    module:         toStagingModule(question),
    Section:        toStagingSection(question.section),
    difficulty:     toStagingDifficulty(question.difficulty),
  };
}

export function toStagingFormatBulk(questions: Question[]): StagingQuestion[] {
  return questions.map(toStagingFormat);
}

// Same as staging format, but keeps the review status
// (approved / rejected / escalated) alongside every question, plus the
// validator's own verdict context (feedback text + duplicate-detection
// results) so downstream reviewer tools (e.g. the "Pipeline Verdict" and
// "Possible duplicate" panels) have something to render.
export interface StagingQuestionWithStatus extends StagingQuestion {
  status: Question['status'];
  validatorFeedback?: string;
  similarity_score?: number;
  similar_question_id?: string | null;
}

export function toStagingFormatWithStatus(question: Question): StagingQuestionWithStatus {
  return {
    ...toStagingFormat(question),
    status: question.status,
    validatorFeedback: question.validation?.feedback,
    similarity_score: question.similarity_score,
    similar_question_id: question.similar_question_id,
  };
}

export function toStagingFormatWithStatusBulk(questions: Question[]): StagingQuestionWithStatus[] {
  return questions.map(toStagingFormatWithStatus);
}

// Point the local JSON function directly to the staging formatter.
// This preserves backward compatibility across your codebase.
export const toLocalJsonFormat = toStagingFormat;