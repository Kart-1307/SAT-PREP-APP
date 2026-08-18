// src/server/prompts/promptSelector.ts
//
// This is the piece that actually reduces API load: instead of always
// running the full 3-stage pipeline (draft -> solve -> distractors,
// 3 Claude calls per question), the runtime now picks ONE static,
// difficulty-specific prompt based on the incoming request and makes a
// SINGLE Claude call.
//
// Nothing is imported/loaded until it's actually needed - each prompt
// file is a small standalone module, so requiring one doesn't pull in
// the other seven.

import { READING_WRITING_EASY_SYSTEM_PROMPT } from './reading-writing-easy';
import { READING_WRITING_MEDIUM_SYSTEM_PROMPT } from './reading-writing-medium';
import { READING_WRITING_HARD_SYSTEM_PROMPT } from './reading-writing-hard';
import { buildReadingWritingGeneralSystemPrompt } from './reading-writing-general';

import { MATH_EASY_SYSTEM_PROMPT } from './math-easy';
import { MATH_MEDIUM_SYSTEM_PROMPT } from './math-medium';
import { MATH_HARD_SYSTEM_PROMPT } from './math-hard';
import { buildMathGeneralSystemPrompt } from './math-general';

export type Subject = 'Math' | 'Reading and Writing';
export type Difficulty = 'Easy' | 'Medium' | 'Hard';

/**
 * Normalizes whatever subject string your app already uses ("English",
 * "Writing", "Reading", "Math", etc.) into the two buckets these prompts
 * are split by. Adjust the matching below to your actual incoming values
 * if they differ.
 */
function normalizeSubject(rawSubject: string): Subject {
  const s = rawSubject.trim().toLowerCase();
  if (s === 'math' || s === 'mathematics') return 'Math';
  return 'Reading and Writing';
}

function normalizeDifficulty(rawDifficulty: string): Difficulty {
  const d = rawDifficulty.trim().toLowerCase();
  if (d === 'easy') return 'Easy';
  if (d === 'hard') return 'Hard';
  return 'Medium'; // default/fallback
}

/**
 * Returns the ONE static system prompt to use for this request.
 * Nothing else is generated or run - this is a pure lookup, not a call.
 *
 * If a difficulty is provided, the specific EASY/MEDIUM/HARD prompt is
 * used (this is the fast, static, single-call path - use this for all
 * normal question-generation requests). The General prompt is only used
 * as a fallback when no difficulty was supplied at all.
 */
export function getSystemPromptForRequest(
  rawSubject: string,
  rawDifficulty?: string
): string {
  const subject = normalizeSubject(rawSubject);

  if (!rawDifficulty) {
    // No difficulty given -> fall back to the flexible General prompt,
    // defaulting its internal tier to Medium.
    return subject === 'Math'
      ? buildMathGeneralSystemPrompt('MEDIUM')
      : buildReadingWritingGeneralSystemPrompt('MEDIUM');
  }

  const difficulty = normalizeDifficulty(rawDifficulty);

  if (subject === 'Math') {
    switch (difficulty) {
      case 'Easy':
        return MATH_EASY_SYSTEM_PROMPT;
      case 'Hard':
        return MATH_HARD_SYSTEM_PROMPT;
      case 'Medium':
      default:
        return MATH_MEDIUM_SYSTEM_PROMPT;
    }
  }

  switch (difficulty) {
    case 'Easy':
      return READING_WRITING_EASY_SYSTEM_PROMPT;
    case 'Hard':
      return READING_WRITING_HARD_SYSTEM_PROMPT;
    case 'Medium':
    default:
      return READING_WRITING_MEDIUM_SYSTEM_PROMPT;
  }
}
