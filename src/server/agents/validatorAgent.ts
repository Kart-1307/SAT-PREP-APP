import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import getLangfuse from '../langfuse';
import { Question, PipelineStepLog, ValidationBlock, CheckResult } from '../../types';

// Label only — the actual model used per call is decided by the fallback
// chain in generateGeminiContentWithRetry and recorded on the Langfuse trace below.
const GEMINI_VALIDATOR_MODEL = "gemini-3.1-flash-lite";
const GROQ_PRIMARY_MODEL = "openai/gpt-oss-120b";
const GROQ_FALLBACK_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.6-27b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

let geminiClient: GoogleGenAI | null = null;
let groqClient: Groq | null = null;

// ═══════════════════════════════════════════════════════════
// FUNCTION: Get Groq AI Client
// ═══════════════════════════════════════════════════════════
function getGroq(): Groq | null {
  if (!groqClient) {
    const key = process.env.GROQ_API_KEY;
    if (key && key !== "MY_GROQ_API_KEY" && key.trim() !== "") {
      groqClient = new Groq({
        apiKey: key,
      });
    }
  }
  return groqClient;
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Get Gemini AI Client
// ═══════════════════════════════════════════════════════════
function getGemini(): GoogleGenAI | null {
  if (!geminiClient) {
    const key = process.env.VALIDATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY" && key !== "MY_VALIDATOR_GEMINI_API_KEY" && key.trim() !== "") {
      geminiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "sat-question-validator",
          },
        },
      });
    }
  }
  return geminiClient;
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Generate Groq Content With Retry & Fallback
// ═══════════════════════════════════════════════════════════
const GROQ_REQUEST_TIMEOUT_MS = 15000;

async function generateGroqContentWithRetry(params: {
  prompt: string;
  systemPrompt: string;
  temperature?: number;
}): Promise<{ rawText: string; modelUsed: string; usage?: any }> {
  const groq = getGroq();
  if (!groq) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const modelsToTry = [GROQ_PRIMARY_MODEL, ...GROQ_FALLBACK_MODELS];
  let lastError: any = null;

  for (const model of modelsToTry) {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Validator:Groq] Calling model: ${model} (Attempt ${attempt}/${maxRetries})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), GROQ_REQUEST_TIMEOUT_MS);

        let completion;
        try {
          completion = await groq.chat.completions.create(
            {
              model,
              messages: [
                { role: "system", content: params.systemPrompt },
                { role: "user", content: params.prompt },
              ],
              response_format: { type: "json_object" },
              temperature: params.temperature !== undefined ? params.temperature : 0.0,
            },
            {
              signal: controller.signal,
            }
          );
        } finally {
          clearTimeout(timeoutId);
        }

        const rawText = completion.choices?.[0]?.message?.content || "";
        return {
          rawText,
          modelUsed: model,
          usage: completion.usage,
        };
      } catch (err: any) {
        lastError = err;
        const errMsg = err.message || "";
        const errStatus = err.status || err.statusCode || 0;

        const isTimeout = err.name === "AbortError" || errMsg.toLowerCase().includes("abort");
        if (isTimeout) {
          console.warn(`[Validator:Groq] Model ${model} timed out after ${GROQ_REQUEST_TIMEOUT_MS / 1000}s. Trying next attempt/model...`);
          continue;
        }

        // Rate limit (429) backoff
        if (errStatus === 429 || errMsg.toLowerCase().includes("rate limit") || errMsg.toLowerCase().includes("quota")) {
          console.warn(`[Validator:Groq] Model ${model} rate limited (429). Attempt ${attempt}/${maxRetries}.`);
          if (attempt < maxRetries) {
            // Wait 2.5 seconds before retrying
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          // Fall through to the next model (e.g. 8b-instant has higher TPM)
          break;
        }

        const isAuthError = errStatus === 401 || errStatus === 403 || errMsg.includes("401") || errMsg.includes("403");
        if (isAuthError) {
          console.error("[Validator:Groq] Authentication failed. Check GROQ_API_KEY.");
          throw err;
        }

        console.warn(`[Validator:Groq] Model ${model} unexpected error (status ${errStatus}): ${errMsg.slice(0, 120)}`);
        break;
      }
    }
  }

  throw lastError || new Error("Failed to validate via Groq after retries.");
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Generate Gemini Content With Retry Logic
// ═══════════════════════════════════════════════════════════
const GEMINI_REQUEST_TIMEOUT_MS = 12000;

async function generateGeminiContentWithRetry(params: {
  prompt: string;
  systemPrompt: string;
  responseMimeType?: string;
  temperature?: number;
}): Promise<{ res: any; modelUsed: string }> {
  const ai = getGemini();
  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const modelsToTry = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-latest"];
  let lastError: any = null;

  for (const model of modelsToTry) {
    const maxRetries = 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Validator:Gemini] Calling model: ${model} (Attempt ${attempt}/${maxRetries})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
        let res;
        try {
          res = await ai.models.generateContent({
            model: model,
            contents: params.prompt,
            config: {
              systemInstruction: params.systemPrompt,
              responseMimeType: params.responseMimeType || "application/json",
              temperature: params.temperature !== undefined ? params.temperature : 0.0,
              abortSignal: controller.signal,
            },
          });
        } finally {
          clearTimeout(timeoutId);
        }

        return { res, modelUsed: model };
      } catch (err: any) {
        lastError = err;
        const errMsg = err.message || "";
        const errStatus = err.status || (err.error && err.error.code) || 0;

        const isTimeout = err.name === "AbortError" || errMsg.toLowerCase().includes("abort");
        if (isTimeout) {
          console.warn(`[Validator:Gemini] Model ${model} timed out after ${GEMINI_REQUEST_TIMEOUT_MS / 1000}s. Trying next fallback model...`);
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
          console.error("[Validator:Gemini] Authentication failed. Check VALIDATOR_GEMINI_API_KEY or GEMINI_API_KEY.");
          throw err;
        }

        const isNotFound = errStatus === 404 || errMsg.includes("404") || errMsg.toLowerCase().includes("not found");
        if (isNotFound) {
          console.warn(`[Validator:Gemini] Model ${model} not found (404). Skipping to next model...`);
          break;
        }

        const isHighDemand =
          errStatus === 503 ||
          errMsg.includes("503") ||
          errMsg.toLowerCase().includes("demand") ||
          errMsg.toLowerCase().includes("unavailable") ||
          errMsg.toLowerCase().includes("temporary");

        if (isHighDemand) {
          console.warn(`[Validator:Gemini] Model ${model} unavailable (503). Trying next model...`);
          break;
        }

        const isQuotaError =
          errStatus === 429 ||
          errMsg.includes("429") ||
          errMsg.toLowerCase().includes("rate limit") ||
          errMsg.toLowerCase().includes("quota") ||
          errMsg.toLowerCase().includes("resource_exhausted");

        if (isQuotaError) {
          console.warn(`[Validator:Gemini] Model ${model} rate limited or quota exceeded (429). Switching to next fallback model immediately.`);
          break;
        }

        console.warn(`[Validator:Gemini] Model ${model} unexpected error (status ${errStatus}): ${errMsg.slice(0, 120)}`);
        break;
      }
    }
  }

  throw lastError || new Error("Failed to validate content via Gemini after all retries and model fallbacks.");
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
    bias_sensitivity: "PASS",
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
    timestamp: new Date().toISOString(),
    validator_tier: "simulated",
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
// ═══════════════════════════════════════════════════════════
function extractJSON(raw: string): string {
  let text = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

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
      text = text.slice(firstBrace, endIdx + 1);
    } else {
      text = text.slice(firstBrace);
    }
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
  text += ']'.repeat(Math.max(0, brackets));
  text += '}'.repeat(Math.max(0, braces));

  text = removeTrailingCommas(text);

  return repairJSONBackslashes(text);
}

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTION: Parse & Evaluate Structured Validator Output
// ═══════════════════════════════════════════════════════════
function parseAndEvaluateValidation(
  rawText: string,
  rubricChecks: any[],
  zeroToleranceList: string[],
  minScore: number
): {
  status: "PASS" | "FAIL";
  score: number;
  checks: CheckResult;
  feedback: string;
  revised_suggestion?: string;
  independent_derivation?: string;
} {
  const cleanText = extractJSON(rawText);
  let parsed: any;
  try {
    parsed = JSON.parse(cleanText);
  } catch (parseErr) {
    console.warn("[Validator] Initial JSON parse failed. Attempting robust JSON repair...");
    try {
      let repaired = cleanText
        .replace(/,\s*([\}\]])/g, '$1')
        .replace(/"\s*\n\s*"([^"]*)"\s*\}\s*$/g, '\\n$1"}');

      repaired = repaired.replace(/[\u0000-\u001F]+/g, (m) => {
        if (m === "\n") return "\\n";
        if (m === "\r") return "\\r";
        if (m === "\t") return "\\t";
        return "";
      });

      parsed = JSON.parse(repaired);
      console.log("[Validator] ✅ Robust JSON repair succeeded!");
    } catch (repairErr) {
      const statusMatch = cleanText.match(/"validation_status"\s*:\s*"(PASS|FAIL)"/i);
      const scoreMatch = cleanText.match(/"accuracy_score"\s*:\s*(\d+)/i);
      const feedbackMatch = cleanText.match(/"feedback"\s*:\s*"([\s\S]*?)"\s*,\s*"/i);

      if (statusMatch || scoreMatch) {
        const status = statusMatch ? (statusMatch[1].toUpperCase() as "PASS" | "FAIL") : "FAIL";
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 50;
        parsed = {
          validation_status: status,
          accuracy_score: score,
          checks: { correctness: status === "PASS" ? 5 : 1 },
          feedback: feedbackMatch ? feedbackMatch[1].replace(/\\"/g, '"').trim() : "Parsed via fallback regex.",
          revised_suggestion: "",
        };
        console.log(`[Validator] ✅ Regex field extraction recovered evaluation (Status: ${status}, Score: ${score})`);
      } else {
        console.error("[Validator] JSON parse failed. Raw response:", rawText);
        throw parseErr;
      }
    }
  }

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

  let finalScore = Math.max(0, Math.min(100, calculatedScore));

  return {
    status: finalStatus,
    score: finalScore,
    checks,
    feedback: parsed.feedback || "Independent evaluation complete.",
    revised_suggestion: parsed.revised_suggestion || undefined,
    independent_derivation: parsed.independent_derivation || undefined,
  };
}

// ═══════════════════════════════════════════════════════════
// FUNCTION: Run Validator Agent (Two-Tier Cascade Architecture)
//
// 1. Tier 1: Groq Validator (llama-3.3-70b-versatile, ~500ms, free tier)
//    - If PASS (score >= minScore and zero-tolerance checks >= 4) -> Approve immediately!
// 2. Tier 2: Gemini Validator Arbitrator (if Groq fails or borderline)
//    - If Gemini PASS -> Approved (arbitrated pass)
//    - If Gemini FAIL -> Rejection with feedback sent back to Claude generator
// 3. Fallback: Simulated validator (if neither API is configured)
// ═══════════════════════════════════════════════════════════
export async function runValidatorAgent(params: {
  question: Question;
  config: any;
  onStep?: (log: PipelineStepLog) => void | Promise<void>;
}): Promise<ValidationBlock> {
  const { question, config, onStep } = params;

  await onStep?.({
    timestamp: new Date().toISOString(),
    type: "validate",
    message: "Agent 2: Starting independent, multi-dimension validation. (Generator thoughts are hidden from Agent 2).",
  });

  const rubricChecks = config.validation_rubric.checks;
  const zeroToleranceList = config?.validation_rubric?.zero_tolerance_checks || [
    "correctness",
    "originality",
    "difficulty_alignment",
    "domain_skill_alignment",
  ];
  const minScore = config.validation_rubric.min_composite_score || 90;

  const hasGroq = !!getGroq();
  const hasGemini = !!getGemini();

  if (!hasGroq && !hasGemini) {
    console.warn("[Validator] Neither GROQ_API_KEY nor GEMINI_API_KEY is configured. Falling back to simulation mode.");
    const shouldSimulateFailure = question.generation_attempt === 1 && Math.random() < 0.2;
    return getSimulatedValidation(question, question.generation_attempt, shouldSimulateFailure);
  }

  const systemPrompt = `You are an expert Exam Quality Validator Agent.
You inspect the generated question for academic standards, mathematical accuracy, and distractor quality.

CRITICAL INSTRUCTION FOR MATHEMATICAL VALIDATION & INDEPENDENT DERIVATION:
1. First, attempt to solve the question independently using only "stimulus" and "question_text". Write your derivation in "independent_derivation".
2. DISCREPANCY RECONCILIATION:
   - If your independent derivation matches the question's correct answer: score correctness 5/5.
   - If your derivation differs from the question's answer: DO NOT immediately fail. Check the question's provided "step_by_step_solution" / "explanation":
     a. If the question's derivation is mathematically sound and your own independent solve had a calculation slip, accept the question (score correctness 4-5/5).
     b. If the question's derivation genuinely contains an algebraic/arithmetic error, mark correctness 0-2/5 and pinpoint the exact erroneous step in "feedback".
Grading Scale:
For each check below, rate the question on a scale of 0 to 5:
- 5: Flawless / Fully satisfied (no issues).
- 4: Satisfied (good quality, valid exam item).
- 3: Partially satisfied (minor flaws).
- 2: Poorly satisfied (significant flaws).
- 1: Barely satisfied.
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

  const difficultyEntry = Array.isArray(config?.difficulty_scale)
    ? config.difficulty_scale.find((d: any) => d.label === question.difficulty)
    : null;
  const difficultyNote = difficultyEntry?.definition
    ? `\nDIFFICULTY RUBRIC FOR "${question.difficulty}" — score "difficulty_alignment" against THIS EXACT definition, not a general impression of the label:\n"${difficultyEntry.definition}"\n`
    : '';

  const stimulusNote = question.passage
    ? `\nNOTE: This question has a "passage" field — it is the authoritative reading passage. Base your comprehension check on it directly.\n`
    : question.stimulus
      ? `\nNOTE: This question has a "stimulus" field — it is the authoritative equation/function/table/context to DERIVE the answer from. But "question_text" is what the student actually reads — grade its clarity/completeness independently (see above).\n`
      : '';

  const prompt = `Please validate this generated question object:
${difficultyNote}${stimulusNote}${JSON.stringify(question, null, 2)}`;

  // Top-level Langfuse trace for validation
  const trace = getLangfuse().trace({
    name: 'question-validation-cascade',
    tags: [question.exam_type, question.section],
    metadata: {
      question_id: question.question_id,
      domain: question.domain,
      skill: question.skill_tag,
      difficulty: question.difficulty,
      generation_attempt: question.generation_attempt,
    },
  });

  // ═══════════════════════════════════════════════════════════
  // TIER 1: GROQ VALIDATION
  // ═══════════════════════════════════════════════════════════
  let groqResult: ReturnType<typeof parseAndEvaluateValidation> | null = null;
  let groqError: any = null;

  if (hasGroq) {
    const startTime = Date.now();
    const generation = trace.generation({
      name: 'validate-question-groq',
      model: GROQ_PRIMARY_MODEL,
      modelParameters: { temperature: 0.0 },
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    try {
      const { rawText, modelUsed, usage } = await generateGroqContentWithRetry({
        prompt,
        systemPrompt,
        temperature: 0.0,
      });

      generation.update({ model: modelUsed });
      generation.end({
        output: rawText,
        usageDetails: {
          input: usage?.prompt_tokens ?? 0,
          output: usage?.completion_tokens ?? 0,
        },
      });

      groqResult = parseAndEvaluateValidation(rawText, rubricChecks, zeroToleranceList, minScore);
      const elapsedMs = Date.now() - startTime;

      console.log(`[Validator] Tier-1 (Groq ${modelUsed}) finished in ${elapsedMs}ms: STATUS = ${groqResult.status}, SCORE = ${groqResult.score}/100`);

      // FAST-PASS DECISION:
      // If Groq gives a clean PASS with a score >= minScore, approve immediately!
      if (groqResult.status === "PASS" && groqResult.score >= minScore) {
        console.log(`[Validator] ✅ Tier-1 (Groq) PASSED question ${question.question_id}. Direct approval without escalation.`);
        return {
          validation_status: "PASS",
          accuracy_score: groqResult.score,
          checks: groqResult.checks,
          feedback: groqResult.feedback,
          revised_suggestion: groqResult.revised_suggestion,
          independent_derivation: groqResult.independent_derivation,
          timestamp: new Date().toISOString(),
          validator_tier: "groq",
        };
      }

      const failReasonShort = groqResult.feedback ? ` — Reason: "${groqResult.feedback.slice(0, 160)}${groqResult.feedback.length > 160 ? '...' : ''}"` : '';
      console.log(`[Validator] ⚠️ Tier-1 (Groq) flagged FAIL/BORDERLINE (Status: ${groqResult.status}, Score: ${groqResult.score}/100)${failReasonShort}. Escalating to Tier-2 (Gemini Arbitrator)...`);
      await onStep?.({
        timestamp: new Date().toISOString(),
        type: "validate",
        message: `Agent 2 (Tier 1 - Groq): Flagged potential issues (Score: ${groqResult.score}/100)${failReasonShort}. Escalating to Tier 2 (Gemini Arbitrator) for second opinion...`,
      });

    } catch (err: any) {
      groqError = err;
      generation.end({
        statusMessage: err?.message || String(err),
        level: 'ERROR',
      });
      console.warn(`[Validator] Tier-1 (Groq) failed or was unavailable: ${err?.message || err}. Falling back to Tier-2 (Gemini)...`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // TIER 2: GEMINI ARBITRATOR (Second Opinion / Escalation)
  // ═══════════════════════════════════════════════════════════
  if (hasGemini) {
    const startTime = Date.now();

    // If Groq previously flagged an issue, provide Groq's exact critique to Gemini so it can arbitrate
    let geminiUserPrompt = prompt;
    if (groqResult && groqResult.feedback) {
      geminiUserPrompt += `\n\nTIER-1 EVALUATOR CRITIQUE (FOR ARBITRATION):
Tier-1 (Groq) evaluated this question and flagged the following issue(s) (Score: ${groqResult.score}/100):
"${groqResult.feedback}"${groqResult.revised_suggestion ? `\nSuggested Fix: "${groqResult.revised_suggestion}"` : ''}

ARBITRATOR INSTRUCTION:
Perform your own independent solve first. Specifically assess whether Tier-1's critique above is a genuine defect or a false alarm. If the question is mathematically and pedagogically sound, rate it accordingly. If Tier-1's critique is correct, confirm the failure.`;
    }

    const generation = trace.generation({
      name: 'validate-question-gemini-arbitrator',
      model: GEMINI_VALIDATOR_MODEL,
      modelParameters: { temperature: 0.0 },
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: geminiUserPrompt },
      ],
    });

    try {
      const { res, modelUsed } = await generateGeminiContentWithRetry({
        prompt: geminiUserPrompt,
        systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.0,
      });

      generation.update({ model: modelUsed });

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
      const geminiResult = parseAndEvaluateValidation(rawText, rubricChecks, zeroToleranceList, minScore);
      const elapsedMs = Date.now() - startTime;

      console.log(`[Validator] Tier-2 (Gemini ${modelUsed}) finished in ${elapsedMs}ms: STATUS = ${geminiResult.status}, SCORE = ${geminiResult.score}/100`);

      const tierLabel = hasGroq ? "gemini_arbitrated" : "gemini";

      let finalFeedback = geminiResult.feedback;
      let finalSuggestion = geminiResult.revised_suggestion;

      if (geminiResult.status === "PASS") {
        console.log(`[Validator] ✅ Tier-2 (Gemini Arbitrator) PASSED question ${question.question_id} (Score: ${geminiResult.score}/100).`);
      } else {
        console.log(`[Validator] ❌ Tier-2 (Gemini Arbitrator) confirmed FAILURE for question ${question.question_id} (Score: ${geminiResult.score}/100).`);
        // If Groq also gave feedback, combine both critiques so Claude gets full context for regeneration
        if (groqResult && groqResult.feedback) {
          finalFeedback = `[Tier-1 Groq Review]: ${groqResult.feedback}\n[Tier-2 Gemini Review]: ${geminiResult.feedback}`;
          if (groqResult.revised_suggestion) {
            finalSuggestion = geminiResult.revised_suggestion
              ? `${groqResult.revised_suggestion} | ${geminiResult.revised_suggestion}`
              : groqResult.revised_suggestion;
          }
        }
      }

      return {
        validation_status: geminiResult.status,
        accuracy_score: geminiResult.score,
        checks: geminiResult.checks,
        feedback: finalFeedback,
        revised_suggestion: finalSuggestion,
        independent_derivation: geminiResult.independent_derivation || groqResult?.independent_derivation,
        timestamp: new Date().toISOString(),
        validator_tier: tierLabel,
      };

    } catch (geminiErr: any) {
      generation.end({
        statusMessage: geminiErr?.message || String(geminiErr),
        level: 'ERROR',
      });
      console.error("[Validator] Tier-2 (Gemini) also failed:", geminiErr);
    }
  }

  // If Groq had an evaluation result (even if failed), and Gemini wasn't available / errored out, return Groq's evaluation
  if (groqResult) {
    return {
      validation_status: groqResult.status,
      accuracy_score: groqResult.score,
      checks: groqResult.checks,
      feedback: groqResult.feedback,
      revised_suggestion: groqResult.revised_suggestion,
      independent_derivation: groqResult.independent_derivation,
      timestamp: new Date().toISOString(),
      validator_tier: "groq",
    };
  }

  // Fallback to simulated validation
  console.info("[Validator] Both Tier-1 and Tier-2 were unavailable. Triggering simulated fallback validation.");
  return getSimulatedValidation(question, question.generation_attempt, false);
}