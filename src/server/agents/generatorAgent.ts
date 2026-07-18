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
    // Let the caller (pipeline) fall back to simulated mode on any hard failure.
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
// There's no image-rendering pipeline on the frontend (questions render as
// plain text), so "graph questions" here means: the model must build a
// precise, fully text-described coordinate-plane/graph/scatterplot scenario
// in "stimulus" that a student can reason about without seeing a picture —
// not literally emit an image. This just detects when that style of
// question is a natural fit for the requested domain/skill so we can nudge
// the model toward it instead of defaulting to purely algebraic phrasing.
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

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION 2: Build System Prompt (batch-aware)
// ═══════════════════════════════════════════════════════════
function buildSystemPromptForGenerator(subject: string, examType: string): string {
  const base = `You are an expert ${examType} ${subject === 'Math' ? 'Math' : 'English/Reading'} question generator.
Respond with ONLY a single valid JSON array — no markdown fences, no commentary, no trailing text.
Each element of the array must strictly follow the schema provided by the user.`;

  if (subject === 'Math') {
    return `${base}
Rules (apply to EVERY question in the array):
- Exactly 4 answer choices labelled A, B, C, D
- Exactly one correct answer
- All numbers and expressions must be mathematically accurate
- Distractors should reflect common student errors
- Questions should be unique and of very very high quality to the real examination type questions
- No two questions in the array may be near-duplicates of each other — vary the numbers, contexts, and phrasing

CALIBRATION — this is the most common failure mode, read carefully:
"Hard" on a real exam is NOT competition math, and it is NOT graduate-level math. It does not require calculus,
obscure theorems/identities, contrived multi-page algebra, deliberately ugly numbers, or notation outside the
standard high-school curriculum. A genuinely hard exam question uses the exact same toolbox as an easy one
(Algebra I/II, Geometry, basic trig/stats) — the difficulty comes from requiring the student to combine 2-3 of
those skills, spot a non-obvious first move, or navigate a wordier/more abstractly-framed setup, while still
being solvable by hand or basic calculator in about 90-120 seconds. If you find yourself reaching for content a
typical high schooler has never seen, or the arithmetic itself is the hard part, that is miscalibrated — simplify
the numbers/content and add reasoning depth instead. When difficulty = "Hard", follow the difficulty definition
given in the user prompt precisely rather than defaulting to "as hard as possible."

GRAPH / FIGURE QUESTIONS — there is no image renderer, so a "graph question" means the graph itself is fully
specified in words inside "stimulus," precisely enough that a student can reconstruct or reason about it with zero
ambiguity, exactly like a table-of-values or a defined function would be. When the domain/skill is graph-relevant
(e.g. linear/quadratic/exponential functions, systems of equations, scatterplots, circles, coordinate geometry),
prefer building the question around one of these instead of defaulting to pure symbol manipulation:
- A line or curve in the xy-plane: give it either as an equation, OR as a fully-described graph — e.g. "line k passes
  through the points (-2, 5) and (4, -1)" or "the graph of f is a parabola with vertex (3, -4) that opens upward and
  passes through (5, 0)."
- A scatterplot/data-in-a-graph: describe it as a small labelled table of (x, y) pairs plus, if relevant, the trend
  ("the data show an approximately linear relationship with a positive slope") — never say "as shown in the graph"
  without giving the actual values, since the student cannot see anything you didn't write out.
- A system graphed as two lines/curves: describe both precisely enough to find the intersection(s) if asked.
Never reference a figure, image, or graph the reader can't see ("the graph shown," "as pictured above") — every
number, point, label, and axis scale the student needs must be spelled out in "stimulus" itself.`;
  }
  return `${base}
Rules (apply to EVERY question in the array):
- Exactly 4 answer choices labelled A, B, C, D
- Exactly one correct answer
- Test reading comprehension, vocabulary, or grammar as appropriate
- Distractors should be plausible but clearly incorrect
- Questions should be unique and of very very high quality to the real examination type questions
- No two questions in the array may be near-duplicates of each other — vary the topics, contexts, and phrasing`;
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION 3: Build User Prompt (batch-aware, cache-split)
// ═══════════════════════════════════════════════════════════
// Split in two so the (large) invariant part can be sent as a cacheable
// content block:
//   - buildStaticUserPromptForGenerator: specs + exemplars + schema/field
//     rules. Does NOT mention `count` anywhere, so it is byte-for-byte
//     identical across every chunk of one batch call (chunkSize 1..N) —
//     this is the block we put behind a cache_control breakpoint.
//   - buildDynamicCountTrailer: the only part that changes per chunk (how
//     many questions to actually produce this call). Kept tiny and
//     uncached so it never busts the cache above it.
function buildStaticUserPromptForGenerator(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  difficultyDefinition?: string;
  studentLevel?: string;
  feedback?: string;
  examType: string;
}, exemplarContext: string): string {
  const exemplarSection = exemplarContext
    ? `\nSTYLE REFERENCE (similar difficulty/skill — do NOT copy, just match style):\n${exemplarContext}\n`
    : '';

  const feedbackSection = params.feedback
    ? `\nCRITICAL: A previous generation attempt failed validation with the following feedback:\n"${params.feedback}"\nYou MUST address this feedback, correct any errors, and ensure the new questions are high quality and completely free of the reported issues.\n`
    : '';

  const difficultyLine = params.difficultyDefinition
    ? `- Difficulty: ${params.difficulty} — ${params.difficultyDefinition}`
    : `- Difficulty: ${params.difficulty}`;

  const graphSection = (params.subject === 'Math' && isGraphRelevantSkill(params.domain, params.skill))
    ? `\nThis domain/skill naturally supports graph-based items. Include a healthy mix: at least some questions should center on a coordinate-plane graph, function graph, or scatterplot described in full detail inside "stimulus" (per the GRAPH / FIGURE QUESTIONS rules above), rather than making every question purely symbolic/algebraic.\n`
    : '';

  return `You will generate NEW, ORIGINAL, and DISTINCT ${params.examType} ${params.subject} questions.
${feedbackSection}
Specifications (apply to every question):
- Domain: ${params.domain}
- Skill: ${params.skill}
${difficultyLine}${params.studentLevel ? `\n- Student Level: ${params.studentLevel}` : ''}
${graphSection}${exemplarSection}
Each question must be a JSON object shaped exactly like this:
{
  "question_id": "gen_1",
  "exam": "${params.examType}",
  "subject": "${params.subject}",
  "domain": "${params.domain}",
  "skill": "${params.skill}",
  "difficulty": "${params.difficulty}",
  "passage": "... or null",
  "stimulus": "... or null",
  "question_text": "...",
  "answer_choices": [
    {"choice_id": "A", "choice_text": "..."},
    {"choice_id": "B", "choice_text": "..."},
    {"choice_id": "C", "choice_text": "..."},
    {"choice_id": "D", "choice_text": "..."}
  ],
  "correct_answer": "A",
  "explanation": "..."
}
Field rules for "passage" vs "stimulus" vs "question_text":
- "passage": a full reading passage the question is based on (Reading & Writing comprehension items). Use null if the item is a short standalone text-completion/grammar item where the sentence itself IS the question_text.
- "stimulus": any shared context the question refers to but that is NOT itself the question being asked — e.g. an equation, a defined function like "C(h) = 35h + 50", a data table, or a described graph/scenario. Use null only if the question is fully self-contained inside question_text (e.g. "If 3(x-4)=2(x+5)-7, what is x?").
- "question_text": the actual question being asked. When a "stimulus" is present, question_text should reference it (e.g. "According to the function, what does 35 represent?") rather than repeating it.`;
}

function buildDynamicCountTrailer(count: number): string {
  return `Now generate exactly ${count} such question(s), each internally consistent and non-repetitive relative to the others.
Respond with ONLY a JSON array of exactly ${count} objects — no markdown fences, no commentary, no trailing text.
Return: [ {...}, {...}, ... ] — exactly ${count} elements.`;
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION 4: Robust JSON extraction & repair
// Now array-aware: prefers the outer [ ... ], falls back to
// wrapping a single { ... } object in an array.
// ═══════════════════════════════════════════════════════════
// Finds the index of the bracket that actually closes the one at
// `startIdx` (i.e. proper depth-matching, ignoring bracket-like
// characters that appear inside string values). Returns -1 if the
// text is truncated mid-structure and no matching close exists.
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

function extractJSON(raw: string): string {
  let text = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Walk forward from the opening bracket and find the bracket that
  // ACTUALLY closes it (respecting strings/escapes), instead of blindly
  // grabbing the last '[' / '{' in the whole response. Using lastIndexOf
  // is what caused the intermittent "Unexpected non-whitespace character
  // after JSON" errors: if the model appends any trailing text containing
  // a stray ']' or '}' (commentary, a duplicated element, an interval like
  // "[0, 100]" inside an explanation), lastIndexOf would grab that instead
  // of the true end of the array, pulling in trailing garbage.
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

  // Replace smart/curly quotes with straight quotes — but only outside
  // string values. A blind global replace turns a curly quote that's part
  // of a passage's own text (e.g. quoting a word) into a bare unescaped "
  // in the middle of a JSON string, which breaks parsing. Inside a string,
  // convert to an escaped \" instead so the JSON stays valid.
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

  // If truncated mid-element inside an array, drop the last
  // incomplete element before closing, so JSON.parse doesn't choke.
  if (isArray && braces > 0) {
    const lastCompleteObjEnd = text.lastIndexOf('}');
    if (lastCompleteObjEnd !== -1) {
      text = text.slice(0, lastCompleteObjEnd + 1);
      // recount braces after trimming
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

function buildQuestionFromParsed(
  parsed: any,
  params: { subject: string; domain: string; skill: string; difficulty: string; examType: string; },
  uniqueSuffix: string
): Question {
  const questionId = parsed.question_id
    ? `gen_${uniqueSuffix}_${parsed.question_id}`
    : `gen_${uniqueSuffix}`;

  const answerChoices: AnswerChoice[] = (parsed.answer_choices || []).map((c: any) => ({
    id: c.choice_id || c.id || 'A',
    text: c.choice_text || c.text || '',
  }));

  return {
    question_id: questionId,
    exam_type: params.examType,
    // Use the exact section name the caller passed in (as defined in that
    // exam's config file) rather than assuming SAT's "Math"/"Reading and
    // Writing" naming — keeps this generic across exam configs.
    section: params.subject,
    domain: parsed.domain || params.domain,
    skill_tag: parsed.skill || params.skill,
    difficulty: parsed.difficulty || params.difficulty,
    passage: parsed.passage ?? null,
    stimulus: parsed.stimulus ?? null,
    question_text: parsed.question_text || '',
    answer_choices: answerChoices,
    correct_answer: parsed.correct_answer || 'A',
    explanation: {
      correct_rationale: parsed.explanation || '',
      distractor_rationale: {},
    },
    similarity_score: 0,
    similar_question_id: null,
    generation_attempt: 1,
    metadata: {
      created_at: new Date().toISOString(),
      model_version: GENERATOR_MODEL,
      config_version: `${params.examType.toLowerCase()}.json-v1`,
      exam_specific: {},
    },
    // NOTE: status is set to a provisional 'approved' here, but the
    // orchestration pipeline (runOrchestrationPipeline) always overwrites
    // this after independent validation — it only persists as 'approved'
    // if the validator actually passes the question.
    status: 'approved',
  };
}

function parseGeneratorBatchResponse(response: any, params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  examType: string;
}): Question[] {
  try {
    let rawText: string = Array.isArray(response?.content)
      ? response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
      : '';

    if (!rawText) {
      console.error('[Generator] No text in response');
      return [];
    }

    const jsonText = extractJSON(rawText);
    let parsedArray: any[];

    try {
      const parsed = JSON.parse(jsonText);
      parsedArray = Array.isArray(parsed) ? parsed : [parsed];
    } catch (parseErr) {
      console.error('[Generator] JSON parse failed after cleanup. Cleaned text (first 500 chars):');
      console.error(jsonText.slice(0, 500));
      throw parseErr;
    }

    const timestamp = Date.now();

    return parsedArray
      .filter(item => item && typeof item === 'object')
      .map((item, idx) => {
        const uniqueSuffix = `${timestamp}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
        return buildQuestionFromParsed(item, params, uniqueSuffix);
      });

  } catch (error) {
    console.error('[Generator] Error parsing batch response:', error);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// Generate a single chunk (internal — one Claude call, up to
// `chunkSize` questions)
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
  const systemPrompt = buildSystemPromptForGenerator(params.subject, params.examType);
  // Static block (specs + exemplars + schema) is identical across every
  // chunk of this batch — this is what gets the cache_control breakpoint.
  // Dynamic trailer (just the "generate exactly N" instruction) stays
  // outside the cache so it never busts it.
  const staticPrompt = buildStaticUserPromptForGenerator(params, exemplarContext);
  const dynamicPrompt = buildDynamicCountTrailer(chunkSize);

  // Rough token budget: ~250-350 tokens per question (question + 4 choices + explanation)
  const maxOutputTokens = Math.min(8192, Math.max(2048, chunkSize * 350));
  const generation = trace
    ? trace.generation({
      name: `generate-chunk-size-${chunkSize}`,
      model: GENERATOR_MODEL,
      modelParameters: {
        temperature: 0.5,
        max_tokens: maxOutputTokens,
      },
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${staticPrompt}\n\n${dynamicPrompt}` },
      ],
    })
    : null;
  try {
    const response = await generateContentWithRetry({
      staticPrompt,
      dynamicPrompt,
      systemPrompt,
      temperature: 0.5, // slightly higher than single-question mode to encourage variety across the batch
      maxOutputTokens,
    });

    // Quick sanity-check log: cache_read_input_tokens > 0 means this call
    // hit the cache written by a previous chunk/call (90% cheaper on that
    // many tokens). cache_creation_input_tokens > 0 means this call just
    // wrote a fresh cache entry (costs +25% on those tokens, one time).
    console.log(
      `[Generator] tokens — input:${response.usage?.input_tokens ?? 0} ` +
      `output:${response.usage?.output_tokens ?? 0} ` +
      `cache_write:${response.usage?.cache_creation_input_tokens ?? 0} ` +
      `cache_read:${response.usage?.cache_read_input_tokens ?? 0}`
    );

    // Update Langfuse on success. `usageDetails` (rather than the deprecated
    // `usage` shape) is what lets Langfuse's cost engine price the
    // cache-write and cache-read token buckets separately from normal
    // input/output tokens — without this split you'd see a token count but
    // an inflated/incorrect cost, since cached tokens are billed at
    // different rates than fresh ones.
    if (generation) {
      const u = response.usage;
      generation.end({
        output: response.content,
        usageDetails: {
          input: u?.input_tokens ?? 0,
          output: u?.output_tokens ?? 0,
          cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
        },
      });
    }

    return parseGeneratorBatchResponse(response, params);
  }
  catch (err: any) {
    // Log failure to Langfuse
    if (generation) {
      generation.end({
        statusMessage: err.message || String(err),
        level: 'ERROR',
      });
    }
    throw err;
  }
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

  // STEP 3: Generate each chunk sequentially (keeps quota/rate-limit
  // handling simple and predictable; bump concurrency later if needed)
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
      // continue to next chunk rather than aborting the whole batch
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