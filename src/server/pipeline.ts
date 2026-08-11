import { GoogleGenAI } from "@google/genai";
import { Database } from "./db";
import { Question, ValidationBlock, ValidationAuditLog, PipelineRun, PipelineStepLog, CheckResult, AnswerChoice, BatchRun, BatchRunItem } from "../types";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { runGeneratorAgent } from './agents/generatorAgent';
import { runValidatorAgent } from './agents/validatorAgent';
import { runMathSanityCheck } from './mathSanityCheck';
import { cleanQuestionText } from './formatter';

// Initialize the GoogleGenAI client lazily to avoid crashing on startup if key is missing
let aiClient: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.warn("GEMINI_API_KEY is not set. Pipeline will run in Simulated fallback mode.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key || "DUMMY_KEY",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

export function checkQuestionCompleteness(q: Question): { complete: boolean; reason?: string } {
  if (q.question_text) {
    q.question_text = cleanQuestionText(q.question_text);
  }
  if (!q.question_text || !q.question_text.trim()) {
    return { complete: false, reason: "Question text is missing." };
  }
  if (!Array.isArray(q.answer_choices) || q.answer_choices.length < 2) {
    return { complete: false, reason: "Fewer than 2 answer choices were produced." };
  }
  for (const choice of q.answer_choices) {
    if (!choice.id || !choice.text || !choice.text.trim()) {
      return { complete: false, reason: "One or more answer choices are missing an id or text." };
    }
  }
  if (!q.correct_answer) {
    return { complete: false, reason: "No correct_answer was set." };
  }
  if (!q.answer_choices.some(c => c.id === q.correct_answer)) {
    return { complete: false, reason: "correct_answer does not match any answer choice id." };
  }
  if (!q.explanation || !q.explanation.correct_rationale || !q.explanation.correct_rationale.trim()) {
    return { complete: false, reason: "Explanation for the correct answer is missing." };
  }
  return { complete: true };
}

// ----------------------------------------------------
// Embedding & Similarity Helper
// ----------------------------------------------------
function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// High-quality TF-IDF/Jaccard similarity fallback
function calculateLocalSimilarity(text1: string, text2: string): number {
  const sanitize = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const words1 = new Set(sanitize(text1));
  const words2 = new Set(sanitize(text2));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size; // Jaccard index
}

export async function runSimilarityCheck(
  newQuestionText: string,
  newPassage: string | null,
  examType: string,
  userId?: string
): Promise<{ similarity_score: number; similar_question_id: string | null; embedding?: number[] }> {
  const existingQuestions = await Database.getQuestions({ exam_type: examType, includeEmbeddings: true });
  if (existingQuestions.length === 0) {
    return { similarity_score: 0, similar_question_id: null };
  }

  const targetText = `${newPassage || ""} ${newQuestionText}`.trim();
  let bestScore = 0;
  let bestId: string | null = null;

  const hasApiKey = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  let targetVec: number[] | undefined;

  if (hasApiKey) {
    try {
      const ai = getAI();
      // One embedding call for the new question only — comparisons against
      // the rest of the bank reuse each question's embedding, cached on it
      // the first time it was checked, instead of re-embedding the entire
      // bank (which is what made this step take 60+ seconds as the bank grew).
      // 12s hard timeout — this call had none before and doesn't retry, so a
      // hung request could otherwise block a pipeline attempt indefinitely.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      let resTarget;
      try {
        resTarget = await ai.models.embedContent({
          model: "gemini-embedding-2-preview",
          contents: targetText,
          config: { abortSignal: controller.signal },
        });
      } finally {
        clearTimeout(timeoutId);
      }
      targetVec = (resTarget as any).embedding?.values || (resTarget as any).embeddings?.values || (resTarget as any).embeddings?.[0]?.values;

      if (targetVec) {
        for (const q of existingQuestions) {
          if (!q.embedding || q.embedding.length === 0) continue;
          const score = calculateCosineSimilarity(targetVec, q.embedding);
          if (score > bestScore) {
            bestScore = score;
            bestId = q.question_id;
          }
        }
      }
    } catch (e) {
      console.info("[Gemini Embedding] Falling back to word overlap similarity check.");
    }
  }

  // Cheap local fallback (no network calls) for any question that doesn't
  // have a cached embedding yet — e.g. ones saved before this field existed,
  // or if the embedding call above failed entirely.
  for (const q of existingQuestions) {
    if (q.embedding && q.embedding.length > 0) continue;
    const qText = `${q.passage || ""} ${q.question_text}`.trim();
    const score = calculateLocalSimilarity(targetText, qText);
    if (score > bestScore) {
      bestScore = score;
      bestId = q.question_id;
    }
  }

  return {
    similarity_score: parseFloat(bestScore.toFixed(3)),
    similar_question_id: bestScore > 0.85 ? bestId : null,
    embedding: targetVec
  };
}

// ----------------------------------------------------
// Simulated Content Fallback (When API Key is missing)
// ----------------------------------------------------
function getSimulatedQuestion(
  examType: string,
  section: string,
  domain: string,
  skillTag: string,
  difficulty: string,
  attempt: number,
  feedback?: string
): any {
  const qId = `sim-${Date.now()}`;
  const exam = examType.toUpperCase();
  const secLower = section.toLowerCase();
  const domLower = domain.toLowerCase();
  const skillLower = skillTag.toLowerCase();
  const diffLabel = difficulty || "Medium";

  // Default fallback placeholders that we will specialize below
  let passage: string | null = null;
  let stimulus: string | null = null;
  let question_text = `Solve this simulated ${diffLabel} level question.`;
  let answer_choices: AnswerChoice[] = [
    { id: "A", text: "Option A (Correct Answer)" },
    { id: "B", text: "Option B" },
    { id: "C", text: "Option C" },
    { id: "D", text: "Option D" }
  ];
  let correct_answer = "A";
  let correct_rationale = "This is the correct choice because it aligns perfectly with the standard rubric.";
  let distractor_rationale: Record<string, string> = {
    "A": "Correct answer.",
    "B": "Incorrect due to misinterpretation.",
    "C": "Incorrect due to simple calculation or sign error.",
    "D": "Opposite relationship or standard distractor."
  };

  // ----------------------------------------------------------------------
  // GRE - GRADUATE RECORD EXAMINATIONS
  // ----------------------------------------------------------------------
  if (exam === "GRE") {
    if (secLower.includes("verbal")) {
      if (domLower.includes("reading")) {
        passage = `In her seminal study of pre-industrial economies, historian Elena Rossi argues that local bartering systems were not primitive predecessors to currency-based trade, but rather sophisticated, parallel networks that coexisted with imperial markets. Rossi supports this thesis by analyzing ledger fragments from the Roman frontier, which demonstrate that barter transactions followed rigid, consensus-based valuation rules. However, Rossi’s model has drawn criticism from scholars who contend that her primary sources represent exceptional border-town conditions rather than general economic patterns.`;

        if (skillLower.includes("structure")) {
          question_text = "Which of the following best describes the structural relationship between the second sentence and the third sentence of the passage?";
          answer_choices = [
            { id: "A", text: "The second sentence introduces empirical evidence that supports the main thesis, while the third sentence identifies a major limitation of that evidence." },
            { id: "B", text: "The second sentence summarizes an opposing view, while the third sentence refutes that opposing view entirely." },
            { id: "C", text: "The second sentence provides a specific historical counterexample, while the third sentence contextualizes its cultural origin." },
            { id: "D", text: "The second sentence proposes an alternative explanation, while the third sentence resolves the resulting conceptual conflict." },
            { id: "E", text: "The second sentence defines a key economic term, while the third sentence illustrates its application in pre-industrial states." }
          ];
          correct_answer = "A";
          correct_rationale = "The second sentence states that Rossi analyzes ledger fragments (evidence supporting her thesis), and the third sentence introduces critics who argue this evidence represents exceptional, narrow conditions (a limitation).";
          distractor_rationale = {
            "A": "Correct selection.",
            "B": "The second sentence is Rossi's own support, not an opposing view.",
            "C": "The ledger fragments are supporting evidence, not a counterexample.",
            "D": "No alternative explanation or resolution of conflict is discussed.",
            "E": "The second sentence provides proof rather than defining a theoretical term."
          };
        } else if (skillLower.includes("detail") || skillLower.includes("retrieve")) {
          question_text = "According to the passage, critics of Rossi's model argue that the ledger fragments she analyzed are:";
          answer_choices = [
            { id: "A", text: "unrepresentative of broader historical economic systems due to their specific geographic origin." },
            { id: "B", text: "internally inconsistent and highly prone to varying interpretations by modern economic historians." },
            { id: "C", text: "forged or altered during the late imperial period to evade colonial tax codes." },
            { id: "D", text: "valuable only for understanding military barter rather than civil trade patterns." },
            { id: "E", text: "incompatible with the rigid, consensus-based valuation rules Rossi describes." }
          ];
          correct_answer = "A";
          correct_rationale = "Critics claim that her sources represent 'exceptional border-town conditions' rather than general economic patterns, directly implying they are geographically unrepresentative.";
          distractor_rationale = {
            "A": "Correct selection.",
            "B": "No claim of internal inconsistency or translation/interpretation error is made.",
            "C": "Forgery or evasion of taxes is not mentioned or implied in the text.",
            "D": "The distinction between military and civil trade is never raised.",
            "E": "The critics challenge the scope of applicability, not the existence of consensus rules."
          };
        } else {
          // Author attitude and tone
          passage = `While proponents of string theory laud its mathematical elegance as a precursor to a 'theory of everything,' critics often view it with skepticism, citing the lack of testable predictions. However, dismissing the theory solely on the basis of its current untestability overlooks its profound contributions to algebraic geometry. The mathematical frameworks developed to support string theory have revitalized areas of pure mathematics that had languished for decades, proving that even a physical theory that cannot yet be verified can yield immense intellectual capital.`;
          question_text = "The author's attitude toward string theory can best be characterized as:";
          answer_choices = [
            { id: "A", text: "qualified appreciation for its mathematical utility despite its current physical limitations" },
            { id: "B", text: "unconditional enthusiasm for its eventual confirmation as a physical law" },
            { id: "C", text: "resolute skepticism regarding its empirical validity and scientific merit" },
            { id: "D", text: "ambivalent indifference to both its physical claims and mathematical developments" },
            { id: "E", text: "scholarly disapproval of its influence on the direction of pure mathematics research" }
          ];
          correct_answer = "A";
          correct_rationale = "The author acknowledges that string theory is currently untestable, but appreciates its 'profound contributions to algebraic geometry' and mathematics, reflecting a qualified appreciation.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "The enthusiasm is qualified by limitations, not unconditional.",
            "C": "The author is defending the theory against total dismissal, showing they are not resolutely skeptical.",
            "D": "The author is actively engaged and expressing a clear opinion, not showing indifference.",
            "E": "The author states string theory 'revitalized' pure mathematics, which is positive, not disapproving."
          };
        }
      } else if (domLower.includes("completion")) {
        if (skillLower.includes("single") || skillLower.includes("one")) {
          passage = "The manager was notoriously ________; she rarely spoke during corporate meetings, preferring to let her written memos communicate her directives.";
          question_text = "Which choice completes the text with the most logical and precise word?";
          answer_choices = [
            { id: "A", text: "taciturn" },
            { id: "B", text: "loquacious" },
            { id: "C", text: "gregarious" },
            { id: "D", text: "ambivalent" },
            { id: "E", text: "officious" }
          ];
          correct_answer = "A";
          correct_rationale = "The clue 'rarely spoke' directly matches 'taciturn' (reserved or uncommunicative in speech).";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Loquacious means talkative, which is the exact opposite of the clue.",
            "C": "Gregarious means sociable, which does not directly match her habit of speaking rarely.",
            "D": "Ambivalent means having mixed feelings, which doesn't fit the context of communication volume.",
            "E": "Officious means assertively offering unrequested help, which doesn't describe speaking patterns."
          };
        } else if (skillLower.includes("double") || skillLower.includes("two")) {
          passage = "Although many economists predicted that the newly instituted regulatory measures would have a ________ effect on small businesses, the actual outcomes were surprisingly ________, leading to a period of unprecedented market expansion.";
          question_text = "Which choice completes the text with the most logical and precise pair of words?";
          answer_choices = [
            { id: "A", text: "deleterious ... salutary" },
            { id: "B", text: "beneficial ... catastrophic" },
            { id: "C", text: "negligible ... ruinous" },
            { id: "D", text: "profound ... negligible" },
            { id: "E", text: "stagnant ... volatile" }
          ];
          correct_answer = "A";
          correct_rationale = "The word 'Although' establishes a contrast. Unprecedented market expansion means the actual outcome was positive ('salutary'). The prediction must have been the opposite, i.e., negative ('deleterious').";
          distractor_rationale = {
            "A": "Correct selection.",
            "B": "This reverses the contrast, placing positive first and negative second.",
            "C": "Both words describe negative or minor impacts, failing to create the contrast with expansion.",
            "D": "Does not fit the contrast of negative prediction vs. highly positive outcome.",
            "E": "Stagnant and volatile do not fit the contrast with small business market expansion."
          };
        } else {
          // Triple-blank completion
          passage = "The intellectual community was initially (i) ________ by the researcher's radical claims, but after several independent laboratories failed to (ii) ________ her results, the excitement quickly (iii) ________ into widespread skepticism.";
          question_text = "Which choice completes the text with the most logical and precise words?";
          answer_choices = [
            { id: "A", text: "galvanized ... replicate ... degenerated" },
            { id: "B", text: "confounded ... publish ... solidified" },
            { id: "C", text: "unimpressed ... verify ... evolved" },
            { id: "D", text: "intrigued ... disregard ... transformed" },
            { id: "E", text: "disheartened ... disprove ... evaporated" }
          ];
          correct_answer = "A";
          correct_rationale = "The initial reaction to the radical claims was excitement, matching 'galvanized'. Independent laboratories failing to recreate the results corresponds to failing to 'replicate' them, which caused excitement to decline or 'degenerate' into skepticism.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Excitement solidifying into skepticism is illogical.",
            "C": "If they were unimpressed, there would be no initial excitement to evolve.",
            "D": "Failing to 'disregard' is double negative and doesn't fit.",
            "E": "If they were disheartened, there would not be 'excitement' to evaporate."
          };
        }
      } else if (domLower.includes("equivalence")) {
        passage = "The author's prose is notoriously ________, requiring readers to spend hours parsing a single page to uncover the core thesis.";
        question_text = "Select the two answer choices that, when used to complete the sentence, fit the meaning of the sentence as a whole and produce completed sentences that are alike in meaning.";
        answer_choices = [
          { id: "A", text: "convoluted" },
          { id: "B", text: "lucid" },
          { id: "C", text: "tortuous" },
          { id: "D", text: "transparent" },
          { id: "E", text: "simplistic" },
          { id: "F", text: "verbose" }
        ];
        correct_answer = "A"; // Standardized to return 'A' (which pairs with C in rationale)
        correct_rationale = "The sentence describes prose that is hard to parse and requires hours to read. Both 'convoluted' (A) and 'tortuous' (C) mean highly complex, winding, and difficult to follow, making them synonym pairs that produce equivalent meanings.";
        distractor_rationale = {
          "A": "Correct answer (pairs with choice C).",
          "B": "Lucid means extremely clear, which contradicts the hours needed to parse.",
          "C": "Correct synonym (tortuous means full of twists/complex, pairing with convoluted).",
          "D": "Transparent means easily understood, the opposite of the context.",
          "E": "Simplistic implies too simple, which contradicts spending hours parsing.",
          "F": "Verbose means wordy, which doesn't necessarily mean convoluted in structure."
        };
      }
    } else if (secLower.includes("quantitative") || secLower.includes("math")) {
      if (domLower.includes("arithmetic")) {
        if (skillLower.includes("integer")) {
          question_text = "If x is a positive integer and x^2 is divisible by 12, then x must be divisible by which of the following?";
          answer_choices = [
            { id: "A", text: "6" },
            { id: "B", text: "4" },
            { id: "C", text: "9" },
            { id: "D", text: "8" },
            { id: "E", text: "12" }
          ];
          correct_answer = "A";
          correct_rationale = "If x^2 is divisible by 12 (which is 2^2 * 3), then the prime factorization of x^2 must contain at least two 2s and one 3. Since x^2 is a perfect square, the prime factorization of x^2 must contain at least two 2s and two 3s. Therefore, the prime factorization of x must contain at least one 2 and one 3, which means x is divisible by 6.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "x is not necessarily divisible by 4 (e.g. x = 6, 6^2 = 36 is divisible by 12, but 6 is not divisible by 4).",
            "C": "x is not necessarily divisible by 9.",
            "D": "x is not necessarily divisible by 8.",
            "E": "x is not necessarily divisible by 12 (e.g. x = 6)."
          };
        } else {
          question_text = "A certain chemical mixture contains 15% alcohol by volume. If 3 liters of pure water are added to 12 liters of this mixture, what percent of the new mixture, by volume, is alcohol?";
          answer_choices = [
            { id: "A", text: "12%" },
            { id: "B", text: "10%" },
            { id: "C", text: "11.25%" },
            { id: "D", text: "9.5%" },
            { id: "E", text: "8%" }
          ];
          correct_answer = "A";
          correct_rationale = "Initial alcohol volume = 15% of 12 liters = 0.15 * 12 = 1.8 liters. New total volume = 12 + 3 = 15 liters. New percent of alcohol = 1.8 / 15 = 0.12 or 12%.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Incorrectly divided 1.8 by 18 liters.",
            "C": "Incorrect weighted average.",
            "D": "Estimation error.",
            "E": "Calculated total ratio incorrectly."
          };
        }
      } else if (domLower.includes("algebra")) {
        question_text = "For what values of x is the quadratic inequality x^2 - 5x + 6 < 0 satisfied?";
        answer_choices = [
          { id: "A", text: "2 < x < 3" },
          { id: "B", text: "x < 2 or x > 3" },
          { id: "C", text: "-3 < x < -2" },
          { id: "D", text: "-2 < x < 3" },
          { id: "E", text: "No real solutions" }
        ];
        correct_answer = "A";
        correct_rationale = "Factor the quadratic: (x - 2)(x - 3) < 0. The roots of the quadratic equation are x = 2 and x = 3. Since the coefficient of x^2 is positive, the parabola opens upward and is negative between the roots, which is 2 < x < 3.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "This is the range where the quadratic is greater than zero.",
          "C": "Sign error on the roots.",
          "D": "Incorrectly includes negative bounds.",
          "E": "Assumed no solution due to confusing the inequality sign."
        };
      } else if (domLower.includes("geometry")) {
        question_text = "A circle is inscribed inside a square of area 64 square inches. What is the area of the inscribed circle, in square inches?";
        answer_choices = [
          { id: "A", text: "16π" },
          { id: "B", text: "64π" },
          { id: "C", text: "8π" },
          { id: "D", text: "32π" },
          { id: "E", text: "4π" }
        ];
        correct_answer = "A";
        correct_rationale = "The square has an area of 64, so its side length is √64 = 8 inches. A circle inscribed in this square has a diameter equal to the side length of the square, which is 8 inches. Thus, the radius r of the circle is 4 inches. The area of the circle is π * r^2 = π * 4^2 = 16π.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "Used the square side as the radius.",
          "C": "Used 2πr formula for circumscribed circle radius or miscalculated power.",
          "D": "Halved the square area and added π.",
          "E": "Used the radius as 2 inches."
        };
      } else {
        // Data Analysis
        question_text = "A bag contains 4 red marbles, 5 blue marbles, and 6 green marbles. If two marbles are drawn at random without replacement, what is the probability that both marbles are blue?";
        answer_choices = [
          { id: "A", text: "2/21" },
          { id: "B", text: "1/9" },
          { id: "C", text: "5/21" },
          { id: "D", text: "4/15" },
          { id: "E", text: "2/15" }
        ];
        correct_answer = "A";
        correct_rationale = "The total number of marbles is 4 + 5 + 6 = 15. Probability of drawing a blue marble first is 5/15 = 1/3. Since drawing is without replacement, 14 marbles remain, with 4 of them blue. Probability of drawing a blue marble second is 4/14 = 2/7. Composite probability is (1/3) * (2/7) = 2/21.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "Assumed drawing with replacement: (1/3) * (1/3) = 1/9.",
          "C": "Forgot to decrement the blue count: (5/15) * (5/14) = 5/42 or similar mistake.",
          "D": "Calculated single blue ratio incorrectly.",
          "E": "Simple arithmetic multiplication error."
        };
      }
    } else {
      // Writing
      passage = `Prompt: 'As people rely more and more on technology to solve problems, the ability of humans to think for themselves will surely deteriorate.'`;
      question_text = "Write a response in which you discuss the extent to which you agree or disagree with the statement and explain your reasoning for the position you take.";
      answer_choices = [
        { id: "A", text: "Strongly Agree: Technology diminishes cognitive load and problem-solving skills." },
        { id: "B", text: "Agree: Technology provides convenience but reduces memory reliance." },
        { id: "C", text: "Disagree: Technology frees human minds to focus on higher-level conceptual tasks." },
        { id: "D", text: "Strongly Disagree: Technology is a cognitive tool that enhances rather than limits human intellect." }
      ];
      correct_answer = "C";
      correct_rationale = "A strong analytical essay disagrees by arguing that technology acts as a leverage tool, freeing cognitive bandwidth for advanced reasoning.";
      distractor_rationale = {
        "A": "One-sided perspective lacking nuanced trade-offs.",
        "B": "Generic response with low persuasive scope.",
        "C": "Correct and balanced academic stance.",
        "D": "Overly extreme position without addressing drawbacks."
      };
    }
  }
  // ----------------------------------------------------------------------
  // SAT - COLLEGE BOARD DIGITAL SAT
  // ----------------------------------------------------------------------
  else {
    if (secLower.includes("reading") || secLower.includes("verbal")) {
      if (domLower.includes("craft") || domLower.includes("structure")) {
        if (skillLower.includes("context")) {
          passage = "The researcher's presentation on deep-sea ecosystems was quite ________; it covered a wide range of organic pathways in a concise and easily digestible format.";
          question_text = "Which choice completes the text with the most logical and precise word?";
          answer_choices = [
            { id: "A", text: "succinct" },
            { id: "B", text: "prolix" },
            { id: "C", text: "diffuse" },
            { id: "D", text: "ponderous" }
          ];
          correct_answer = "A";
          correct_rationale = "The context clue 'concise and easily digestible' directly points to 'succinct' (brief and clear).";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Prolix means wordy or tedious, which is the opposite.",
            "C": "Diffuse means unfocused or rambling, contradicting the clue.",
            "D": "Ponderous means heavy, slow, or dull."
          };
        } else if (skillLower.includes("purpose") || skillLower.includes("text")) {
          passage = "In many species of birds, male plumage is bright and decorative, which evolutionary biologists have long argued serves to attract mates. However, a recent study of bluebirds suggests that vibrant feathers also play an aggressive signaling role in male-to-male territorial disputes. The scientists observed that males with brighter plumage successfully defended nesting sites more frequently than their duller peers.";
          question_text = "Which choice best states the main purpose of the text?";
          answer_choices = [
            { id: "A", text: "To present research suggesting that decorative plumage has a social function beyond attracting mates." },
            { id: "B", text: "To argue that female bluebirds prefer dull-colored males over brightly colored ones." },
            { id: "C", text: "To refute the claim that evolutionary biology can explain avian plumage variation." },
            { id: "D", text: "To describe the nesting habits of bluebirds in territorial ecosystems." }
          ];
          correct_answer = "A";
          correct_rationale = "The passage introduces the traditional mate attraction theory and uses 'However' to present a new study showing plumage also serves in aggressive territorial signaling, which represents a social function beyond mating.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "The passage does not claim that females prefer dull males.",
            "C": "The passage expands evolutionary understanding rather than refuting the entire field of evolutionary biology.",
            "D": "Describe nesting habits is too broad and misses the central focus on plumage signaling."
          };
        } else {
          // Cross-Text Connections
          passage = "Text 1: Some urban planners argue that expanding public transit lines is the most effective way to reduce city traffic congestion. Text 2: A transportation study suggests that transit expansion only temporarily eases traffic; as soon as road congestion drops, new drivers are attracted to the empty spaces, returning traffic to original levels.";
          question_text = "Based on the texts, how would the authors of Text 2 respond to the planners in Text 1?";
          answer_choices = [
            { id: "A", text: "By arguing that public transit expansion has a self-limiting impact on traffic congestion." },
            { id: "B", text: "By agreeing that transit expansion is a durable solution to highway gridlock." },
            { id: "C", text: "By proving that public transit causes a permanent reduction in city emissions." },
            { id: "D", text: "By suggesting that city planners should completely eliminate transit infrastructure." }
          ];
          correct_answer = "A";
          correct_rationale = "Text 2 describes 'induced demand' where transit expansion temporarily eases traffic but eventually attracts more drivers, making the transit expansion's impact self-limiting.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Text 2 disagrees that it is a durable solution.",
            "C": "Emissions are not discussed in either text.",
            "D": "Text 2 discusses limitations of expansion but does not advocate for complete elimination."
          };
        }
      } else if (domLower.includes("information") || domLower.includes("ideas")) {
        if (skillLower.includes("central") || skillLower.includes("details")) {
          passage = "For decades, oceanographers believed deep-sea hydrothermal vents were isolated ecosystems powered entirely by local chemosynthesis. However, a new study reveals that organic matter from the surface ocean—specifically sinking marine snow—regularly reaches these depths and is consumed by vent species, showing that hydrothermal vents are biochemically linked to the surface world.";
          question_text = "Which choice best states the central idea of the text?";
          answer_choices = [
            { id: "A", text: "Hydrothermal vents are not as biologically isolated from surface ecosystems as previously believed." },
            { id: "B", text: "Marine snow is the primary source of carbon for all deep-sea marine life." },
            { id: "C", text: "Chemosynthesis is a less efficient metabolic pathway than photosynthesis in hydrothermal vents." },
            { id: "D", text: "Surface ocean currents are shifting organic matter away from deep-sea vent sites." }
          ];
          correct_answer = "A";
          correct_rationale = "The text highlights that organic matter from the surface regularly reaches hydrothermal vents and is consumed by vent species, directly challenging the idea of total ecosystem isolation.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "The text mentions marine snow reaches vents, but doesn't claim it is the primary source for 'all' deep-sea life.",
            "C": "The passage does not compare the efficiency of chemosynthesis vs. photosynthesis.",
            "D": "The passage states organic matter is successfully delivered, not shifted away."
          };
        } else if (skillLower.includes("evidence")) {
          passage = "A research team wants to test if light pollution decreases the foraging efficiency of bats. They measure the nocturnal hunting success of bats in areas with high artificial light and in completely dark control areas.";
          question_text = "Which finding, if true, would most directly support the team's hypothesis?";
          answer_choices = [
            { id: "A", text: "Bats in high artificial light areas captured significantly fewer insects per hour than bats in dark control areas." },
            { id: "B", text: "Bats in both illuminated and dark areas exhibited identical flight patterns and energy usage." },
            { id: "C", text: "Insect populations were larger in illuminated areas than in dark control areas." },
            { id: "D", text: "Bats in dark areas preferred nesting in caves located near illuminated cities." }
          ];
          correct_answer = "A";
          correct_rationale = "The hypothesis is that light pollution decreases foraging (hunting) efficiency. Capturing fewer insects per hour in illuminated areas directly supports this decrease.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Identical flight patterns and energy usage show no difference, which doesn't support the hypothesis.",
            "C": "Insect population size does not measure bat foraging efficiency directly.",
            "D": "Nesting preference does not measure foraging efficiency."
          };
        } else {
          // Inferences
          passage = "A study showed that when plants are exposed to drought conditions, they release volatile organic compounds (VOCs) that trigger defensive gene activation in neighboring plants. When neighboring plants had their VOC receptors blocked, they did not activate these defensive genes despite being adjacent to the drought-stressed plants.";
          question_text = "Based on the study, what inference can be made about neighboring plants' defense activation?";
          answer_choices = [
            { id: "A", text: "Neighboring plants rely on detecting airborne chemical signals from drought-stressed plants to trigger defensive gene activation." },
            { id: "B", text: "Neighboring plants can activate defensive genes through direct root contact alone." },
            { id: "C", text: "Neighboring plants with blocked VOC receptors are more drought-tolerant than unblocked plants." },
            { id: "D", text: "Drought-stressed plants only release VOCs when they are adjacent to unblocked neighbors." }
          ];
          correct_answer = "A";
          correct_rationale = "Since blocking the VOC receptors prevented defense activation despite proximity, neighboring plants must rely on detecting those airborne chemical signals (VOCs) to activate their defenses.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "The blocked receptors prevented activation, proving root contact alone did not trigger it.",
            "C": "Tolerance is not evaluated, only defense gene activation.",
            "D": "Drought-stressed plants release VOCs regardless of the neighbor's status; the blocking was on the neighbor."
          };
        }
      } else if (domLower.includes("expression")) {
        if (skillLower.includes("synthesis") || skillLower.includes("notes")) {
          passage = "While researching a topic, a student takes the following notes:\n- The Hubble Space Telescope was launched in 1990.\n- It orbits 340 miles above Earth's surface.\n- It has provided high-resolution images of distant galaxies.\n- The James Webb Space Telescope (JWST) was launched in 2021.\n- It orbits 1 million miles from Earth.\n- It can detect infrared light from the earliest stars.";
          question_text = "The student wants to compare the launch dates and orbital locations of the two telescopes. Which choice most effectively uses information from the notes to accomplish this goal?";
          answer_choices = [
            { id: "A", text: "Launched in 1990, the Hubble Space Telescope orbits 340 miles above Earth, whereas the James Webb Space Telescope was launched in 2021 and orbits 1 million miles away." },
            { id: "B", text: "The Hubble Space Telescope provides high-resolution images, while the James Webb Space Telescope detects infrared light from distant stars." },
            { id: "C", text: "Both the Hubble Space Telescope (launched 1990) and the James Webb Space Telescope (launched 2021) are powerful scientific instruments." },
            { id: "D", text: "Hubble orbits closely at 340 miles to capture galaxy images, but JWST orbits much further to observe the early universe." }
          ];
          correct_answer = "A";
          correct_rationale = "Choice A explicitly compares both the launch dates (1990 vs. 2021) and the orbital locations (340 miles vs. 1 million miles) as requested.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Compares scientific capabilities rather than launch dates and orbital locations.",
            "C": "Mentions launch dates but fails to include or compare orbital locations.",
            "D": "Mentions orbital locations but completely omits the launch dates."
          };
        } else {
          // Transitions
          passage = "Many historians argue that ancient Roman trade routes were primarily maritime. ________, recent terrestrial excavations have revealed an extensive overland network of roads connecting minor agrarian settlements with major shipping ports, suggesting land routes played a vital economic role.";
          question_text = "Which choice completes the text with the most logical transition?";
          answer_choices = [
            { id: "A", text: "However" },
            { id: "B", text: "Furthermore" },
            { id: "C", text: "Specifically" },
            { id: "D", text: "Therefore" }
          ];
          correct_answer = "A";
          correct_rationale = "The first sentence claims trade was 'primarily maritime'. The second sentence presents excavations showing land routes played a 'vital economic role'. This is a contrast, making 'However' the logical transition.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Furthermore is used for addition, which doesn't fit the contrast.",
            "C": "Specifically is used for illustration, which is incorrect because the terrestrial route findings dispute/complicate the maritime claim.",
            "D": "Therefore is used for cause-and-effect, which doesn't fit here."
          };
        }
      } else {
        // Standard English Conventions
        if (skillLower.includes("boundaries")) {
          passage = "The novel's protagonist is torn between two opposing worlds ________ the high-society circles of upper-class New York and the tight-knit immigrant community of the Lower East Side.";
          question_text = "Which choice completes the text so that it conforms to the conventions of Standard English?";
          answer_choices = [
            { id: "A", text: "worlds:" },
            { id: "B", text: "worlds" },
            { id: "C", text: "worlds, and" },
            { id: "D", text: "worlds; being" }
          ];
          correct_answer = "A";
          correct_rationale = "A colon is used to introduce an explanation or list that elaborates on the preceding independent clause ('two opposing worlds').";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Creates a run-on with no punctuation to separate the list from the main noun.",
            "C": "Incorrect comma placement and grammatical structure.",
            "D": "A semicolon must separate two independent clauses, and 'being...' is not an independent clause."
          };
        } else {
          passage = "Each of the participants in the clinical trials ________ required to submit a comprehensive health log and undergo bi-weekly physiological evaluations.";
          question_text = "Which choice completes the text so that it conforms to the conventions of Standard English?";
          answer_choices = [
            { id: "A", text: "was" },
            { id: "B", text: "were" },
            { id: "C", text: "are" },
            { id: "D", text: "have been" }
          ];
          correct_answer = "A";
          correct_rationale = "The subject of the sentence is 'Each', which is a singular indefinite pronoun. Therefore, it requires the singular past tense verb 'was'.";
          distractor_rationale = {
            "A": "Correct answer.",
            "B": "Incorrect plural form; mistakenly agrees with 'participants'.",
            "C": "Incorrect plural present form.",
            "D": "Incorrect plural present perfect form."
          };
        }
      }
    } else {
      // SAT Math
      if (domLower.includes("algebra")) {
        question_text = "A rental car company charges a flat fee of $30 plus $0.15 per mile driven. If a customer was charged $67.50, how many miles did they drive?";
        answer_choices = [
          { id: "A", text: "250" },
          { id: "B", text: "220" },
          { id: "C", text: "300" },
          { id: "D", text: "180" }
        ];
        correct_answer = "A";
        correct_rationale = "Formulate the equation: 30 + 0.15 * m = 67.50. Subtract 30 from both sides: 0.15 * m = 37.50. Divide by 0.15: m = 37.50 / 0.15 = 250 miles.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "Arithmetic error subtracting 30.",
          "C": "Divided 45 by 0.15.",
          "D": "Assumed flat fee was $40."
        };
      } else if (domLower.includes("advanced")) {
        question_text = "If f(x) = 2x^2 - 8x + 5, what is the minimum value of f(x)?";
        answer_choices = [
          { id: "A", text: "-3" },
          { id: "B", text: "5" },
          { id: "C", text: "2" },
          { id: "D", text: "-7" }
        ];
        correct_answer = "A";
        correct_rationale = "The vertex of a parabola in the form ax^2 + bx + c is at x = -b / (2a) = -(-8) / (2 * 2) = 8 / 4 = 2. Evaluate f(2) = 2(2)^2 - 8(2) + 5 = 2(4) - 16 + 5 = 8 - 16 + 5 = -3. Since a > 0, this is the minimum value.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "The y-intercept f(0), not the minimum.",
          "C": "The x-coordinate of the vertex, not the minimum value f(x).",
          "D": "Calculation error on exponent or signs."
        };
      } else if (domLower.includes("problem") || domLower.includes("data")) {
        question_text = "In a survey of 400 high school students, 60% participated in a school sport. Of those who participated in a sport, 25% were seniors. How many seniors surveyed participated in a sport?";
        answer_choices = [
          { id: "A", text: "60" },
          { id: "B", text: "100" },
          { id: "C", text: "150" },
          { id: "D", text: "40" }
        ];
        correct_answer = "A";
        correct_rationale = "Number of students participating in sports = 60% of 400 = 0.60 * 400 = 240. Number of seniors in sports = 25% of 240 = 0.25 * 240 = 60.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "Assumed 25% of 400 = 100 directly.",
          "C": "Calculation error.",
          "D": "Assumed 10% of 400."
        };
      } else {
        // Geometry / Trigonometry
        question_text = "A right triangle has a hypotenuse of length 13 inches and one leg of length 5 inches. What is the area of the triangle, in square inches?";
        answer_choices = [
          { id: "A", text: "30" },
          { id: "B", text: "60" },
          { id: "C", text: "65" },
          { id: "D", text: "12" }
        ];
        correct_answer = "A";
        correct_rationale = "By Pythagorean theorem, the second leg b = √(13^2 - 5^2) = √(169 - 25) = √144 = 12 inches. The area of a right triangle is (1/2) * base * height = (1/2) * 5 * 12 = 30 square inches.";
        distractor_rationale = {
          "A": "Correct answer.",
          "B": "Forgot to divide by 2: base * height = 60.",
          "C": "Multiplied hypotenuse and leg divided by 2.",
          "D": "Stated the second leg length instead of the area."
        };
      }
    }
  }

  // Double check if we should add feedback parameter info if present to simulate the loop retry visually
  if (feedback) {
    correct_rationale += ` [Incorporated Validator Feedback: ${feedback}]`;
  }

  return {
    pass1_draft: {
      passage,
      stimulus,
      question_text: `${question_text} (Draft)`,
      answer_choices,
      correct_answer,
      explanation: {
        correct_rationale: "Drafting: " + correct_rationale,
        distractor_rationale
      }
    },
    pass2_critique_checklist: {
      has_exactly_one_correct_answer: true,
      distractors_are_plausible: true,
      math_is_verified: true,
      style_rules_followed: true,
      suggested_improvements: "Ensure grammar is completely verified."
    },
    pass3_finalized: {
      question_id: qId,
      exam_type: exam,
      section,
      domain,
      skill_tag: skillTag,
      difficulty,
      passage,
      stimulus,
      question_text,
      answer_choices,
      correct_answer,
      explanation: {
        correct_rationale,
        distractor_rationale
      }
    }
  };
}


// ----------------------------------------------------
// Orchestrator: Loop, Retry, Escalation (Exam-Agnostic)
// ----------------------------------------------------
export async function runOrchestrationPipeline(params: {
  exam_type: string;
  section: string;
  domain: string;
  skill_tag: string;
  difficulty: string;
  config: any;
  question_id?: string;
  max_attempts?: number;
  onUpdate?: (run: PipelineRun) => void;
  userId?: string;
  initialFeedback?: string;
}): Promise<Question> {
  const { exam_type, section, domain, skill_tag, difficulty, config, userId } = params;
  const max_attempts = params.max_attempts || config.validation_rubric.max_attempts || 3;
  const qId = params.question_id || `q-${exam_type.toLowerCase()}-${uuidv4().slice(0, 8)}`;

  const run: PipelineRun = {
    question_id: qId,
    exam_type,
    section,
    domain,
    skill_tag,
    difficulty,
    current_attempt: 1,
    max_attempts,
    logs: [],
    status: "running",
    started_at: new Date().toISOString()
  };

  // Every addLog() call used to `await Database.savePipelineRun(run)`
  // directly — a full Mongo round-trip per log line, ~10+ per question,
  // all blocking generation. That's what fixed the crash (errors were
  // caught) but reintroduced the latency we're now removing.
  //
  // Fix: writes are chained onto this promise instead of awaited inline.
  // Chaining (not just firing each one independently) preserves write
  // ORDER — a fast write can never race ahead of and get overwritten by
  // an earlier, slower one landing after it. Each write's own errors are
  // swallowed inside persistRun so a DB hiccup can never escape as an
  // unhandled rejection, matching the crash-safety of the previous fix.
  let writeQueue: Promise<void> = Promise.resolve();

  const persistRun = async (): Promise<void> => {
    try {
      await Database.savePipelineRun(run);
    } catch (err) {
      // A failed log write (e.g. Atlas replica election, transient network
      // blip) must never abort real generation work. Log locally and move on.
      console.error(`[PIPELINE ${qId}] savePipelineRun failed (non-fatal, continuing):`, err);
    }
  };

  // Callers still `await addLog(...)` everywhere — that's fine and stays
  // non-blocking, because this function itself doesn't await the DB write;
  // it just appends to writeQueue and returns immediately.
  const addLog = async (type: PipelineStepLog["type"], message: string, details?: any): Promise<void> => {
    const step: PipelineStepLog = {
      timestamp: new Date().toISOString(),
      type,
      message,
      details
    };
    run.logs.push(step);
    writeQueue = writeQueue.then(persistRun);
    params.onUpdate?.(run);
  };

  // Call this right before any return/throw that hands the final result
  // back to the caller, so the HTTP response never returns before the
  // last log (including the terminal status) is actually persisted.
  const flushLogs = async (): Promise<void> => {
    await writeQueue;
  };

  await addLog("decision", `Starting Pipeline for ${exam_type} - ${section} - ${domain} (${skill_tag}). Max attempts = ${max_attempts}.`);

  let currentAttempt = 1;
  let lastFeedback: string | undefined = params.initialFeedback;
  let finalQuestion: Question | null = null;
  let lastDraftQuestion: Question | undefined;

  if (lastFeedback) {
    await addLog("decision", `Seeded with prior feedback before attempt 1: "${lastFeedback}"`);
  }

  while (currentAttempt <= max_attempts) {
    const fresh = await Database.getPipelineRunById(qId);
    if (fresh?.stop_requested) {
      console.log(`[PIPELINE ${qId}] stop_requested=true detected before attempt ${currentAttempt} — cancelling.`);
      run.status = "cancelled";
      await addLog("decision", `Pipeline stopped by user before attempt ${currentAttempt}.`);
      await flushLogs();
      throw new Error("CANCELLED: Generation stopped by user.");
    }
    run.current_attempt = currentAttempt;

    // Step 1: Generator drafts, critiques, finalizes
    const agentStepLogger = async (step: PipelineStepLog) => {
      await addLog(step.type, step.message, step.details);
    };

    let draftQuestion: Question;
    let isSimulatedDraft = false;
    // Generation now runs on Claude, so gate real-vs-simulated on the Anthropic
    // key (the validator/embeddings still use GEMINI_API_KEY separately).
    const key = process.env.ANTHROPIC_API_KEY;
    const hasApiKey = key && key !== "MY_ANTHROPIC_API_KEY" && key !== "";

    if (!hasApiKey) {
      isSimulatedDraft = true;
      await agentStepLogger({
        timestamp: new Date().toISOString(),
        type: 'draft',
        message: `Generator Agent: Starting simulated generation for ${section} / ${domain} / ${skill_tag} / ${difficulty} (Attempt ${currentAttempt})`,
      });
      await agentStepLogger({
        timestamp: new Date().toISOString(),
        type: 'rag_retrieval',
        message: `RAG: Skipped (simulated mode).`,
      });
      const simulatedResult = getSimulatedQuestion(
        exam_type,
        section,
        domain,
        skill_tag,
        difficulty,
        currentAttempt,
        lastFeedback
      );
      draftQuestion = simulatedResult.pass3_finalized;
      await agentStepLogger({
        timestamp: new Date().toISOString(),
        type: 'finalize',
        message: `Generator Agent: Simulated question generated successfully. ID: ${draftQuestion.question_id}`,
      });
    } else {
      try {
        const difficultyDefinition = (config?.difficulty_scale || [])
          .find((d: { label: string; definition: string }) => d.label === difficulty)?.definition;

        const result = await runGeneratorAgent({
          examType: exam_type,
          subject: section,
          domain,
          skill: skill_tag,
          difficulty,
          difficultyDefinition,
          attempt: currentAttempt,
          onStep: agentStepLogger,
          feedback: lastFeedback,
          count: 1,
          chunkSize: 1
        });
        if (!result.questions || result.questions.length === 0) {
          throw new Error("Generator Agent returned no questions.");
        }
        draftQuestion = result.questions[0];
      } catch (err: any) {
        isSimulatedDraft = true;
        await agentStepLogger({
          timestamp: new Date().toISOString(),
          type: 'draft',
          message: `Generator Agent: Real LLM call failed (${err.message}). Falling back to Simulated mode (Attempt ${currentAttempt})`,
        });
        const simulatedResult = getSimulatedQuestion(
          exam_type,
          section,
          domain,
          skill_tag,
          difficulty,
          currentAttempt,
          lastFeedback
        );
        draftQuestion = simulatedResult.pass3_finalized;
        await agentStepLogger({
          timestamp: new Date().toISOString(),
          type: 'finalize',
          message: `Generator Agent: Simulated question generated successfully. ID: ${draftQuestion.question_id}`,
        });
      }
    }

    draftQuestion.question_id = qId;
    draftQuestion.generation_attempt = currentAttempt;
    // Stamp the source explicitly so a simulated/template draft can never be
    // silently mistaken for a real Claude generation downstream (export,
    // review UI, live bank). See the approval gate below, which uses this
    // same flag to refuse to auto-approve simulated content.
    draftQuestion.generation_source = isSimulatedDraft ? "simulated_fallback" : "claude";
    lastDraftQuestion = draftQuestion;

    // Step 2: Pre-Validation Filter (cheap checks)
    await addLog("pre_filter", `Running Pre-Validation Filters (Attempt ${currentAttempt})...`);
    const completeness = checkQuestionCompleteness(draftQuestion);
    if (!completeness.complete) {
      await addLog("pre_filter", `Pre-Validation: FAIL (Incomplete question — ${completeness.reason}). Forcing instant regeneration.`);
      currentAttempt++;
      lastFeedback = `The draft was incomplete: ${completeness.reason} Please output a fully complete question with all answer choices, a valid correct_answer, and a rationale for the correct answer.`;
      continue;
    }

    // Step 2b: Deterministic Sanity Check (Pre-Validation Filter)
    const mathCheck = runMathSanityCheck(draftQuestion);
    if (!mathCheck.passed) {
      await addLog("pre_filter", `Math & Choice Sanity Check: FAIL — ${mathCheck.reason}`);
      lastFeedback = mathCheck.reason;
      currentAttempt++;
      continue;
    } else if (mathCheck.skipped) {
      await addLog("pre_filter", "Math & Choice Sanity Check: SKIPPED (no exact computed answer provided — deferring to Validator).");
    } else {
      await addLog("pre_filter", "Math & Choice Sanity Check: PASS — computed answer matches claimed correct_answer.");
    }

    // Step 3: Similarity check (before validator)
    await addLog("pre_filter", "Running similarity check against question bank...");
    const simResult = await runSimilarityCheck(draftQuestion.question_text, draftQuestion.passage, exam_type);
    draftQuestion.similarity_score = simResult.similarity_score;
    draftQuestion.similar_question_id = simResult.similar_question_id;
    if (simResult.embedding) {
      draftQuestion.embedding = simResult.embedding;
    }

    if (simResult.similarity_score > 0.85 && !isSimulatedDraft) {
      await addLog("pre_filter", `Pre-Validation Warning: High similarity detected (${simResult.similarity_score}) with question ${simResult.similar_question_id}. Forcing regeneration.`);
      lastFeedback = `Your previous question was too similar to an existing question in the bank (similarity score: ${simResult.similarity_score}). You MUST generate a completely different question with a new scenario, different numbers, and different wording.`;
      currentAttempt++;
      continue;
    } else if (simResult.similarity_score > 0.85 && isSimulatedDraft) {
      await addLog("pre_filter", `Pre-Validation Info: High similarity (${simResult.similarity_score}) detected on simulated fallback template. Bypassing similarity block for simulated fallback mode.`);
    } else {
      await addLog("pre_filter", `Pre-Validation PASS: Originality check completed (similarity score ${simResult.similarity_score}).`);
    }

    // Step 3b: Structured Debug Logging
    const choiceMap = Object.fromEntries(
      (draftQuestion.answer_choices || []).map(c => [`option_${c.id}`, c.text])
    );
    console.log("[Pipeline Step Log]", JSON.stringify({
      computed_answer: draftQuestion.metadata?.exam_specific?.exact_computed_answer ?? "N/A",
      option_A: choiceMap["option_A"] || "",
      option_B: choiceMap["option_B"] || "",
      option_C: choiceMap["option_C"] || "",
      option_D: choiceMap["option_D"] || "",
      stored_correct_answer: draftQuestion.correct_answer,
      explanation_final_answer: draftQuestion.explanation?.correct_rationale ? draftQuestion.explanation.correct_rationale.slice(0, 150) : "",
      sanity_check_result: mathCheck.passed ? (mathCheck.skipped ? "SKIPPED" : "PASS") : "FAIL"
    }, null, 2));

    // Step 4: Independent Validation
    let validationBlock: ValidationBlock;
    try {
      validationBlock = await runValidatorAgent({
        question: draftQuestion,
        config,
        onStep: agentStepLogger
      });
    } catch (vErr) {
      console.warn("[Pipeline] runValidatorAgent call threw an error. Utilizing resilient fallback validation:", vErr);
      const { getSimulatedValidation } = await import("./agents/validatorAgent");
      validationBlock = getSimulatedValidation(draftQuestion, currentAttempt, false);
    }

    draftQuestion.validation = validationBlock;
    finalQuestion = draftQuestion;

    // Add validation to Audit Logs
    const auditLog: ValidationAuditLog = {
      id: `audit-${qId}-${currentAttempt}`,
      question_id: qId,
      exam_type,
      section,
      domain,
      skill_tag,
      difficulty,
      accuracy_score: validationBlock.accuracy_score,
      validation_status: validationBlock.validation_status,
      generation_attempt: currentAttempt,
      checks: validationBlock.checks,
      feedback: validationBlock.feedback,
      timestamp: new Date().toISOString()
    };
    await Database.addAuditLog(auditLog);

    await addLog("validate", `Validation Complete (Attempt ${currentAttempt}): STATUS = ${validationBlock.validation_status}, SCORE = ${validationBlock.accuracy_score}/100.`);

    const finalCompleteness = checkQuestionCompleteness(draftQuestion);

    // A simulated-fallback draft must never be auto-approved into the live
    // bank, no matter what the validator says about it — the validator is
    // scoring a canned template, not a real generation, so a "PASS" here
    // says nothing about actual question quality. Force it straight to
    // escalation so a human reviews it (or, more likely, re-triggers
    // generation once the rate limit/outage clears) instead of it silently
    // polluting the approved question bank.
    if (isSimulatedDraft) {
      await addLog("decision", `Attempt ${currentAttempt} used simulated-fallback content (real Claude call failed) — never auto-approved regardless of validator result. Escalating for human review.`);
      lastFeedback = "The previous attempt's real Claude call failed (rate limit/timeout/error) and fell back to a template placeholder. Please retry a real generation.";
      currentAttempt++;
      continue;
    }

    if (validationBlock.validation_status === "PASS" && finalCompleteness.complete) {
      draftQuestion.status = "approved";
      await Database.saveQuestion(draftQuestion);

      run.status = "completed_pass";
      run.final_question = draftQuestion;
      await addLog("decision", `Pipeline SUCCESS on attempt ${currentAttempt}. Question approved and added to active bank.`);
      await flushLogs();
      return draftQuestion;
    } else {
      const failureReason = validationBlock.validation_status !== "PASS"
        ? validationBlock.feedback
        : `Validator passed the question but it failed the completeness gate — ${finalCompleteness.reason}`;
      await addLog("decision", `Attempt ${currentAttempt} FAILED validation. Actionable feedback: "${failureReason}"`);

      // NOTE: we intentionally do NOT write this failed attempt to the
      // questions collection. It's already fully captured in audit_logs
      // (see addAuditLog above). Writing it here as well used to create a
      // duplicate/extra document for every failed attempt — inflating the
      // Live Question Bank count for combos that eventually succeeded, and
      // creating a literal duplicate (this doc + the final escalated save
      // below) for combos that ultimately got escalated.
      lastFeedback = failureReason;
      currentAttempt++;
    }
  }

  // If we reach here, we exceeded max attempts
  const questionToEscalate = finalQuestion || lastDraftQuestion;
  if (questionToEscalate) {
    questionToEscalate.status = "escalated";
    await Database.saveQuestion(questionToEscalate);

    run.status = "completed_escalated";
    run.final_question = questionToEscalate;
    await addLog("decision", `Orchestrator Limit Reached: Failed after ${max_attempts} attempts. Escalating to human-review queue with full history.`);
    await flushLogs();
    return questionToEscalate;
  }

  run.status = "failed";
  await addLog("decision", "Pipeline terminated due to critical failures.");
  await flushLogs();
  throw new Error("Pipeline failed to produce any question.");
}

// ----------------------------------------------------
// Batch Generation: "Generate All Combinations" (Exam-Agnostic)
// ----------------------------------------------------
// Builds the full cross-product of every section × domain × skill × difficulty
// defined in the exam's config file. Nothing here is hardcoded to any specific
// exam (SAT/GRE/etc) — it is derived entirely from whatever config is passed in,
// so adding a new exam config automatically gets batch generation for free.
export function buildAllCombinations(
  config: any,
  difficulties?: string[],
  sections?: string[],
  domains?: string[],
  skills?: string[]
): Array<{ section: string; domain: string; skill_tag: string; difficulty: string }> {
  const combos: Array<{ section: string; domain: string; skill_tag: string; difficulty: string }> = [];

  const difficultyLabels =
    (difficulties && difficulties.length > 0)
      ? difficulties
      : (config.difficulty_scale || []).map((d: { label: string }) => d.label);

  // Each filter is optional; when provided, only matching section/domain/skill
  // combos are included (case-insensitive match).
  const sectionSet = sections && sections.length > 0
    ? new Set(sections.map(s => s.toLowerCase()))
    : null;
  const domainSet = domains && domains.length > 0
    ? new Set(domains.map(d => d.toLowerCase()))
    : null;
  const skillSet = skills && skills.length > 0
    ? new Set(skills.map(s => s.toLowerCase()))
    : null;

  for (const section of config.sections || []) {
    if (sectionSet && !sectionSet.has(section.name.toLowerCase())) continue;
    for (const domain of section.domains || []) {
      if (domainSet && !domainSet.has(domain.name.toLowerCase())) continue;
      for (const skill of domain.skills || []) {
        if (skillSet && !skillSet.has(skill.toLowerCase())) continue;
        for (const difficulty of difficultyLabels) {
          combos.push({
            section: section.name,
            domain: domain.name,
            skill_tag: skill,
            difficulty
          });
        }
      }
    }
  }

  return combos;
}

// Creates and persists the initial BatchRun record (all items "pending"),
// then returns it immediately so the caller (API route) can respond fast
// with a batch_id while the actual generation continues in the background.
export async function createBatchRun(params: {
  exam_type: string;
  config: any;
  difficulties?: string[];
  sections?: string[];
  domains?: string[];
  skills?: string[];
  userId?: string;
}): Promise<BatchRun> {
  const { exam_type, config, difficulties, sections, domains, skills, userId } = params;
  const combos = buildAllCombinations(config, difficulties, sections, domains, skills);

  const items: BatchRunItem[] = combos.map(c => ({
    section: c.section,
    domain: c.domain,
    skill_tag: c.skill_tag,
    difficulty: c.difficulty,
    status: "pending"
  }));

  const batch: BatchRun = {
    batch_id: `batch-${exam_type.toLowerCase()}-${uuidv4().slice(0, 8)}`,
    exam_type,
    total: items.length,
    completed: 0,
    approved: 0,
    escalated: 0,
    failed: 0,
    cancelled: 0,
    status: "running",
    items,
    started_at: new Date().toISOString(),
    userId
  };

  await Database.saveBatchRun(batch);
  return batch;
}

// Processes a previously-created BatchRun, reusing the exact same
// runOrchestrationPipeline used for single-question generation (same RAG
// rotation/reset, same validation, same everything).
// Intended to be invoked without awaiting from the API route ("fire and forget"),
// with progress persisted to MongoDB after every item so the UI can poll it.
// Runs up to BATCH_GENERATION_CONCURRENCY items in parallel — safe because
// buildAllCombinations() never repeats a combo within a batch (so no two
// workers ever hit the same RAG rotation-tracking key), and item claiming
// below has no `await` between read and increment.
function getBatchConcurrency(): number {
  const raw = parseInt(process.env.BATCH_GENERATION_CONCURRENCY || "3", 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 8); // ceiling to avoid tripping API rate limits
}

// Must cover runOrchestrationPipeline's own REAL worst case per attempt, not
// the ~132s estimate previously used here — that estimate only counted ONE
// generator call, but generateChunk() actually makes THREE sequential Claude
// calls per attempt (create_scenario_draft, solve_scenario,
// generate_wrong_choices), each with its own 45s ceiling
// (REQUEST_TIMEOUT_MS in generatorAgent.ts) = up to 135s, not 45s. Likewise
// both embedText() calls (RAG retrieval + similarity check) can each retry
// up to 3x at 12s + backoff = ~39s worst case, not the 12s "similarity
// embed" figure previously assumed. Real worst case per attempt:
//   3 generator calls (135s) + RAG embed (39s) + similarity embed (39s)
//   + validator 3-model fallback chain (36s) = ~249s/attempt
//   x max_attempts (3) = ~747s
// The previous 600s ceiling (raised from 420s to match GENERATE_TIMEOUT_MS
// in server.ts) still sat BELOW that real worst case — which is exactly why
// Hard items (more likely to hit near-max latency and retries on every
// step, since they're harder to draft/critique) kept getting killed and
// marked "failed" instead of finishing. Raised to 900s (15 min) so it
// comfortably covers the true ~747s worst case with margin.
// NOTE: GENERATE_TIMEOUT_MS in server.ts must be raised to the same value —
// it wraps the identical runOrchestrationPipeline call for the
// single-question endpoint, so leaving it at 600000 there would just move
// this same failure to that code path instead of fixing it.
const BATCH_ITEM_TIMEOUT_MS = 900000;

export async function processBatchRun(params: {
  batch: BatchRun;
  config: any;
  userId?: string;
  onUpdate?: (batch: BatchRun) => void;
}): Promise<BatchRun> {
  const { batch, config, userId } = params;

  const persist = async () => {
    await Database.saveBatchRun(batch);
    params.onUpdate?.(batch);
  };

  const runItem = async (item: BatchRunItem) => {
    item.status = "running";
    item.started_at = new Date().toISOString();
    await persist();

    try {
      const question = await Promise.race([
        runOrchestrationPipeline({
          exam_type: batch.exam_type,
          section: item.section,
          domain: item.domain,
          skill_tag: item.skill_tag,
          difficulty: item.difficulty,
          config,
          userId,
          initialFeedback: item.initialFeedback,
          // Surface the latest internal step (generation, RAG, validation,
          // retries) on this item in real time, instead of the tracker only
          // moving when the whole item finishes. Requires `last_message?:
          // string` to exist on BatchRunItem in types.ts.
          onUpdate: (run) => {
            // Capture the id as soon as it exists so a batch-level stop
            // request (see the /stop route) can reach this specific
            // in-flight pipeline run instead of only being noticed after
            // it finishes.
            item.question_id = run.question_id;
            item.last_message = run.logs[run.logs.length - 1]?.message;
            params.onUpdate?.(batch);
          }
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out after ${BATCH_ITEM_TIMEOUT_MS / 1000}s.`)), BATCH_ITEM_TIMEOUT_MS);
        })
      ]);

      item.status = "completed";
      item.question_id = question.question_id;
      item.question_status = question.status;
      item.is_simulated = question.generation_source === "simulated_fallback";
      batch.completed++;
      // Only count as "approved" if the validator actually passed it —
      // "escalated" (max_attempts exhausted) is not a success.
      if (question.status === "approved") {
        batch.approved++;
      } else if (question.status === "escalated") {
        batch.escalated++;
      }
    } catch (err: any) {
      // A user-initiated Stop surfaces here as a "CANCELLED: ..." error
      // (thrown by runOrchestrationPipeline's stop_requested check) — that's
      // not a technical failure, so give it its own bucket instead of
      // inflating `failed` with something that isn't actually an error.
      const wasCancelled = typeof err?.message === "string" && err.message.startsWith("CANCELLED");
      item.status = wasCancelled ? "cancelled" : "failed";
      item.error = err?.message || "Unknown error during generation.";
      if (wasCancelled) {
        batch.cancelled++;
      } else {
        batch.failed++;
      }
    }

    item.finished_at = new Date().toISOString();
    await persist();
  };

  let nextIndex = 0;
  let stopRequested = false;

  const worker = async () => {
    while (true) {
      if (!stopRequested) {
        const fresh = await Database.getBatchRunById(batch.batch_id);
        if (fresh?.stop_requested) {
          stopRequested = true;
          console.log(`[BATCH ${batch.batch_id}] Worker noticed stop_requested=true. No new items will start.`);
        }
      }
      if (stopRequested) return;

      const index = nextIndex;
      if (index >= batch.items.length) return;
      nextIndex++;

      await runItem(batch.items[index]);
    }
  };

  const workerCount = Math.min(getBatchConcurrency(), batch.items.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (stopRequested) {
    const skippedCount = batch.items.filter(i => i.status === "pending").length;
    for (const item of batch.items) {
      if (item.status === "pending") {
        item.status = "skipped";
      }
    }
    console.log(`[BATCH ${batch.batch_id}] Stopped. ${batch.completed}/${batch.total} completed before stop, ${skippedCount} item(s) skipped.`);
    batch.status = "stopped";
    batch.finished_at = new Date().toISOString();
    await persist();
    return batch;
  }

  // "completed" only when every item was processed AND approved; escalations
  // or failures get their own status since they still need human review.
  if (batch.failed > 0) {
    batch.status = batch.completed > 0 ? "completed_with_errors" : "failed";
  } else if (batch.escalated > 0) {
    batch.status = "completed_with_escalations";
  } else {
    batch.status = "completed";
  }
  batch.finished_at = new Date().toISOString();
  await persist();

  return batch;
}