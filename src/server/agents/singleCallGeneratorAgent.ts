// src/server/agents/singleCallGeneratorAgent.ts
//
// DROP-IN alternative to the per-question work the 3-stage pipeline does
// in generatorAgent.ts (generateScenarioDraft -> solveScenario ->
// generateWrongChoices), but as ONE Claude call instead of three.
//
// Only the one static prompt matching the request's subject+difficulty is
// loaded (via promptSelector.ts), and a single tool-forced Claude call
// returns the fully drafted, solved, and distractor-equipped question.
// The result is then passed through the REAL, now-exported
// `assembleChoices()` from generatorAgent.ts, so the label-stripping,
// null-normalizing, dedup, and shuffle logic lives in exactly one place
// and stays consistent between the old 3-call pipeline and this new
// single-call path.
//
// RAG retrieval is untouched: retrieveExemplarQuestionsForGeneration() is
// called with the exact same params it always received.

import { getSystemPromptForRequest, Subject, Difficulty } from '../prompts/promptSelector';
import { retrieveExemplarQuestionsForGeneration } from '../rag/ragSystem';
import { assembleChoices, getAI } from './generatorAgent';

const GENERATOR_MODEL = 'claude-sonnet-5';

export interface GenerateQuestionParams {
  subject: Subject;          // "Math" | "Reading and Writing"
  examType: string;          // e.g. "Digital SAT" — passed straight through to assembleChoices
  domain: string;
  skill: string;
  difficulty: Difficulty;    // "Easy" | "Medium" | "Hard"
  studentLevel?: string;
  feedback?: string;         // present only on a retry
}

async function buildExemplarBlock(params: GenerateQuestionParams): Promise<string> {
  const exemplars = await retrieveExemplarQuestionsForGeneration({
    subject: params.subject,
    domain: params.domain,
    skill: params.skill,
    difficulty: params.difficulty,
    topK: 3,
  });

  if (!exemplars || exemplars.length === 0) return '';

  const exemplarContext = exemplars
    .map((ex: any, i: number) => {
      const choiceLines = (ex.choices ?? [])
        .map((c: any) => `    ${c.choice_id ?? c.id}: ${c.choice_text ?? c.text}`)
        .join('\n');
      return `Example ${i + 1}:\nQuestion: ${ex.question_text}\n${choiceLines}\nCorrect: ${ex.correct_answer}`;
    })
    .join('\n\n');

  return `\n\nGOLD STANDARD COLLEGE BOARD EXEMPLARS (MODEL YOUR QUESTION DRESS, RIGOR, AND STRUCTURE DIRECTLY AFTER THESE):\n${exemplarContext}\nINSTRUCTION: Match the exact sophistication, vocabulary density, sentence syntax, and mathematical complexity of the exemplars above. Do NOT copy the topic, but match the exact intellectual caliber.`;
}

function buildUserPrompt(params: GenerateQuestionParams, exemplarBlock: string): string {
  const { domain, skill, difficulty, studentLevel, feedback } = params;

  const feedbackBlock = feedback
    ? `\n\nCRITICAL FEEDBACK from a previous attempt: "${feedback}". You MUST resolve this and avoid repeating this exact issue.`
    : '';

  const studentLevelLine = studentLevel ? `\n- Student Level: ${studentLevel}` : '';

  return `Generate a new original ${difficulty}-tier question for the domain and skill below.
${feedbackBlock}

Specifications:
- Domain: ${domain}
- Skill: ${skill}${studentLevelLine}

Follow every rule in the system prompt exactly, including the required output schema. Return your answer only via the provided tool call.${exemplarBlock}`;
}

const GENERATE_QUESTION_TOOL = {
  name: 'generate_full_question',
  description:
    'Returns one fully drafted, solved, and distractor-equipped SAT question in a single structured object.',
  input_schema: {
    type: 'object' as const,
    properties: {
      passage_intro: { type: ['string', 'null'] },
      passage: { type: ['string', 'null'] },
      stimulus: { type: ['string', 'null'] },
      question_text: { type: 'string' },
      correct_answer: { type: 'string' },
      choices: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            choice_text: { type: 'string' },
            is_correct: { type: 'boolean' },
            rationale: { type: 'string' },
          },
          required: ['choice_text', 'is_correct', 'rationale'],
        },
      },
      solution: {
        type: 'object',
        properties: {
          step_by_step: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['step_by_step', 'explanation'],
      },
      verification: {
        type: ['object', 'null'],
        properties: {
          equation_lhs: { type: 'string' },
          equation_rhs: { type: 'string' },
          variable: {},       // string or string[]
          variable_value: {}, // number or number[]
        },
      },
    },
    required: ['question_text', 'correct_answer', 'choices', 'solution'],
  },
};

/**
 * Generates ONE complete question with a SINGLE Claude API call (instead
 * of the original 3 calls: draft -> solve -> distractors). Only the one
 * prompt file needed for this subject+difficulty is loaded via
 * promptSelector.ts - nothing else runs.
 */
export async function generateQuestionSingleCall(params: GenerateQuestionParams) {
  const systemPrompt = getSystemPromptForRequest(params.subject, params.difficulty);
  const exemplarBlock = await buildExemplarBlock(params);
  const userPrompt = buildUserPrompt(params, exemplarBlock);

  console.log(`[Generator] Calling model (single-call) with tool 'generate_full_question': ${GENERATOR_MODEL}`);
  const __callStart = Date.now();

  const response = await getAI().messages.create({
    model: GENERATOR_MODEL,
    max_tokens: 8192, // covers draft + solve + distractors in one output; raise if Hard Math truncates
    temperature: 0.6,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
    tools: [GENERATE_QUESTION_TOOL],
    tool_choice: { type: 'tool', name: 'generate_full_question' },
  });

  {
    const elapsedMs = Date.now() - __callStart;
    const usage = (response as any)?.usage || {};
    console.log(
      `[Generator][Metrics] 'generate_full_question' (single-call) took ${elapsedMs}ms — ` +
      `input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`
    );
  }

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return the expected tool call.');
  }

  const raw = toolUse.input as {
    passage_intro?: string | null;
    passage?: string | null;
    stimulus?: string | null;
    question_text: string;
    correct_answer: string;
    choices: Array<{ choice_text: string; is_correct: boolean; rationale: string }>;
    solution: { step_by_step: string; explanation: string };
    verification?: {
      equation_lhs: string;
      equation_rhs: string;
      variable: string | string[];
      variable_value: number | number[];
    } | null;
  };

  // Reshape the single merged response into the exact 3 objects the real,
  // now-exported assembleChoices() from generatorAgent.ts already expects
  // - this reuses your existing label-stripping / null-normalizing / dedup
  // / shuffle logic instead of duplicating it.
  const draft = {
    passage: raw.passage ?? null,
    stimulus: raw.stimulus ?? null,
    question_text: raw.question_text,
  };

  const solved = {
    exact_computed_answer: raw.correct_answer,
    step_by_step_solution: raw.solution.step_by_step,
    explanation: raw.solution.explanation,
    verification: raw.verification ?? undefined,
  };

  const wrong = {
    distractors: raw.choices
      .filter((c) => !c.is_correct)
      .map((c) => ({ choice_text: c.choice_text, rationale: c.rationale })),
  };

  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return assembleChoices(
    draft,
    solved,
    wrong,
    {
      subject: params.subject,
      domain: params.domain,
      skill: params.skill,
      difficulty: params.difficulty,
      examType: params.examType,
    },
    uniqueSuffix
  );
}