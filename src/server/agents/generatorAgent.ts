import Anthropic from '@anthropic-ai/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import getLangfuse from '../langfuse';

// Batch runs execute multiple runGeneratorAgent() calls concurrently in the
// SAME process (see BATCH_GENERATION_CONCURRENCY in pipeline.ts) — a plain
// module-level "current tag" variable would get overwritten across workers
// and every concurrent call would log the wrong tag. AsyncLocalStorage keeps
// the tag correctly scoped to each call's own async context instead.
const logTagStorage = new AsyncLocalStorage<string>();

function logPrefix(): string {
  const tag = logTagStorage.getStore();
  return tag ? `[${tag}] ` : '';
}

// Records a real Langfuse "generation" entry (with token usage) for one
// completed Claude API call. Without this, generatorAgent.ts only ever
// created a single top-level trace() per question with no generation
// events attached — Langfuse had no token counts to compute cost from, so
// every Claude call showed 0 cost / didn't show up as a generation at all
// (unlike validatorAgent.ts, which already does this correctly for its
// Gemini calls). `trace` is optional so callers that don't have one
// (or Langfuse itself misbehaving) never break actual generation.
function logClaudeGenerationToLangfuse(params: {
  trace?: any;
  name: string;
  systemPrompt: string;
  userPrompt: string;
  response: Anthropic.Message;
}): void {
  if (!params.trace) return;
  try {
    const generation = params.trace.generation({
      name: params.name,
      model: GENERATOR_MODEL,
      input: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
    });
    const usage = (params.response as any)?.usage || {};
    generation.end({
      output: params.response,
      usageDetails: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (e) {
    // Never let observability logging break real question generation.
    console.warn(`${logPrefix()}[Generator] Langfuse generation logging failed (non-fatal):`, e);
  }
}

import { Question, PipelineStepLog, AnswerChoice } from '../../types';
import { retrieveExemplarQuestionsForGeneration, JSONQuestion } from '../rag/ragSystem';
import { evaluate } from 'mathjs';

export function isMathEquivalent(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  try {
    const valA = evaluate(a);
    const valB = evaluate(b);
    if (typeof valA === 'number' && typeof valB === 'number' && !isNaN(valA) && !isNaN(valB)) {
      return Math.abs(valA - valB) < 0.0001;
    }
  } catch { /* not a simple scalar expression */ }
  return false;
}

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
// claude-3-5-sonnet-latest was retired by Anthropic and now returns a 404
// not_found_error on every call (see logs: "model: claude-3-5-sonnet-latest").
// That meant EVERY real generation attempt was silently falling back to the
// hardcoded getSimulatedQuestion() templates in pipeline.ts — which is why
// themes kept repeating (same handful of templates), the correct answer
// skewed toward A, distractors were weak, names were mostly English, and
// phrasing/punctuation felt repetitive: none of it was actually going
// through Claude. Pointing this at the current model fixes generation
// itself; it does not, by itself, change prompt-level behavior (see the
// distractor/diversity prompt updates in this same file for that).
const GENERATOR_MODEL = "claude-sonnet-5";
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
    console.log(`${logPrefix()}[Generator] Calling model: ${GENERATOR_MODEL}`);

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
    // claude-sonnet-5 rejects the `temperature` param entirely (400:
    // "temperature is deprecated for this model") — this model line no
    // longer exposes sampling temperature as a request option, so we omit
    // it and let the API use its own default rather than erroring on every
    // single call.
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
  verification?: {
    equation_lhs: string;
    equation_rhs: string;
    // Single-variable equations use a plain string/number (e.g. 'x', 6).
    // Multi-variable systems (e.g. "Linear equations in two variables")
    // use parallel arrays instead (e.g. ['x','y'], [6, 2]) so
    // mathSanityCheck.ts can build a scope with every symbol the equation
    // actually references, rather than throwing "Undefined symbol y".
    variable: string | string[];
    variable_value: number | number[];
  } | null;
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
async function callClaudeJSON<T>(systemPrompt: string, userPrompt: string, temperature = 0.2, trace?: any, name = 'generate-json'): Promise<T> {
  const staticPrompt = userPrompt;
  const dynamicPrompt = "Respond with ONLY a single valid JSON object. Do not include markdown formatting, backticks, or wrapping other than the JSON itself.";

  const response = await generateContentWithRetry({
    staticPrompt,
    dynamicPrompt,
    systemPrompt,
    temperature,
    maxOutputTokens: 2048,
  });

  logClaudeGenerationToLangfuse({ trace, name, systemPrompt, userPrompt, response });

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

// Generic JSON execution helper using Claude API with forced Tool Calling Schema
async function callClaudeWithTool<T>(
  systemPrompt: string,
  userPrompt: string,
  toolName: string,
  toolDescription: string,
  inputSchema: Anthropic.Tool.InputSchema,
  temperature = 0.2,
  trace?: any,
  maxTokens = 8192
): Promise<T> {
  const ai = getAI();

  console.log(`${logPrefix()}[Generator] Calling model with tool '${toolName}': ${GENERATOR_MODEL}`);
  // Same as generateContentWithRetry above — claude-sonnet-5 400s on any
  // `temperature` value, so it's omitted here too.
  //
  // IMPORTANT: this call is intentionally NOT wrapped in a try/catch that
  // falls back to callClaudeJSON. It used to be — ANY error here (a 429
  // rate-limit, a 5xx, a timeout, an auth failure) silently triggered a
  // SECOND Claude API call (the text-JSON fallback) with zero delay. Under
  // rate-limiting that's the worst possible response: it doubles the
  // request rate at exactly the moment the API is asking you to slow down,
  // which is what was burning through quota so fast. Real errors now
  // propagate up to runOrchestrationPipeline's attempt loop, which is the
  // single place that decides whether/how to retry (see the backoff added
  // there). The text-JSON fallback below is reserved ONLY for the case
  // where the call actually succeeded but the model didn't return a
  // tool_use block — a real (if rare, since tool_choice forces it)
  // "model didn't cooperate" case, not a network/rate-limit case.
  const response = await ai.messages.create(
    {
      model: GENERATOR_MODEL,
      max_tokens: maxTokens,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: toolName,
          description: toolDescription,
          input_schema: inputSchema,
        },
      ],
      tool_choice: { type: "tool", name: toolName },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
  );

  // If the model hit the max_tokens cap mid-way through generating the
  // tool call, response.content still contains a tool_use block — but its
  // `input` can be a truncated/partial object (a field cut off mid-string,
  // or missing entirely). Nothing downstream ever checked this, so a
  // truncated question_text like "A rental company charges" (no question
  // asked, no punctuation) sailed straight through checkQuestionCompleteness
  // (which only checked for empty string) and even past the validator.
  // Treat max_tokens as a failure and let the pipeline's normal retry path
  // handle it, instead of silently using partial content.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `[Generator] Claude call for '${toolName}' was truncated (stop_reason=max_tokens, max_tokens=${maxTokens}) — the tool input is likely incomplete. Retrying instead of using partial content.`
    );
  }

  const toolUseBlock = response.content.find((b: any) => b.type === "tool_use");
  if (toolUseBlock && "input" in toolUseBlock) {
    logClaudeGenerationToLangfuse({ trace, name: toolName, systemPrompt, userPrompt, response });
    return toolUseBlock.input as T;
  }

  logClaudeGenerationToLangfuse({ trace, name: `${toolName}-no-tool-use`, systemPrompt, userPrompt, response });
  console.warn(`[Generator] Model call for '${toolName}' succeeded but returned no tool_use block. Falling back to text JSON parser.`);
  return callClaudeJSON<T>(systemPrompt, userPrompt, temperature, trace, `${toolName}-fallback`);
}

// Schemas for tool calling enforcement
const SCENARIO_DRAFT_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    passage_intro: { type: "string", description: "1-line context introduction sentence (e.g. 'The following excerpt is from...')" },
    passage: { type: ["string", "null"], description: "Reading passage text if English/Reading. Omit this field entirely, or set it to JSON null, for stand-alone questions — never the string \"null\"." },
    stimulus: { type: ["string", "null"], description: "Mathematical data table with preamble, shared parameters. Omit this field entirely, or set it to JSON null, if there is none — never the string \"null\"." },
    question_text: { type: "string", description: "The actual formal, unambiguous question prompt being asked." },
  },
  required: ["question_text"],
};

const SOLVED_SCENARIO_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    exact_computed_answer: { type: "string", description: "The exact final solved numerical or text value." },
    step_by_step_solution: { type: "string", description: "Detailed step-by-step mathematical or textual derivation." },
    explanation: { type: "string", description: "Student-friendly explanation of the correct logic." },
    verification: {
      type: ["object", "null"],
      description:
        "OPTIONAL, math only: one or more checkable equations that become true when exact_computed_answer is substituted in. " +
        "Provide this whenever the question reduces to a clean equation or system of equations (e.g. a linear/quadratic equation, " +
        "a formula plug-in, or a two-variable system like 'linear equations in two variables'). Omit it (or set null) for geometry, " +
        "word problems without one clean equation, or non-numeric/text answers — the Validator will review those instead. " +
        "equation_lhs/equation_rhs must be plain math-expression strings evaluable by a calculator (e.g. '2*x + 3*y', '15'). " +
        "Do NOT use function notation like 'f(x)', 'g(x)', or 'f(3)' in equation_lhs/equation_rhs — substitute the underlying algebraic expression (e.g. '3*x - 12') instead. " +
        "For a SINGLE variable, set 'variable' to a string (e.g. 'x') and 'variable_value' to a number matching " +
        "exact_computed_answer. For a SYSTEM WITH MULTIPLE VARIABLES (e.g. x and y), set 'variable' to an array of the " +
        "variable names (e.g. ['x','y']) and 'variable_value' to an array of their numeric values in the SAME ORDER " +
        "(e.g. [6, 2]) — both arrays must be the same length.",
      properties: {
        equation_lhs: { type: "string", description: "Left-hand side expression, e.g. '2*x + 3*y'." },
        equation_rhs: { type: "string", description: "Right-hand side expression, e.g. '15'." },
        variable: {
          description: "Either a single variable name (string) or an array of variable names for a multi-variable system.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        variable_value: {
          description: "Either a single numeric value (matches a scalar 'variable') or an array of numeric values in the same order as 'variable'.",
          anyOf: [
            { type: "number" },
            { type: "array", items: { type: "number" } },
          ],
        },
      },
    },
  },
  required: ["exact_computed_answer", "step_by_step_solution", "explanation"],
};

const WRONG_CHOICES_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    distractors: {
      type: "array",
      description: "Array of exactly 3 plausible distractor objects.",
      items: {
        type: "object",
        properties: {
          choice_text: { type: "string", description: "Wrong choice text" },
          rationale: { type: "string", description: "Why a student might fall into this misconception" },
        },
        required: ["choice_text", "rationale"],
      },
    },
  },
  required: ["distractors"],
};

// ═══════════════════════════════════════════════════════════
// DECOUPLED STAGES
// ═══════════════════════════════════════════════════════════
const DIVERSE_ACADEMIC_TOPICS = [
  "Astrophysics & Exoplanet Atmospheric Spectroscopy",
  "Urban Architecture & Passive Solar Building Design",
  "Cognitive Linguistics & Spatial Metaphor Processing",
  "Marine Biology & Deep-Sea Hydrothermal Vent Ecosystems",
  "Archaeology & Chemical Isotope Analysis of Ancient Pottery",
  "Volcanology & Pre-eruption Magmatic Pressure Signals",
  "Ethnomusicology & Microtonal Rhythms in Central Asian Folk Music",
  "Paleontology & Dinosaur Bone Microstructure Histology",
  "Agricultural Economics & Drought-Resilient Cereal Yields",
  "Glaciology & Antarctic Subglacial Lake Water Chemistry",
  "Neuroscience & Hippocampal Memory Consolidation",
  "History of Science & Renaissance Navigational Astrolabes",
  "Mycology & Mycelial Soil Nutrient Transfer Networks",
  "Literary Criticism & Narrative Voice in Modernist Fiction",
  "Quantum Optics & Entangled Photon Cryptography",
  "Sociology of Technology & Remote Work Team Dynamics",
  "Botany & Desert Ephemeral Plant Germination Cues",
  "Microbiology & Extremophile Enzyme Heat Resistance",
  "Environmental Anthropology & Traditional Water Management Systems",
  "Art History & Venetian Renaissance Pigment Trade Routes",
  "Acoustics & Bioacoustic Mapping of Rainforest Canopy Birds",
  "Behavioral Economics & Choice Architecture in Public Health",
  "Seismology & Tectonic Fault Stress Accumulation Models",
  "Linguistics & Endangered Indigenous Language Revitalization",
  "Genomics & Comparative Epigenetic Adaptation in Alpine Species"
];

// Domain-specific techniques rotated per-generation for mathematical variety
const MATH_CONSTRUCTION_TECHNIQUES_NONLINEAR = [
  "factoring out a common monomial before cancellation",
  "difference of squares",
  "difference/sum of cubes",
  "grouping (factor by pairs)",
  "completing the square",
  "a quadratic-in-disguise substitution (e.g. u = x^2)",
  "polynomial long division leaving a clean remainder",
  "multiplying numerator and denominator by a conjugate",
  "combining like terms after distributing a negative sign",
  "cross-multiplying a proportion to clear denominators",
];

const MATH_CONSTRUCTION_TECHNIQUES_LINEAR = [
  "two-variable linear system with real-world rate constraints",
  "standard form Ax + By = C with integer intercepts",
  "slope-intercept form from two coordinate pairs",
  "linear equation with fractional coefficients cleared by LCD",
  "parallel or perpendicular line slope relationship",
  "linear function modeling a fixed fee plus variable rate",
];

const MATH_CONSTRUCTION_TECHNIQUES_GEOMETRY = [
  "circle equation (x - h)^2 + (y - k)^2 = r^2 with completing the square",
  "similar triangles with proportional side ratios",
  "right triangle with standard Pythagorean triple (e.g., 3-4-5, 5-12-13, 8-15-17)",
  "sector area or arc length with radian/degree measure",
  "parallel lines cut by a transversal with alternate interior angles",
];

const MATH_CONSTRUCTION_TECHNIQUES_DATA = [
  "two-way frequency table conditional probability or ratio",
  "exponential growth or decay model with percentage rate",
  "weighted average / mean calculation from grouped data",
  "linear regression line of best fit slope interpretation",
  "margin of error and sample size relationship",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

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
  topicSeed?: string;
}, exemplarContext: string, trace?: any): Promise<ScenarioDraft> {
  const isEnglish = params.subject.toLowerCase().includes('reading') || params.subject.toLowerCase().includes('writing') || params.subject.toLowerCase().includes('english');
  const chosenTopic = params.topicSeed || DIVERSE_ACADEMIC_TOPICS[Math.floor(Math.random() * DIVERSE_ACADEMIC_TOPICS.length)];

  const englishQualityRules = isEnglish ? `
STRICT READING & WRITING QUALITY RULES:
1. Passage Context Introduction: Provide a 1-line "passage_intro" context sentence (e.g. "The following excerpt is from...", "The following passage is adapted from a 2024 article by...").
2. High Academic & Vocabulary Standard: Use dense, scholarly prose matching elevated SAT reading standards.
3. Diverse Introductions: NEVER start with repetitive phrases like "Scientists say" or "Researchers say". Use diverse academic stems.
4. Formal Analytical Language: NEVER use informal/subjective phrasing like "The text talks about". Use formal analytical verbs: "The author argues...", "The passage suggests...", "The text indicates...".
5. Natural Fill-in-the-Blank Positioning: Spread fill-in-the-blank "___" positions throughout the passage, NOT exclusively at the final sentence.
6. Multicultural Diversity: Use researcher and character names from diverse global backgrounds.
7. ABSOLUTE CONTEXT DIVERSITY: Feature a completely unique, fresh academic subject. Do NOT repeat mangrove forests, Dr. Amara Osei-Bonsu, or any previously repeated themes.
8. CRITICAL: DO NOT INCLUDE CHOICES IN QUESTION_TEXT: Under NO circumstances list answer options (A, B, C, D) inside "question_text".
` : '';

  // Math never had an equivalent rule set — only English did. This is the
  // primary reason Math questions were escalating far more than English:
  // the zero-tolerance "correctness" and "difficulty_alignment" checks
  // depend entirely on the SCENARIO drafted here being internally
  // consistent (one defensible answer, all values stated, clean numbers,
  // a solvable/consistent system) — a flaw introduced at this stage can't
  // be fixed by the solver or distractor stages downstream, it just
  // propagates into a failed validation (or a local mathSanityCheck
  // mismatch) and forces a full extra attempt. These 8 rules target
  // exactly those failure modes.
  const mathQualityRules = (params.subject === 'Math') ? `
STRICT MATH INTERNAL-CONSISTENCY & RIGOR RULES (violating these is the #1 cause of rejection/escalation — follow exactly):
1. Single Defensible Answer: Before finalizing, mentally solve the problem yourself using ONLY the values/relationships stated in "stimulus"/"question_text". There must be exactly ONE numeric/algebraic answer under normal real-number, principal-value conventions. If your own solve produces an extraneous root, an undefined case, or more than one valid answer, change the numbers/setup until there is exactly one.
2. All Given Values Explicit: Every number, variable, and relationship needed to solve the problem must be explicitly stated in "stimulus"/"question_text". Never require the solver to assume an unstated value.
3. UNIVERSAL BACKWARD CONSTRUCTION FOR HARD MATH:
   - For Systems of Equations: Choose the clean integer solution first (e.g., x = 4, y = -1), then construct two linear equations that intersect at that exact point.
   - For Quadratics / Polynomials: Choose the clean roots or vertex first (e.g., roots x = 2, x = -5), then expand a(x-2)(x+5) to form the polynomial.
   - For Rational Expressions & Identities: Choose the target simplified form first, then multiply numerator and denominator by common factors.
   - For Geometry & Trigonometry: Use standard Pythagorean triples (3-4-5, 5-12-13, 8-15-17) or standard special angles (30°, 45°, 60°) to guarantee clean integer/fractional values.
4. Clean Numbers by Default: The final answer and all intermediate values should be clean (whole numbers, simple fractions, or terminating decimals to at most 2 places) UNLESS the skill specifically calls for approximation — in which case explicitly instruct "round to the nearest ___" in the question_text.
5. No Padding Complexity: Do not add extra variables, steps, or unusual notation just to look harder — difficulty must come from the reasoning/insight required (see the difficulty definition below), never from arithmetic grind.
6. Consistent Systems: For any system of equations/relationships, verify by hand that it has exactly one consistent solution (not zero, not infinite) before finalizing — unless "no solution"/"infinite solutions" is itself the skill being tested.
7. Match the Stated Difficulty Exactly: Re-read the difficulty definition below and ensure the REASONING DEPTH, not just the topic, matches it — an Easy question must be solvable in one direct step; do not disguise a Medium/Hard concept as Easy, or pad an Easy concept into fake Hard complexity.
8. Geometry/Graphs: State all given measurements, angles, or coordinates numerically and explicitly in the text — never rely on a figure "looking a certain way" or an unstated visual assumption.
9. Identities/Equivalent-Expressions — BUILD BACKWARDS, NEVER FORWARDS: For any question asking to identify an equivalent form, complete an identity, or find constants that make two expressions equal (e.g. "(6x²+x-12)/(2x²-9x+10) is equivalent to (3x+a)/(x+b) for what value of a+b?"), you MUST construct it by starting from the TARGET simplified form, picking its constants first, then multiplying/expanding OUTWARD to build the original complex expression — so the identity is true by construction.
10. Strict Linearity / Degree Adherence: If the skill is "Linear equations" (in one or two variables), all equations MUST be strictly degree 1 (e.g., Ax + By = C or y = mx + b). NEVER introduce degree-2, degree-4, or substitution polynomials (like u = x^2) into linear equation items.
` : '';


  // Pure symbolic-manipulation math skills (identities, equivalent
  // expressions, factoring) have no real-world "topic" to vary — the thing
  // that actually needs to vary across attempts is the ALGEBRAIC
  // CONSTRUCTION TECHNIQUE used, or every regeneration converges on the
  // same handful of templates (this is what caused two consecutive
  // similarity-check failures, one scoring a near-exact 1.0, against the
  // very same skill). Rotated the same way DIVERSE_ACADEMIC_TOPICS is for
  // real-world scenario framing.
  const domainLower = (params.domain || '').toLowerCase();
  const skillLower = (params.skill || '').toLowerCase();

  let techniquesList = MATH_CONSTRUCTION_TECHNIQUES_NONLINEAR;
  if (domainLower.includes('algebra') || skillLower.includes('linear')) {
    techniquesList = MATH_CONSTRUCTION_TECHNIQUES_LINEAR;
  } else if (domainLower.includes('geometry') || domainLower.includes('trigonometry') || skillLower.includes('circle') || skillLower.includes('triangle') || skillLower.includes('angle')) {
    techniquesList = MATH_CONSTRUCTION_TECHNIQUES_GEOMETRY;
  } else if (domainLower.includes('problem-solving') || domainLower.includes('data') || skillLower.includes('ratio') || skillLower.includes('probability') || skillLower.includes('stat')) {
    techniquesList = MATH_CONSTRUCTION_TECHNIQUES_DATA;
  }

  const mathTechniqueSeed = techniquesList[
    Math.abs(hashString(`${params.skill}:${Date.now()}:${Math.random()}`)) % techniquesList.length
  ];
  const mathDiversitySection = (params.subject === 'Math')
    ? `\nSTRUCTURAL VARIETY: For this attempt, base the underlying mathematical construction on: ${mathTechniqueSeed}. (This only dictates the TECHNIQUE/structure used to build the expression — the actual numbers/constants must still be freshly chosen, not copied from any example.)\n`
    : '';

  const systemPrompt = `You are an expert ${params.examType} ${params.subject === 'Math' ? 'Math' : 'English/Reading'} question scenario writer.
You must call the 'create_scenario_draft' tool.
${englishQualityRules}${mathQualityRules}`;

  const isMathRetry = params.subject === 'Math' && params.feedback;
  const feedbackSection = params.feedback
    ? isMathRetry
      ? `\nCRITICAL RETRY INSTRUCTION: The previous attempt failed verification with feedback: "${params.feedback}". RETAIN the general narrative scenario/context from before if appropriate, and surgically fix the mathematical equations, constants, and derivation so they balance cleanly with exact integer/fractional solutions.\n`
      : `\nCRITICAL FEEDBACK from previous attempt: "${params.feedback}". You MUST resolve this and avoid repeating this exact issue.\n`
    : '';

  const difficultyLine = params.difficultyDefinition
    ? `- Difficulty: ${params.difficulty} — ${params.difficultyDefinition}`
    : `- Difficulty: ${params.difficulty}`;

  const graphSection = (params.subject === 'Math' && isGraphRelevantSkill(params.domain, params.skill))
    ? `\nThis domain/skill supports graph/coordinate-geometry items. Describe any graph, lines, points, or coordinate curves in text detail inside "stimulus" without referencing a picture.\n`
    : '';

  const exemplarHeader = exemplarContext
    ? `\nGOLD STANDARD COLLEGE BOARD EXEMPLARS (MODEL YOUR QUESTION DRESS, RIGOR, AND STRUCTURE DIRECTLY AFTER THESE):
${exemplarContext}
INSTRUCTION: Match the exact sophistication, vocabulary density, sentence syntax, and mathematical complexity of the exemplars above. Do NOT copy the topic, but match the exact intellectual caliber.\n`
    : '';

  const universalNoEmbeddedChoicesRule = `
CRITICAL — NEVER EMBED ANSWER CHOICES IN THE QUESTION ITSELF: "question_text" and "stimulus" must NEVER
list, enumerate, or spell out the answer options (no "A) ...", "B) ...", labeled candidate
equations/values, or an inline list of choices anywhere in them). The four answer choices are
generated and displayed SEPARATELY by a later stage — if you also write them into
question_text/stimulus, the student will see every option twice. This applies even to question
types that conventionally present multiple candidate values/equations/statements (e.g. "which of
the following equations represents...", "which choice completes the text...") — phrase the
question so it stands alone WITHOUT listing the candidates (e.g. "Which equation represents the
line shown?" rather than "Which of the following — A) y=2x+1 B) y=3x+1... — represents the line
shown?"). The actual candidate values belong only in the separate answer-choices step, never here.
`;

  // Applies to EVERY subject, not just English — this seed exists so
  // successive generations (English passages AND Math word problems alike)
  // don't all reach for the same handful of default contexts. Pure
  // symbolic-algebra skills (identities, factoring) have no natural
  // real-world framing, so the wording makes it optional for those rather
  // than excluding Math from it entirely — it still applies to the large
  // share of Math domains (Problem-Solving & Data Analysis, applied Algebra
  // word problems, etc.) that DO use real-world scenarios.
  const topicLine = `- Suggested real-world topic/context angle: ${chosenTopic}. ${isEnglish
    ? 'Use this to frame the passage/stimulus.'
    : 'Use this to frame the scenario if the skill involves a real-world word problem (most Algebra/Problem-Solving/Data-Analysis questions do); for a purely symbolic/algebraic-identity question with no natural real-world framing, you may stay abstract instead — do not force an awkward fit.'
    }\n`;

  const userPrompt = `Generate a new original high-rigor ${params.examType} ${params.subject} question draft.
${feedbackSection}
Specifications:
- Domain: ${params.domain}
- Skill: ${params.skill}
${difficultyLine}
${topicLine}${params.studentLevel ? `- Student Level: ${params.studentLevel}` : ''}
${graphSection}${mathDiversitySection}${universalNoEmbeddedChoicesRule}${exemplarHeader}`;

  return await callClaudeWithTool<ScenarioDraft>(
    systemPrompt,
    userPrompt,
    "create_scenario_draft",
    "Creates a formal SAT question scenario draft with passage_intro, passage, stimulus, and question_text",
    SCENARIO_DRAFT_SCHEMA,
    0.6,
    trace
  );
}

// Stage 2: Solve the scenario step-by-step
async function solveScenario(draft: ScenarioDraft, params: { subject: string; examType: string }, trace?: any): Promise<SolvedScenario> {
  const systemPrompt = `You are a strict, chief exam mathematical and textual solver.
Your task is to independently solve the question step-by-step and calculate the exact mathematical or textual answer.
You must call the 'solve_scenario' tool.`;

  const userPrompt = `Solve the following exam question:
${draft.passage ? `Passage: ${draft.passage}\n` : ''}${draft.stimulus ? `Stimulus: ${draft.stimulus}\n` : ''}Question: ${draft.question_text}

Calculate the exact final numerical, fractional, or text-completion answer.
${params.subject === 'Math' ? `MANDATORY STEP-BY-STEP VERIFICATION:
1. Show each algebraic transformation explicitly in "step_by_step_solution".
2. Substitute the final computed value back into the original problem statement/equations to prove both sides balance.
3. If the computed value does not yield exact equality, discard and re-solve before outputting "exact_computed_answer".
Do not submit an answer you have not verified this way.` : 'Double check your reasoning against the passage text before finalizing.'}
For math: if the result is a fraction, write it in simplified form (e.g. '10/3') or decimal (e.g. '1.5').

CRITICAL FORMATTING RULE for "exact_computed_answer": output ONLY the raw value itself
(e.g. 'y = 2.5x + 5' or '3/4' or '12'). NEVER prefix it with an answer-choice letter or
label (e.g. "A) ", "B) ", "Option C:") — this field is compared programmatically against
the answer choices and any such prefix will corrupt that mapping. If the draft's stimulus
happens to reference lettered options (it shouldn't — flag this in step_by_step_solution if
so), still report only the raw solved value here, never a letter/label.

${params.subject === 'Math' ? `If this question reduces to one clean, calculator-checkable equation, also fill in
"verification" with that equation (equation_lhs, equation_rhs, variable, variable_value) so
your answer can be double-checked deterministically — variable_value must match
exact_computed_answer numerically. If the question involves a SYSTEM with multiple unknowns
(e.g. "linear equations in two variables"), set "variable" to an array of all the variable
names involved (e.g. ["x","y"]) and "variable_value" to an array of their numeric values in
the same order (e.g. [6, 2]) — do NOT omit "verification" just because there is more than
one variable.IMPORTANT: Never use function notation like "f(x)" or "g(t)" in equation_lhs/equation_rhs; write the actual algebraic expression (e.g. "3*x - 12") so mathjs can calculate it without undefined symbol errors.
 Omit "verification" entirely only for geometry or anything without one clean,
checkable equation.` : ''}`;

  return await callClaudeWithTool<SolvedScenario>(
    systemPrompt,
    userPrompt,
    "solve_scenario",
    "Solves the exam scenario step-by-step and computes exact answer",
    SOLVED_SCENARIO_SCHEMA,
    0.0,
    trace,
    // solve_scenario's output (step_by_step_solution + explanation +
    // verification) is the most token-heavy of the three tool calls — this
    // is the one that was hitting the old 4096-token cap mid-generation
    // (see log: "Claude call for 'solve_scenario' was truncated"), burning
    // a full pipeline attempt for free. Give it more headroom than the
    // 8192 default the other two calls use implicitly.
    12288
  );
}

// Stage 3: Generate distractors based on common student errors
async function generateWrongChoices(
  draft: ScenarioDraft,
  solved: SolvedScenario,
  params: { subject: string; examType: string; difficulty?: string },
  trace?: any
): Promise<WrongChoices> {
  const systemPrompt = `You are an expert exam distractor options creator.
Your goal is to generate exactly 3 plausible wrong options calibrated strictly to the requested difficulty level (${params.difficulty || 'Medium'}).
You must call the 'generate_wrong_choices' tool.`;

  const mathGuidelines = `Strict Distractor Guidelines (Math):
1. Intermediate Step Trap (Half-Right): Solve for an intermediate variable along the way (e.g., solving for x instead of the requested expression 2x+1, or reporting the x-intercept instead of the y-intercept).
2. Conceptual Misconception: Apply a common student error (e.g., setting the sum of angles to 360 instead of 180, using diameter instead of radius, or adding exponents during addition).
3. Arithmetic / Sign Trap: The result of a single calculation slip or sign flip (+/-) from the real derivation.
4. MANDATORY CHECK — No Secondary-Correct Answers: Before finalizing each distractor, verify it does NOT also satisfy the original question under any reasonable reading (e.g. it isn't an unstated root, a rounding/formatting variant, or an equivalent expression). Every distractor must be genuinely wrong.`;

  const englishGuidelines = `Strict Distractor Guidelines (English/Reading - Calibrated to ${params.difficulty || 'Medium'} difficulty):
- EASY DIFFICULTY: 1 clearly incorrect choice, 2 plausible choices that are slightly off-topic or misinterpret clear passage facts.
- MEDIUM DIFFICULTY: High-plausibility distractors based on partial text reading, misinterpreted scope, or evidence misattribution.
- HARD DIFFICULTY: Deeply subtle traps using exact words/phrases from the passage to make an unstated or subtly opposite claim, overgeneralization, cause-and-effect inversion, or plausible half-truths that fail a specific prompt condition.
- ALWAYS use formal, objective academic phrasing matching SAT vocabulary standards.`;

  // Same defensive strip as assembleChoices — prevents a stray "B) " prefix
  // leaking out of solveScenario from also contaminating this prompt, which
  // would otherwise cause the distractor model to mimic the same bad format.
  const rawSafeAnswer = solved?.exact_computed_answer || (solved as any)?.exact_answer || (solved as any)?.computed_answer || (solved as any)?.answer || '';
  const safeAnswer = String(rawSafeAnswer).replace(/^\s*(?:[A-D]|Option [A-D])[).:]\s*/i, '').trim();
  const safeSolution = solved?.step_by_step_solution || '';

  const userPrompt = `Based on the following question and correct solution:
${draft.passage ? `Passage: ${draft.passage}\n` : ''}${draft.stimulus ? `Stimulus: ${draft.stimulus}\n` : ''}Question: ${draft.question_text}
Correct Answer: ${safeAnswer}
Step-by-Step Solution: ${safeSolution}

Generate exactly 3 wrong choices. Do NOT include the correct answer (${safeAnswer}) in this list.
${params.subject === 'Math' ? mathGuidelines : englishGuidelines}

CRITICAL FORMATTING RULE for "choice_text": output ONLY the raw distractor value itself
(e.g. 'y = 2.5x + 2.5'), never prefixed with an answer-choice letter or label like "A) ",
"B) ", "Option C:", etc. — these are assembled into lettered choices programmatically
afterward, so any embedded letter prefix will corrupt the final answer key.`;

  return await callClaudeWithTool<WrongChoices>(
    systemPrompt,
    userPrompt,
    "generate_wrong_choices",
    "Generates 3 calibrated distractor choices with student error rationales",
    WRONG_CHOICES_SCHEMA,
    0.5,
    trace
  );
}

// Stage 4: Programmatic Choice Assembler (Deterministic)
function assembleChoices(
  draft: ScenarioDraft,
  solved: SolvedScenario,
  wrong: WrongChoices,
  params: { subject: string; domain: string; skill: string; difficulty: string; examType: string },
  uniqueSuffix: string
): Question {
  // Defensive strip: the generator model occasionally leaks a stray answer-choice
  // letter/label into exact_computed_answer or a distractor's choice_text (e.g.
  // "B) y = 2.5x + 5" instead of just "y = 2.5x + 5"), which corrupts the letter
  // → choice_text → correct_answer mapping below and causes the Validator to fail
  // the question every time for the same structural reason. Strip it here as a
  // safety net regardless of how well the prompts (see solveScenario /
  // generateWrongChoices) manage to prevent it upstream.
  const stripChoiceLabel = (s: string): string =>
    s.replace(/^\s*(?:[A-D]|Option [A-D])[).:]\s*/i, '').trim();

  // Defensive normalizer: even with the schema now correctly typed as
  // ["string","null"], guard against the model still emitting the literal
  // string "null" (or an empty/whitespace value) for passage/stimulus —
  // these should render as no passage/stimulus at all, not a "null" box.
  const cleanNullable = (v?: string | null): string | null =>
    !v || v.trim().toLowerCase() === 'null' ? null : v;

  const rawAnswer = solved?.exact_computed_answer || (solved as any)?.exact_answer || (solved as any)?.computed_answer || (solved as any)?.answer || '';
  const computedAnswer = stripChoiceLabel(String(rawAnswer)) || 'Option A';

  const distList: any[] = Array.isArray(wrong?.distractors)
    ? wrong.distractors
    : Array.isArray((wrong as any)?.wrong_choices)
      ? (wrong as any).wrong_choices
      : Array.isArray((wrong as any)?.options)
        ? (wrong as any).options
        : Array.isArray((wrong as any)?.choices)
          ? (wrong as any).choices
          : [];
  const rawDistractors: string[] = distList.map((d: any) => {
    const txt = d?.choice_text || d?.text || d || '';
    return stripChoiceLabel(String(txt));
  }).filter(Boolean);

  // Deduplicate and filter out correct answer from distractors in case LLM slipped
  const uniqueDistractors: string[] = Array.from(new Set(rawDistractors))
    .filter(d => !isMathEquivalent(d, computedAnswer))
    .slice(0, 3);

  // If we don't have enough distractors, fill in plausible placeholders
  while (uniqueDistractors.length < 3) {
    const backupVal = parseFloat(computedAnswer);
    if (!isNaN(backupVal)) {
      const offset = (uniqueDistractors.length + 1) * (backupVal > 10 ? 5 : 1);
      const candidate = String(backupVal + offset);
      if (!uniqueDistractors.includes(candidate)) {
        uniqueDistractors.push(candidate);
      } else {
        uniqueDistractors.push(String(backupVal - offset));
      }
    } else if (computedAnswer.includes('=')) {
      // Equation distractor variant (flip sign or adjust constant)
      const modified = computedAnswer.replace(/([+-])\s*(\d+)/, (_, sign, num) =>
        `${sign === '+' ? '-' : '+'} ${parseInt(num, 10) + uniqueDistractors.length + 1}`
      );
      uniqueDistractors.push(modified !== computedAnswer && !uniqueDistractors.includes(modified) ? modified : `${computedAnswer} + ${uniqueDistractors.length + 1}`);
    } else {
      uniqueDistractors.push(`${computedAnswer} (alternate ${uniqueDistractors.length + 1})`);
    }
  }

  // Shuffle correct answer and distractors deterministically/randomly
  const allChoices: string[] = [computedAnswer, ...uniqueDistractors];

  // Custom shuffle function (Fisher-Yates)
  for (let i = allChoices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allChoices[i], allChoices[j]] = [allChoices[j], allChoices[i]];
  }

  const ids = ['A', 'B', 'C', 'D'];
  const answerChoices: AnswerChoice[] = allChoices.map((text: string, idx) => ({
    id: ids[idx],
    text,
  }));

  const correctLetter = ids[allChoices.indexOf(computedAnswer)] || 'A';

  const correctRationale = `Derivation:\n${solved?.step_by_step_solution || ''}\n\nExplanation:\n${solved?.explanation || ''}`;

  const distractorRationale: Record<string, string> = {};
  distList.forEach((d: any) => {
    // Same defensive strip used to build uniqueDistractors/answerChoices above —
    // without it, a stray "B) " prefix here would silently break the match
    // against the already-stripped answerChoices text and drop the rationale.
    const choiceText = stripChoiceLabel(String(d?.choice_text || d?.text || d || ''));
    const matchedChoice = answerChoices.find(c => c.text === choiceText);
    if (matchedChoice) {
      distractorRationale[matchedChoice.id] = d?.rationale || 'Plausible distractor trap.';
    }
  });

  const questionId = `gen_${uniqueSuffix}`;

  const examSpecific: Record<string, any> = {
    exact_computed_answer: computedAnswer,
    step_by_step_solution: solved?.step_by_step_solution || '',
  };
  if (
    solved?.verification &&
    solved.verification.equation_lhs &&
    solved.verification.equation_rhs &&
    solved.verification.variable &&
    solved.verification.variable_value !== undefined
  ) {
    examSpecific.verification = solved.verification;
  }

  const rawQuestionText = draft?.question_text || '';
  const questionText = rawQuestionText.trim();

  return {
    question_id: questionId,
    exam_type: params.examType,
    section: params.subject,
    domain: params.domain,
    skill_tag: params.skill,
    difficulty: params.difficulty,
    passage: cleanNullable(draft?.passage),
    stimulus: cleanNullable(draft?.stimulus),
    question_text: questionText,
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
  const draftPromises = Array.from({ length: chunkSize }, (_, idx) => {
    const topicSeed = DIVERSE_ACADEMIC_TOPICS[(timestamp + idx) % DIVERSE_ACADEMIC_TOPICS.length];
    return generateScenarioDraft({ ...params, topicSeed }, exemplarContext, trace);
  });
  const drafts = await Promise.all(draftPromises);

  // 2. Parallel Stage 2: Solving
  const solvePromises = drafts.map(draft =>
    solveScenario(draft, params, trace)
  );
  const solvedList = await Promise.all(solvePromises);

  // 3. Parallel Stage 3: Distractors
  const wrongPromises = drafts.map((draft, idx) =>
    generateWrongChoices(draft, solvedList[idx], params, trace)
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
  onStep?: (log: PipelineStepLog) => void | Promise<void>;
  feedback?: string;
  count?: number;       // total questions wanted, default 50
  chunkSize?: number;    // questions per Claude call, default 10
  logTag?: string;       // question_id (or similar) to prefix console logs with, so concurrent batch workers are distinguishable in the log stream
}): Promise<{ questions: Question[] }> {

  const {
    subject, domain, skill, difficulty, difficultyDefinition, attempt = 1, onStep, feedback,
    examType = 'SAT',
    count = 1,
    chunkSize = 1,
    studentLevel,
    logTag,
  } = params;

  return logTagStorage.run(logTag || '', () => runGeneratorAgentInner(params));
}

async function runGeneratorAgentInner(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  difficultyDefinition?: string;
  studentLevel?: string;
  examType?: string;
  attempt?: number;
  onStep?: (log: PipelineStepLog) => void | Promise<void>;
  feedback?: string;
  count?: number;
  chunkSize?: number;
  logTag?: string;
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

  await onStep?.({
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

    await onStep?.({
      timestamp: new Date().toISOString(),
      type: 'rag_retrieval',
      message: `RAG: Retrieved ${exemplars.length} exemplar(s) for "${domain} / ${skill} / ${difficulty}".`,
    });

  } catch {
    await onStep?.({
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

  await onStep?.({
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
      await onStep?.({
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
        await onStep?.({
          timestamp: new Date().toISOString(),
          type: 'draft',
          message: `Generator Agent: Chunk ${i + 1} returned ${chunkQuestions.length}/${size} questions (partial — likely truncation).`,
        });
      }

      allQuestions.push(...chunkQuestions);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Chunk ${i + 1} failed: ${msg}`);
      await onStep?.({
        timestamp: new Date().toISOString(),
        type: 'draft',
        message: `Generator Agent: Chunk ${i + 1}/${chunkSizes.length} failed — ${msg}`,
      });
    }
  }

  if (allQuestions.length === 0) {
    await onStep?.({
      timestamp: new Date().toISOString(),
      type: 'finalize',
      message: `Generator Agent: Batch generation failed — no questions produced. Errors: ${errors.join(' | ')}`,
    });
    throw new Error(`Batch generation failed for all chunks: ${errors.join(' | ')}`);
  }

  await onStep?.({
    timestamp: new Date().toISOString(),
    type: 'finalize',
    message: `Generator Agent: Batch generation complete. ${allQuestions.length}/${count} questions produced${errors.length ? ` (${errors.length} chunk error(s))` : ''}.`,
  });

  return { questions: allQuestions };
}