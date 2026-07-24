import Anthropic from '@anthropic-ai/sdk';
import getLangfuse from '../langfuse';

import { Question, PipelineStepLog, AnswerChoice } from '../../types';
import { retrieveExemplarQuestionsForGeneration, JSONQuestion } from '../rag/ragSystem';

let aiClient: Anthropic | null = null;

// ═══════════════════════════════════════════════════════════
// FUNCTION: Get Claude (Anthropic) AI Client
// ═══════════════════════════════════════════════════════════
function getAI(): Anthropic {
  if (!aiClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.warn("[Generator] ANTHROPIC_API_KEY is not set. Pipeline will run in fallback mode.");
    }
    aiClient = new Anthropic({
      apiKey: key || "DUMMY_KEY",
    });
  }
  return aiClient;
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Generate Content (Claude / Anthropic)
// ═══════════════════════════════════════════════════════════
// Single generator model. The Anthropic SDK retries transient 429/5xx errors
// automatically (max_retries defaults to 2), so no manual model-fallback loop
// or retry-delay parsing is needed here anymore.
const GENERATOR_MODEL = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 45000;

async function generateContentWithRetry(params: {
  // `staticPrompt` is the large, reusable chunk of the user message — specs,
  // RAG exemplars, schema/field rules — identical across every chunk of the
  // SAME batch call (and often across repeated batches for the same
  // domain/skill/difficulty, since RAG retrieval is deterministic). Marked
  // with a cache_control breakpoint so Anthropic caches it (~90% cheaper on
  // cache-hit re-reads within the ~5 min ephemeral TTL).
  staticPrompt: string;
  // `dynamicPrompt` is the small trailer that actually varies per call (the
  // "generate exactly N questions" instruction) — deliberately kept OUT of
  // the cached block so it never invalidates the cache.
  dynamicPrompt: string;
  systemPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<Anthropic.Message> {
  const ai = getAI();

  try {
    console.log(`[Generator] Calling model: ${GENERATOR_MODEL}`);

    // `timeout` is passed as a per-request option (2nd arg), same role as the
    // AbortController wrapper this replaces — the SDK aborts the underlying
    // HTTP request itself once the timeout elapses.
    //
    // `maxRetries: 0` — the Anthropic SDK retries transient errors internally
    // (default 2 retries = up to 3 attempts), and each attempt can take up
    // to REQUEST_TIMEOUT_MS. Left at the default, that silently stacks with
    // the pipeline's OWN attempt loop (runOrchestrationPipeline retries up to
    // max_attempts times, each of which calls this function again) — one
    // slow/rate-limited call could balloon to 3x45s here, times up to 3
    // pipeline attempts, which is what was blowing past a batch item's
    // 120s budget and making full-batch runs look "stuck" partway through.
    // The pipeline's retry loop already re-prompts with feedback on failure,
    // which is strictly more useful than a blind SDK-level retry of the same
    // request, so we let it own all retry/backoff decisions instead.
    //
    // PROMPT CACHING: both the system prompt and the static user-prompt block
    // carry a `cache_control: { type: 'ephemeral' }` breakpoint. Anthropic
    // caches everything from the start of the request up to (and including)
    // a breakpoint, so the system message is cached as its own layer (reused
    // across every call for this subject/exam type, regardless of
    // domain/skill), and the second breakpoint after the static user block
    // caches system+specs+exemplars together as one unit (reused across every
    // chunk of the current batch). Cache writes cost +25% the first time;
    // cache reads cost -90% on every subsequent hit within the ~5 min TTL —
    // net positive as soon as a prefix is reused even once.
    return await ai.messages.create(
      {
        model: GENERATOR_MODEL,
        max_tokens: params.maxOutputTokens || 8192,
        system: [
          {
            type: "text",
            text: params.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        temperature: params.temperature !== undefined ? params.temperature : 0.5,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: params.staticPrompt,
                cache_control: { type: "ephemeral" },
              },
              {
                type: "text",
                text: params.dynamicPrompt,
              },
            ],
          },
        ],
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
    );

  } catch (err: any) {
    const isTimeout = err?.name === "APIConnectionTimeoutError" || err?.name === "AbortError";
    if (isTimeout) {
      console.warn(`[Generator] Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    } else if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      console.error("[Generator] Authentication failed. Check ANTHROPIC_API_KEY.");
    } else {
      console.warn(`[Generator] Generation failed: ${err?.message || err}`);
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION 1: Build Exemplar Context
// ═══════════════════════════════════════════════════════════
function buildExemplarContext(exemplars: JSONQuestion[]): string {
  if (exemplars.length === 0) return '';

  return exemplars.map((ex, i) => {
    const choices = (ex.answer_choices || [])
      .map(c => `  ${c.choice_id}: ${c.choice_text}`)
      .join('\n');
    return `Example ${i + 1}:
Question: ${ex.question_text}
${choices}
Correct: ${ex.correct_answer}`;
  }).join('\n\n');
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION 1b: Detect graph-relevant Math domain/skill
// ═══════════════════════════════════════════════════════════
const GRAPH_KEYWORDS = [
  'graph', 'linear function', 'linear equation', 'quadratic', 'exponential',
  'polynomial', 'scatterplot', 'scatter plot', 'system of equations',
  'system of two', 'circle', 'parabola', 'coordinate', 'slope', 'intercept',
  'function', 'table', 'nonlinear',
];

function isGraphRelevantSkill(domain: string, skill: string): boolean {
  const haystack = `${domain} ${skill}`.toLowerCase();
  return GRAPH_KEYWORDS.some(kw => haystack.includes(kw));
}

// Interfaces for decoupled stages
interface ScenarioDraft {
  passage: string | null;
  stimulus: string | null;
  question_text: string;
}

interface SolvedScenario {
  exact_computed_answer: string;
  step_by_step_solution: string;
  explanation: string;
}

interface WrongChoices {
  distractors: Array<{
    choice_text: string;
    rationale: string;
  }>;
}

// Helper to match brackets for robust JSON cleanup
function findMatchingEnd(text: string, startIdx: number): number {
  const openCh = text[startIdx];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  let inString = false, escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Extracts valid JSON from model responses by matching brackets and repairing quotes/braces
function extractJSON(raw: string): string {
  let text = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const arrStart = text.indexOf('[');
  const objStart = text.indexOf('{');

  let isArray = false;

  if (arrStart !== -1 && (objStart === -1 || arrStart <= objStart)) {
    isArray = true;
    const end = findMatchingEnd(text, arrStart);
    text = end !== -1 ? text.slice(arrStart, end + 1) : text.slice(arrStart);
  } else if (objStart !== -1) {
    isArray = false;
    const end = findMatchingEnd(text, objStart);
    text = end !== -1 ? text.slice(objStart, end + 1) : text.slice(objStart);
  }

  {
    let result = '';
    let inStr = false, esc = false;
    for (const ch of text) {
      if (esc) { result += ch; esc = false; continue; }
      if (ch === '\\') { result += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; result += ch; continue; }
      if (ch === '\u2018' || ch === '\u2019') { result += "'"; continue; }
      if (ch === '\u201C' || ch === '\u201D') { result += inStr ? '\\"' : '"'; continue; }
      result += ch;
    }
    text = result;
  }
  let braces = 0, brackets = 0;
  let inString = false, escape = false;
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }

  if (isArray && braces > 0) {
    const lastCompleteObjEnd = text.lastIndexOf('}');
    if (lastCompleteObjEnd !== -1) {
      text = text.slice(0, lastCompleteObjEnd + 1);
      braces = 0; brackets = 0; inString = false; escape = false;
      for (const ch of text) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
    }
  }

  text += ']'.repeat(Math.max(0, brackets));
  text += '}'.repeat(Math.max(0, braces));

  if (!isArray) {
    text = `[${text}]`;
  }

  return text;
}

// Generic JSON execution helper using Claude API
async function callClaudeJSON<T>(systemPrompt: string, userPrompt: string, temperature = 0.2): Promise<T> {
  const staticPrompt = userPrompt;
  const dynamicPrompt = "Respond with ONLY a single valid JSON object. Do not include markdown formatting, backticks, or wrapping other than the JSON itself.";

  const response = await generateContentWithRetry({
    staticPrompt,
    dynamicPrompt,
    systemPrompt,
    temperature,
    maxOutputTokens: 2048,
  });

  const rawText = Array.isArray(response?.content)
    ? response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
    : '';

  if (!rawText) {
    throw new Error('[Generator] Received empty response from Claude API.');
  }

  const jsonText = extractJSON(rawText);
  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    console.error('[Generator] JSON parse failed inside callClaudeJSON. Raw text:', rawText);
    console.error('[Generator] Extracted JSON text:', jsonText);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// DECOUPLED STAGES
// ═══════════════════════════════════════════════════════════

// Stage 1: Draft the question context and statement only (no options or keys)
async function generateScenarioDraft(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  difficultyDefinition?: string;
  studentLevel?: string;
  feedback?: string;
  examType: string;
}, exemplarContext: string): Promise<ScenarioDraft> {
  const systemPrompt = `You are an expert ${params.examType} ${params.subject === 'Math' ? 'Math' : 'English/Reading'} question scenario writer.
Respond with ONLY a single valid JSON object containing passage, stimulus, and question_text. 
Do NOT generate answer choices, correct answers, keys, or solutions. Keep the scenario draft clean.`;

  const feedbackSection = params.feedback
    ? `\nCRITICAL FEEDBACK from previous attempt: "${params.feedback}". You MUST resolve this and avoid repeating this exact issue.\n`
    : '';

  const difficultyLine = params.difficultyDefinition
    ? `- Difficulty: ${params.difficulty} — ${params.difficultyDefinition}`
    : `- Difficulty: ${params.difficulty}`;

  const graphSection = (params.subject === 'Math' && isGraphRelevantSkill(params.domain, params.skill))
    ? `\nThis domain/skill supports graph/coordinate-geometry items. Describe any graph, lines, points, or coordinate curves in text detail inside "stimulus" without referencing a picture.\n`
    : '';

  const userPrompt = `Generate a new original ${params.examType} ${params.subject} question draft.
${feedbackSection}
Specifications:
- Domain: ${params.domain}
- Skill: ${params.skill}
${difficultyLine}
${params.studentLevel ? `- Student Level: ${params.studentLevel}` : ''}
${graphSection}${exemplarContext ? `\nStyle reference (do not copy, just match style):\n${exemplarContext}` : ''}

Respond with exactly this JSON format:
{
  "passage": "A reading passage if English/Reading, or null if stand-alone question",
  "stimulus": "Shared mathematical parameter, function definition, data table, coordinate description, or null if self-contained",
  "question_text": "The actual question being asked. Reference the stimulus if present."
}`;

  return await callClaudeJSON<ScenarioDraft>(systemPrompt, userPrompt, 0.6);
}

// Stage 2: Solve the scenario step-by-step
async function solveScenario(draft: ScenarioDraft, params: { subject: string; examType: string }): Promise<SolvedScenario> {
  const systemPrompt = `You are a strict, chief exam mathematical and textual solver.
Your task is to independently solve the question step-by-step and calculate the exact mathematical or textual answer.
You must respond with a single JSON object containing: step_by_step_solution, exact_computed_answer, and explanation.`;

  const userPrompt = `Solve the following exam question:
${draft.passage ? `Passage: ${draft.passage}\n` : ''}${draft.stimulus ? `Stimulus: ${draft.stimulus}\n` : ''}Question: ${draft.question_text}

Calculate the exact final numerical, fractional, or text-completion answer. Double check your arithmetic.
For math: if the result is a fraction, write it in simplified form (e.g. '10/3') or decimal (e.g. '1.5').

Respond with exactly this JSON format:
{
  "step_by_step_solution": "Show each step of your math or text logic clearly. Double-check all intermediate steps and calculations.",
  "exact_computed_answer": "The exact final solved value (e.g. '138.33', '10/3', '0.8', 'taciturn'). This MUST be short, precise, and directly answer the question_text.",
  "explanation": "A student-friendly rationale summarizing the correct reasoning."
}`;

  return await callClaudeJSON<SolvedScenario>(systemPrompt, userPrompt, 0.1);
}

// Stage 3: Generate distractors based on common student errors
async function generateWrongChoices(
  draft: ScenarioDraft,
  solved: SolvedScenario,
  params: { subject: string; examType: string }
): Promise<WrongChoices> {
  const systemPrompt = `You are an expert exam distractor options creator.
Your goal is to generate exactly 3 plausible wrong options that reflect common student errors, misconceptions, and calculation slips.
You must respond with a single JSON object containing: distractors.`;

  const mathGuidelines = `Strict Distractor Guidelines (Math):
1. Intermediate Step Trap (Half-Right): The value of an intermediate variable solved along the way (e.g., solving for x instead of the requested expression, or reporting x-intercept instead of y-intercept).
2. Conceptual Misconception: Applying an incorrect rule (e.g., setting the sum of angles to 360 instead of 180, multiplying instead of dividing, or using opposite operations).
3. Arithmetic / Sign Trap: The result of a minor calculation slip or sign flip (+/-).`;

  const englishGuidelines = `Strict Distractor Guidelines (English/Reading):
1. Plausible but unsupported by passage: Options using words from the passage but stating something unverified.
2. Too broad or too narrow.
3. Opposite or incorrect transition word.`;

  const userPrompt = `Based on the following question and correct solution:
${draft.passage ? `Passage: ${draft.passage}\n` : ''}${draft.stimulus ? `Stimulus: ${draft.stimulus}\n` : ''}Question: ${draft.question_text}
Correct Answer: ${solved.exact_computed_answer}
Step-by-Step Solution: ${solved.step_by_step_solution}

Generate exactly 3 wrong choices. Do NOT include the correct answer (${solved.exact_computed_answer}) in this list.
${params.subject === 'Math' ? mathGuidelines : englishGuidelines}

Respond with exactly this JSON format:
{
  "distractors": [
    {"choice_text": "Wrong value 1", "rationale": "Why students pick this (misconception)"},
    {"choice_text": "Wrong value 2", "rationale": "Why students pick this (calculation error)"},
    {"choice_text": "Wrong value 3", "rationale": "Why students pick this (intermediate trap)"}
  ]
}`;

  return await callClaudeJSON<WrongChoices>(systemPrompt, userPrompt, 0.5);
}

// Stage 4: Programmatic Choice Assembler (Deterministic)
function assembleChoices(
  draft: ScenarioDraft,
  solved: SolvedScenario,
  wrong: WrongChoices,
  params: { subject: string; domain: string; skill: string; difficulty: string; examType: string },
  uniqueSuffix: string
): Question {
  const computedAnswer = solved.exact_computed_answer.trim();
  const rawDistractors = wrong.distractors.map(d => d.choice_text.trim());

  // Deduplicate and filter out correct answer from distractors in case LLM slipped
  const uniqueDistractors = Array.from(new Set(rawDistractors))
    .filter(d => d !== computedAnswer)
    .slice(0, 3);

  // If we don't have enough distractors, fill in plausible placeholders
  while (uniqueDistractors.length < 3) {
    const backupVal = parseFloat(computedAnswer);
    if (!isNaN(backupVal)) {
      const offset = (uniqueDistractors.length + 1) * (backupVal > 10 ? 5 : 1);
      uniqueDistractors.push(String(backupVal + offset));
    } else {
      uniqueDistractors.push(`Option ${uniqueDistractors.length + 2}`);
    }
  }

  // Shuffle correct answer and distractors deterministically/randomly
  const allChoices = [computedAnswer, ...uniqueDistractors];
  
  // Custom shuffle function (Fisher-Yates)
  for (let i = allChoices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allChoices[i], allChoices[j]] = [allChoices[j], allChoices[i]];
  }

  const ids = ['A', 'B', 'C', 'D'];
  const answerChoices: AnswerChoice[] = allChoices.map((text, idx) => ({
    id: ids[idx],
    text,
  }));

  const correctLetter = ids[allChoices.indexOf(computedAnswer)] || 'A';

  const correctRationale = `Derivation:\n${solved.step_by_step_solution}\n\nExplanation:\n${solved.explanation}`;

  const distractorRationale: Record<string, string> = {};
  wrong.distractors.forEach((d) => {
    const matchedChoice = answerChoices.find(c => c.text === d.choice_text);
    if (matchedChoice) {
      distractorRationale[matchedChoice.id] = d.rationale;
    }
  });

  const questionId = `gen_${uniqueSuffix}`;

  const examSpecific: Record<string, any> = {
    exact_computed_answer: computedAnswer,
    step_by_step_solution: solved.step_by_step_solution,
  };

  return {
    question_id: questionId,
    exam_type: params.examType,
    section: params.subject,
    domain: params.domain,
    skill_tag: params.skill,
    difficulty: params.difficulty,
    passage: draft.passage,
    stimulus: draft.stimulus,
    question_text: draft.question_text,
    answer_choices: answerChoices,
    correct_answer: correctLetter,
    explanation: {
      correct_rationale: correctRationale,
      distractor_rationale: distractorRationale,
    },
    similarity_score: 0,
    similar_question_id: null,
    generation_attempt: 1,
    metadata: {
      created_at: new Date().toISOString(),
      model_version: GENERATOR_MODEL,
      config_version: `${params.examType.toLowerCase()}.json-v1`,
      exam_specific: examSpecific,
    },
    status: 'approved',
  };
}

// ═══════════════════════════════════════════════════════════
// Generate a single chunk sequentially via decoupled pipeline
// ═══════════════════════════════════════════════════════════
async function generateChunk(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  difficultyDefinition?: string;
  studentLevel?: string;
  feedback?: string;
  examType: string;
}, exemplarContext: string, chunkSize: number, trace?: any): Promise<Question[]> {
  const timestamp = Date.now();

  // 1. Parallel Stage 1: Drafting
  const draftPromises = Array.from({ length: chunkSize }, () =>
    generateScenarioDraft(params, exemplarContext)
  );
  const drafts = await Promise.all(draftPromises);

  // 2. Parallel Stage 2: Solving
  const solvePromises = drafts.map(draft =>
    solveScenario(draft, params)
  );
  const solvedList = await Promise.all(solvePromises);

  // 3. Parallel Stage 3: Distractors
  const wrongPromises = drafts.map((draft, idx) =>
    generateWrongChoices(draft, solvedList[idx], params)
  );
  const wrongList = await Promise.all(wrongPromises);

  // 4. Stage 4: Assembler (Synchronous)
  return drafts.map((draft, idx) => {
    const uniqueSuffix = `${timestamp}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
    return assembleChoices(draft, solvedList[idx], wrongList[idx], params, uniqueSuffix);
  });
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY POINT: Batch generation
// ═══════════════════════════════════════════════════════════
export async function runGeneratorAgent(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  difficultyDefinition?: string;
  studentLevel?: string;
  examType?: string;
  attempt?: number;
  onStep?: (log: PipelineStepLog) => void;
  feedback?: string;
  count?: number;       // total questions wanted, default 50
  chunkSize?: number;    // questions per Claude call, default 10
}): Promise<{ questions: Question[] }> {

  const {
    subject, domain, skill, difficulty, difficultyDefinition, attempt = 1, onStep, feedback,
    examType = 'SAT',
    count = 1,
    chunkSize = 1,
    studentLevel,
  } = params;

  // Initialize Langfuse Trace
  const trace = getLangfuse().trace({
    name: 'claude-question-generation',
    tags: [examType, subject],
    metadata: {
      domain,
      skill,
      difficulty,
      studentLevel,
      attempt,
      feedback: feedback ? 'yes' : 'no',
      count,
      chunkSize,
    },
  });

  onStep?.({
    timestamp: new Date().toISOString(),
    type: 'draft',
    message: `Generator Agent: Starting generation of ${count} question(s) for ${examType} ${subject} / ${domain} / ${skill} / ${difficulty}`,
  });

  // STEP 1: Retrieve exemplar questions (shared across all chunks)
  let exemplars: JSONQuestion[] = [];
  try {
    exemplars = await retrieveExemplarQuestionsForGeneration({
      subject,
      domain,
      skill,
      difficulty,
      topK: 3,
    });

    onStep?.({
      timestamp: new Date().toISOString(),
      type: 'rag_retrieval',
      message: `RAG: Retrieved ${exemplars.length} exemplar(s) for "${domain} / ${skill} / ${difficulty}".`,
    });

  } catch {
    onStep?.({
      timestamp: new Date().toISOString(),
      type: 'rag_retrieval',
      message: 'RAG: Skipped (unavailable). Using config-only generation.',
    });
  }

  const exemplarContext = buildExemplarContext(exemplars);

  // STEP 2: Split into chunks
  const chunkSizes: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    chunkSizes.push(size);
    remaining -= size;
  }

  onStep?.({
    timestamp: new Date().toISOString(),
    type: 'draft',
    message: `Generator Agent: Split into ${chunkSizes.length} chunk(s) of up to ${chunkSize} questions each.`,
  });

  // STEP 3: Generate each chunk sequentially
  const allQuestions: Question[] = [];
  const errors: string[] = [];

  for (let i = 0; i < chunkSizes.length; i++) {
    const size = chunkSizes[i];
    try {
      onStep?.({
        timestamp: new Date().toISOString(),
        type: 'draft',
        message: `Generator Agent: Requesting chunk ${i + 1}/${chunkSizes.length} (${size} questions)...`,
      });

      const chunkQuestions = await generateChunk(
        { subject, domain, skill, difficulty, difficultyDefinition, studentLevel: params.studentLevel, feedback, examType },
        exemplarContext,
        size,
        trace
      );

      if (chunkQuestions.length === 0) {
        errors.push(`Chunk ${i + 1} returned no valid questions.`);
      } else if (chunkQuestions.length < size) {
        onStep?.({
          timestamp: new Date().toISOString(),
          type: 'draft',
          message: `Generator Agent: Chunk ${i + 1} returned ${chunkQuestions.length}/${size} questions (partial — likely truncation).`,
        });
      }

      allQuestions.push(...chunkQuestions);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Chunk ${i + 1} failed: ${msg}`);
      onStep?.({
        timestamp: new Date().toISOString(),
        type: 'draft',
        message: `Generator Agent: Chunk ${i + 1}/${chunkSizes.length} failed — ${msg}`,
      });
    }
  }

  if (allQuestions.length === 0) {
    onStep?.({
      timestamp: new Date().toISOString(),
      type: 'finalize',
      message: `Generator Agent: Batch generation failed — no questions produced. Errors: ${errors.join(' | ')}`,
    });
    throw new Error(`Batch generation failed for all chunks: ${errors.join(' | ')}`);
  }

  onStep?.({
    timestamp: new Date().toISOString(),
    type: 'finalize',
    message: `Generator Agent: Batch generation complete. ${allQuestions.length}/${count} questions produced${errors.length ? ` (${errors.length} chunk error(s))` : ''}.`,
  });

  return { questions: allQuestions };
}