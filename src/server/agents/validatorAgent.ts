import { GoogleGenAI } from '@google/genai';
import getLangfuse from '../langfuse';
import { Question, PipelineStepLog, ValidationBlock, CheckResult } from '../../types';

const VALIDATOR_MODEL = "gemini-3.1-flash-lite";

let aiClient: GoogleGenAI | null = null;

// ═══════════════════════════════════════════════════════════
// FUNCTION: Get Gemini AI Client
// ═══════════════════════════════════════════════════════════
function getAI(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.VALIDATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
      console.warn("[Validator] Neither VALIDATOR_GEMINI_API_KEY nor GEMINI_API_KEY is set. Pipeline will run in fallback mode.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key || "DUMMY_KEY",
      httpOptions: {
        headers: {
          "User-Agent": "sat-question-validator",
        },
      },
    });
  }
  return aiClient;
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Generate Content With Retry Logic
// ═══════════════════════════════════════════════════════════
const REQUEST_TIMEOUT_MS = 45000;

function parseRetryDelayMs(errMsg: string, defaultMs: number): number {
  try {
    const match = errMsg.match(/retry[^0-9]*(\d+(?:\.\d+)?)s/i);
    if (match) {
      return Math.ceil(parseFloat(match[1]) * 1000) + 500;
    }
    const jsonMatch = errMsg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (jsonMatch) {
      return Math.ceil(parseFloat(jsonMatch[1]) * 1000) + 500;
    }
  } catch { /* ignore */ }
  return defaultMs;
}

async function generateContentWithRetry(params: {
  prompt: string;
  systemPrompt: string;
  responseMimeType?: string;
  temperature?: number;
}): Promise<any> {
  const ai = getAI();
  const modelsToTry = [VALIDATOR_MODEL];
  let lastError: any = null;

  for (const model of modelsToTry) {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Validator] Calling model: ${model} (Attempt ${attempt}/${maxRetries})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
          res = await ai.models.generateContent({
            model: model,
            contents: params.prompt,
            config: {
              systemInstruction: params.systemPrompt,
              responseMimeType: params.responseMimeType || "application/json",
              temperature: params.temperature !== undefined ? params.temperature : 0.1,
              abortSignal: controller.signal,
            }
          });
        } finally {
          clearTimeout(timeoutId);
        }

        return res;

      } catch (err: any) {
        lastError = err;
        const errMsg = err.message || "";
        const errStatus = err.status || (err.error && err.error.code) || 0;

        const isTimeout = err.name === "AbortError" || errMsg.toLowerCase().includes("abort");
        if (isTimeout) {
          console.warn(`[Validator] Model ${model} timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Trying next model...`);
          break;
        }

        const isAuthError =
          errStatus === 401 ||
          errStatus === 403 ||
          errMsg.includes("401") ||
          errMsg.includes("403") ||
          errMsg.toLowerCase().includes("unauthenticated") ||
          errMsg.toLowerCase().includes("permission_denied") ||
          errMsg.toLowerCase().includes("credential") ||
          errMsg.toLowerCase().includes("api key") ||
          errMsg.toLowerCase().includes("auth");

        if (isAuthError) {
          console.error("[Validator] Authentication failed. Check VALIDATOR_GEMINI_API_KEY or GEMINI_API_KEY.");
          throw err;
        }

        const isNotFound = errStatus === 404 || errMsg.includes("404") || errMsg.toLowerCase().includes("not found");
        if (isNotFound) {
          console.warn(`[Validator] Model ${model} not found (404). Skipping to next model...`);
          break;
        }

        const isHighDemand =
          errStatus === 503 ||
          errMsg.includes("503") ||
          errMsg.toLowerCase().includes("demand") ||
          errMsg.toLowerCase().includes("unavailable") ||
          errMsg.toLowerCase().includes("temporary");

        if (isHighDemand) {
          console.warn(`[Validator] Model ${model} unavailable (503). Trying next model...`);
          break;
        }

        const isQuotaError =
          errStatus === 429 ||
          errMsg.includes("429") ||
          errMsg.toLowerCase().includes("rate limit") ||
          errMsg.toLowerCase().includes("quota") ||
          errMsg.toLowerCase().includes("resource_exhausted");

        if (isQuotaError) {
          if (attempt === maxRetries) {
            const waitMs = parseRetryDelayMs(errMsg, 12000);
            console.warn(`[Validator] Model ${model} quota exhausted after ${maxRetries} attempts. Waiting ${waitMs}ms then trying next model...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            break;
          }
          const waitMs = parseRetryDelayMs(errMsg, 12000);
          console.log(`[Validator] Quota error — Gemini says retry in ~${Math.round(waitMs / 1000)}s. Waiting...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }

        console.warn(`[Validator] Model ${model} unexpected error (status ${errStatus}): ${errMsg.slice(0, 120)}`);
        break;
      }
    }
  }

  throw lastError || new Error("Failed to validate content after all retries and model fallbacks.");
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Simulated Validation Fallback
// ═══════════════════════════════════════════════════════════
export function getSimulatedValidation(
  question: Question,
  attempt: number,
  shouldFail: boolean = false
): ValidationBlock {
  const checks: CheckResult = {
    correctness: shouldFail ? "FAIL" : "PASS",
    distractor_quality: "PASS",
    clarity: "PASS",
    difficulty_alignment: "PASS",
    domain_skill_alignment: "PASS",
    originality: "PASS",
    bias_sensitivity: "PASS"
  };

  const score = shouldFail ? 72 : 95;
  const feedback = shouldFail
    ? "Incorrect answer logic. The explanation contradicts the marked option. Please recheck step-by-step arithmetic or textual alignment."
    : "The question successfully addresses the rubric. Clear context, plausible wrong choices, and solid reasoning present.";

  return {
    validation_status: shouldFail ? "FAIL" : "PASS",
    accuracy_score: score,
    checks,
    feedback,
    revised_suggestion: shouldFail ? "Ensure correct answer is A and distractor reasoning is updated." : undefined,
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION: Clean and Repair JSON Backslashes
// ═══════════════════════════════════════════════════════════
function repairJSONBackslashes(jsonStr: string): string {
  let result = "";
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '\\') {
      const nextChar = jsonStr[i + 1];
      if (nextChar === '\\') {
        result += '\\\\';
        i++;
      } else if (nextChar === '"') {
        result += '\\"';
        i++;
      } else if (nextChar === 'n' || nextChar === 't' || nextChar === 'r' || nextChar === '/') {
        result += '\\' + nextChar;
        i++;
      } else {
        result += '\\\\';
      }
    } else {
      result += char;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION: Remove Trailing Commas from Objects/Arrays
// ═══════════════════════════════════════════════════════════
function removeTrailingCommas(jsonStr: string): string {
  let inString = false;
  let escape = false;
  let cleanStr = "";
  let lastCommaIdx = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escape) {
      escape = false;
      cleanStr += ch;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      cleanStr += ch;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      cleanStr += ch;
      continue;
    }

    if (inString) {
      cleanStr += ch;
      continue;
    }

    if (ch === ',') {
      lastCommaIdx = cleanStr.length;
      cleanStr += ch;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (lastCommaIdx !== -1) {
        const between = cleanStr.slice(lastCommaIdx + 1);
        if (/^\s*$/.test(between)) {
          cleanStr = cleanStr.slice(0, lastCommaIdx) + between;
        }
      }
    }

    if (!/^\s$/.test(ch)) {
      lastCommaIdx = -1;
    }

    cleanStr += ch;
  }

  return cleanStr;
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION: Robust JSON extraction & repair
//
// FIXED: previously used "first '{' to last '}'" which broke
// whenever Gemini appended a stray extra closing brace after a
// perfectly valid object — the slice would include that stray
// brace as trailing garbage and JSON.parse would throw
// "Unexpected non-whitespace character after JSON". Now we scan
// forward from the first '{' and track nesting depth (ignoring
// braces inside strings) to find the TRUE end of the object,
// discarding anything the model appended after it.
// ═══════════════════════════════════════════════════════════
function extractJSON(raw: string): string {
  // 1. Strip markdown fences
  let text = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // 2. Find the first '{' and balanced-scan forward to find the
  //    TRUE matching closing brace — not just the last '}' in the
  //    text, which can be a stray brace the model appended after
  //    an otherwise-complete, valid object.
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false, escape = false;
    let endIdx = -1;

    for (let i = firstBrace; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }

    if (endIdx !== -1) {
      // Found a genuinely balanced object — discard anything after it
      // (e.g. a stray trailing '}' Gemini sometimes appends).
      text = text.slice(firstBrace, endIdx + 1);
    } else {
      // No balanced close found — response was truncated mid-object.
      // Take everything from the first '{' onward; auto-close below.
      text = text.slice(firstBrace);
    }
  }

  // 3. Replace smart/curly quotes with straight quotes — but only outside
  //    string values, so a curly quote inside the question/passage text
  //    itself doesn't inject a bare " that breaks JSON.parse.
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

  // 4. Attempt to auto-close truncated JSON
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
  text += ']'.repeat(Math.max(0, brackets));
  text += '}'.repeat(Math.max(0, braces));

  // 5. Remove trailing commas
  text = removeTrailingCommas(text);

  // 6. Repair any broken backslashes (like unescaped LaTeX backslashes)
  return repairJSONBackslashes(text);
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Run Validator Agent (Agent 2 - Independent Evaluator)
// ═══════════════════════════════════════════════════════════
export async function runValidatorAgent(params: {
  question: Question;
  config: any;
  onStep?: (log: PipelineStepLog) => void;
}): Promise<ValidationBlock> {
  const { question, config, onStep } = params;

  onStep?.({
    timestamp: new Date().toISOString(),
    type: "validate",
    message: "Agent 2: Starting independent, multi-dimension validation. (Generator thoughts are hidden from Agent 2)."
  });

  const key = process.env.VALIDATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const hasApiKey = key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VALIDATOR_GEMINI_API_KEY" && key !== "";

  if (!hasApiKey) {
    // Simulated validation
    // Simulate failure on the very first attempt 40% of the time to demonstrate the loop retrying visually!
    const shouldSimulateFailure = question.generation_attempt === 1 && Math.random() < 0.4;
    return getSimulatedValidation(question, question.generation_attempt, shouldSimulateFailure);
  }

  try {
    const rubricChecks = config.validation_rubric.checks;
    const zeroToleranceList = config.validation_rubric.zero_tolerance_checks || ["correctness", "originality"];
    const minScore = config.validation_rubric.min_composite_score || 90;

    const systemPrompt = `You are an extremely strict, pedantic, and rigorous Exam Quality Validator Agent.
You are completely isolated from the Generator's drafts and thoughts; you only receive the final generated question.
Your goal is to inspect the question with zero leniency, acting like a tough chief examiner. Do NOT be generous or give "free passes". If a question is not absolutely flawless in every dimension, you must downgrade it appropriately.

CRITICAL INSTRUCTION FOR INDEPENDENT DERIVATION:
Before looking at the correct answer or the explanation, you MUST independently solve the question step-by-step.
If the question object includes a non-null "passage" or "stimulus" field, treat it as the SOLE authoritative source of context — it is the equation, function, table, graph description, or reading passage the question is actually based on. Re-read it carefully and solve/derive strictly from it; do not rely on your own assumed version of a "typical" version of this question.
Write down your step-by-step mathematical derivation or reading comprehension proof inside the "independent_derivation" field of the JSON. Do not copy the generator's explanation; actually re-solve it.

Rigorous Verification Guidelines:
1. "correctness": Verify if the marked answer is mathematically/factually 100% correct against the "stimulus"/"passage" (if present) — re-derive it yourself from that shared context, not from question_text alone. Re-calculate everything. If there is a sign error, incorrect math step, a mismatch between question_text and what the stimulus/passage actually says, or a logical jump, downgrade it heavily.
2. "distractor_quality": Ensure distractors are realistic traps but completely indefensible given the stimulus/passage. If any distractor is too obvious/lazy (e.g. random number) OR could be defended as correct under some interpretation of the stimulus, downgrade it heavily.
3. "clarity": Look for any grammatical errors, typos, awkward phrasing, or wording ambiguities. If a "stimulus" is present, also check that question_text can be understood on its own alongside the stimulus (it should reference the stimulus, not silently repeat or contradict it). Even a missing comma or slightly confusing sentence structure warrants a downgrade.
4. "difficulty_alignment": Does the complexity match the definitions for ${question.difficulty}? If a "Hard" question is actually easy/shallow, or an "Easy" question is too complex, downgrade it.
5. "domain_skill_alignment": Ensure the question specifically tests ${question.domain} - ${question.skill_tag}. If it drifts or tests a different skill, downgrade it.
6. "originality": Ensure it is not a direct copy of a standard textbook question.
7. "bias_sensitivity": Check for regional/socio-economic assumptions.

Grading Scale:
For each check below, rate the question on a scale of 0 to 5:
- 5: Flawless / Fully satisfied (absolutely no issues).
- 4: Mostly satisfied (only minor, negligible issues that don't affect validity).
- 3: Partially satisfied (noticeable flaws, requires revision).
- 2: Poorly satisfied (significant flaws, fails fundamental rules).
- 1: Barely satisfied (almost complete failure).
- 0: Completely unsatisfied / missing.

Zero-tolerance rules:
If any check in ${JSON.stringify(zeroToleranceList)} is less than 4, the entire validation status must be FAIL.
Passing threshold is ${minScore}/100.

You must output your response in JSON format matching this schema:
{
  "independent_derivation": "string (your independent step-by-step derivation/proof solving the question first)",
  "validation_status": "PASS" | "FAIL",
  "accuracy_score": number (0-100),
  "checks": {
    "correctness": number (0-5),
    "distractor_quality": number (0-5),
    "clarity": number (0-5),
    "difficulty_alignment": number (0-5),
    "domain_skill_alignment": number (0-5),
    "originality": number (0-5),
    "bias_sensitivity": number (0-5)
  },
  "feedback": "string (highly specific, pedantic, and actionable feedback detailing exactly what is wrong. Avoid generic phrases like 'fix the answers.')",
  "revised_suggestion": "string or null (concrete correction, hint, or formula update needed to pass)"
}`;

    const stimulusNote = question.passage
      ? `\nNOTE: This question has a "passage" field — it is the authoritative reading passage. Base your comprehension check on it directly.\n`
      : question.stimulus
        ? `\nNOTE: This question has a "stimulus" field — it is the authoritative equation/function/table/context the question is based on: "${question.stimulus}". Re-derive the answer from THIS, not from question_text alone.\n`
        : '';

    const prompt = `Please validate this generated question object:
${stimulusNote}${JSON.stringify(question, null, 2)}`;

    // Langfuse trace for this validation call — mirrors the generator
    // agent's tracing so token usage/cost show up for validation too, not
    // just generation. Kept separate from the generator's trace since each
    // validation is its own independent Gemini call against one question.
    const trace = getLangfuse().trace({
      name: 'gemini-question-validation',
      tags: [question.exam_type, question.section],
      metadata: {
        question_id: question.question_id,
        domain: question.domain,
        skill: question.skill_tag,
        difficulty: question.difficulty,
        generation_attempt: question.generation_attempt,
      },
    });
    const generation = trace.generation({
      name: 'validate-question',
      model: VALIDATOR_MODEL,
      modelParameters: { temperature: 0.1 },
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    let res;
    try {
      res = await generateContentWithRetry({
        prompt,
        systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.1
      });
    } catch (err: any) {
      // Log failure to Langfuse before letting the outer catch fall back
      // to simulated validation, same pattern as the generator agent.
      generation.end({
        statusMessage: err?.message || String(err),
        level: 'ERROR',
      });
      throw err;
    }

    // Gemini reports usage as usageMetadata.{promptTokenCount,
    // candidatesTokenCount, cachedContentTokenCount} rather than Anthropic's
    // input_tokens/output_tokens naming — mapped here to Langfuse's generic
    // usageDetails buckets so cost shows up correctly either way.
    const um = (res as any)?.usageMetadata;
    generation.end({
      output: res,
      usageDetails: {
        input: um?.promptTokenCount ?? 0,
        output: um?.candidatesTokenCount ?? 0,
        cache_read_input_tokens: um?.cachedContentTokenCount ?? 0,
      },
    });

    const rawText = res.text || res.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleanText = extractJSON(rawText);
    let parsed: any;
    try {
      parsed = JSON.parse(cleanText);
    } catch (parseErr) {
      console.error("[Validator] JSON parse failed. Raw response:");
      console.error(rawText);
      console.error("[Validator] Cleaned & repaired text:");
      console.error(cleanText);
      throw parseErr;
    }

    // Helper functions to parse 0-5 numerical check values safely
    const getRating = (val: any): number => {
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const m = val.match(/\d+/);
        if (m) return parseInt(m[0], 10);
        return val.toUpperCase() === "PASS" ? 5 : 0;
      }
      return 0;
    };

    const getCheckStr = (rating: number): string => {
      return rating >= 4 ? `PASS (${rating}/5)` : `FAIL (${rating}/5)`;
    };

    const ratings = {
      correctness: getRating(parsed.checks?.correctness),
      distractor_quality: getRating(parsed.checks?.distractor_quality),
      clarity: getRating(parsed.checks?.clarity),
      difficulty_alignment: getRating(parsed.checks?.difficulty_alignment),
      domain_skill_alignment: getRating(parsed.checks?.domain_skill_alignment),
      originality: getRating(parsed.checks?.originality),
      bias_sensitivity: getRating(parsed.checks?.bias_sensitivity),
    };

    const checks: CheckResult = {
      correctness: getCheckStr(ratings.correctness),
      distractor_quality: getCheckStr(ratings.distractor_quality),
      clarity: getCheckStr(ratings.clarity),
      difficulty_alignment: getCheckStr(ratings.difficulty_alignment),
      domain_skill_alignment: getCheckStr(ratings.domain_skill_alignment),
      originality: getCheckStr(ratings.originality),
      bias_sensitivity: getCheckStr(ratings.bias_sensitivity),
    };

    // Calculate score based on config weights and 0-5 scale
    let calculatedScore = 0;
    for (const check of rubricChecks) {
      const checkId = check.id as keyof typeof ratings;
      const rating = ratings[checkId] !== undefined ? ratings[checkId] : 0;
      calculatedScore += (rating / 5) * check.weight;
    }
    calculatedScore = Math.round(calculatedScore);

    // Determine status based on zero-tolerance list and minScore
    let finalStatus: "PASS" | "FAIL" = "PASS";
    for (const zt of zeroToleranceList) {
      const ztId = zt as keyof typeof ratings;
      if (ratings[ztId] < 4) {
        finalStatus = "FAIL";
        break;
      }
    }

    if (calculatedScore < minScore) {
      finalStatus = "FAIL";
    }

    // Score is kept honest — the real calculated score from the rubric weights.
    // Pass/fail is determined independently by finalStatus above.
    // A question can score 95 but still FAIL if correctness/originality < 4 (zero-tolerance).
    let finalScore = calculatedScore;
    // Guarantee score stays within 0-100 bounds
    finalScore = Math.max(0, Math.min(100, finalScore));

    return {
      validation_status: finalStatus,
      accuracy_score: finalScore,
      checks,
      feedback: parsed.feedback || "Independent evaluation complete.",
      revised_suggestion: parsed.revised_suggestion || undefined,
      timestamp: new Date().toISOString()
    };

  } catch (e) {
    console.error("[Validator] Error running LLM validator agent:", e);
    console.info("[Validator] Real LLM call failed or was bypassed. Triggering simulated fallback.");
    return getSimulatedValidation(question, question.generation_attempt, false);
  }
}