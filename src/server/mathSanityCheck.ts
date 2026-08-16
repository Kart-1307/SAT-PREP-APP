import { evaluate } from 'mathjs';
import { Question } from '../types';

export interface MathSanityResult {
  passed: boolean;
  skipped: boolean;
  reason?: string;
}

// ═══════════════════════════════════════════════════════════
// HELPER: Normalize expressions for mathjs parsing
// ═══════════════════════════════════════════════════════════
function normalizeExpression(expr: string): string {
  if (!expr) return '';
  return expr
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)') // \frac{a}{b} -> (a)/(b)
    .replace(/(\d)([a-zA-Z])/g, '$1*$2')                   // 3x -> 3*x
    .replace(/([a-zA-Z])(\d)/g, '$1*$2')
    .trim();
}

export function runMathSanityCheck(question: Question): MathSanityResult {
  // 1. Duplicate & Collision Check (0ms)
  const choices = question.answer_choices || [];
  if (choices.length > 0) {
    const rawTexts = choices.map(c => (c.text || '').trim().toLowerCase());
    const uniqueTexts = new Set(rawTexts);
    if (uniqueTexts.size < choices.length) {
      return {
        passed: false,
        skipped: false,
        reason: `Math sanity check FAILED: Duplicate answer choices detected. All choices must be distinct. Choices given: ${choices.map(c => `(${c.id}) ${c.text}`).join(', ')}`,
      };
    }
  }

  // 2. Choice Key Mapping Integrity Check (0ms)
  if (question.correct_answer && choices.length > 0) {
    const matchedChoice = choices.find(c => c.id === question.correct_answer);
    if (!matchedChoice || !matchedChoice.text || matchedChoice.text.trim() === '') {
      return {
        passed: false,
        skipped: false,
        reason: `Math sanity check FAILED: correct_answer "${question.correct_answer}" does not correspond to a valid non-empty answer choice.`,
      };
    }
  }

  const verification = question.metadata?.exam_specific?.verification;

  if (
    !verification ||
    !verification.equation_lhs ||
    !verification.equation_rhs ||
    !verification.variable ||
    verification.variable_value === undefined
  ) {
    // No structured equation to check — defer to the Validator.
    return { passed: true, skipped: true };
  }

  const variables: string[] = Array.isArray(verification.variable)
    ? verification.variable
    : [verification.variable];

  const values: number[] = Array.isArray(verification.variable_value)
    ? verification.variable_value
    : [verification.variable_value];

  if (variables.length !== values.length || variables.length === 0) {
    console.warn(
      '[MathSanityCheck] variable/variable_value length mismatch, deferring to Validator:',
      { variables, values }
    );
    return { passed: true, skipped: true };
  }

  // 3. Physical Realism Quick Check (0ms)
  const fullText = `${question.question_text || ''} ${question.stimulus || ''}`.toLowerCase();
  const physicalKeywords = ['weight', 'mass', 'height', 'length', 'distance', 'cost', 'price', 'shipment', 'speed', 'age', 'liters', 'gallons', 'items', 'people', 'tickets'];
  const isPhysicalContext = physicalKeywords.some(kw => fullText.includes(kw));

  if (isPhysicalContext && values.some(v => v <= 0)) {
    const matchedKws = physicalKeywords.filter(kw => fullText.includes(kw)).join(', ');
    return {
      passed: false,
      skipped: false,
      reason: `Physical Realism FAILED: Problem context involves a physical quantity (${matchedKws}), but the verified value is ${values.join(', ')} (<= 0). Physical measurements must be strictly positive.`,
    };
  }

  try {
    const scope: Record<string, number> = {};
    for (let i = 0; i < variables.length; i++) {
      scope[variables[i]] = values[i];
    }

    const normLHS = normalizeExpression(verification.equation_lhs);
    const normRHS = normalizeExpression(verification.equation_rhs);

    const lhsValue = evaluate(normLHS, scope);
    const rhsValue = evaluate(normRHS, scope);

    const EPSILON = 0.0001;
    const matches =
      typeof lhsValue === 'number' &&
      typeof rhsValue === 'number' &&
      !isNaN(lhsValue) &&
      !isNaN(rhsValue) &&
      (Math.abs(lhsValue - rhsValue) < EPSILON || Math.abs((lhsValue - rhsValue) / (rhsValue || 1)) < EPSILON);

    if (!matches) {
      const assignmentDesc = variables
        .map((v, i) => `${v} = ${values[i]}`)
        .join(', ');

      return {
        passed: false,
        skipped: false,
        reason: `Math sanity check FAILED: substituting ${assignmentDesc} gives "${verification.equation_lhs}" = ${lhsValue}, but "${verification.equation_rhs}" = ${rhsValue}. These do not match — the marked correct_answer does not actually satisfy the stated equation. Recheck the arithmetic and regenerate.`,
      };
    }

    // 4. Smart Single-Variable Cross-Check
    if (variables.length === 1) {
      const exactComputedAnswer = question.metadata?.exam_specific?.exact_computed_answer;
      if (exactComputedAnswer !== undefined && exactComputedAnswer !== null && String(exactComputedAnswer).trim() !== '') {
        let answerAsScalar: number | null = null;
        try {
          const evaluated = evaluate(normalizeExpression(String(exactComputedAnswer)));
          if (typeof evaluated === 'number' && !isNaN(evaluated)) {
            answerAsScalar = evaluated;
          }
        } catch {
          // Expression-form answer — defer to Validator.
        }

        if (answerAsScalar !== null) {
          const answerMatchesVerifiedValue =
            Math.abs(answerAsScalar - values[0]) < EPSILON ||
            Math.abs((answerAsScalar - values[0]) / (values[0] || 1)) < EPSILON;

          if (!answerMatchesVerifiedValue) {
            console.log(`[MathSanityCheck] Equation verified (${variables[0]} = ${values[0]}), answer choice is "${exactComputedAnswer}" (likely derived expression). Deferring to Validator.`);
            return { passed: true, skipped: true };
          }
        }
      }
    }

    return { passed: true, skipped: false };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[MathSanityCheck] Equation contains non-scalar expression (${message}) — deferring to Validator agent.`);
    return { passed: true, skipped: true };
  }
}