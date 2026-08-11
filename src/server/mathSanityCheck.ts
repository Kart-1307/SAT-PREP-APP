import { evaluate } from 'mathjs';
import { Question } from '../types';

// ═══════════════════════════════════════════════════════════
// Deterministic Math Sanity Check (Pre-Validation Filter)
//
// Does NOT ask an AI whether the math is right. Instead, it
// takes the equation the Generator produced, substitutes the
// claimed answer(s) back in, and checks both sides are equal —
// the same way you'd check your own work with a calculator.
//
// This only runs when the Generator provided a structured
// "verification" block (equation_lhs, equation_rhs, variable,
// variable_value). Supports both single-variable equations
// (variable: "x", variable_value: 6) and multi-variable systems
// (variable: ["x","y"], variable_value: [6,2]) — the latter is
// needed for categories like "Linear equations in two variables",
// where a single-variable scope caused mathjs to throw
// "Undefined symbol y" and silently skip every item in that
// category.
//
// If that block is missing, malformed, or can't be evaluated
// (e.g. geometry, word problems without a clean equation), the
// check is SKIPPED — not failed — and math correctness is left
// to the Validator as before.
// ═══════════════════════════════════════════════════════════

export interface MathSanityResult {
  passed: boolean;
  skipped: boolean;
  reason?: string;
}

export function runMathSanityCheck(question: Question): MathSanityResult {
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

  // Normalize variable/variable_value to arrays so we can handle both
  // single-variable equations and multi-variable systems (e.g. "Linear
  // equations in two variables") through the same evaluation path.
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

  try {
    const scope: Record<string, number> = {};
    for (let i = 0; i < variables.length; i++) {
      scope[variables[i]] = values[i];
    }

    const lhsValue = evaluate(verification.equation_lhs, scope);
    const rhsValue = evaluate(verification.equation_rhs, scope);

    const EPSILON = 0.0001;
    const matches =
      typeof lhsValue === 'number' &&
      typeof rhsValue === 'number' &&
      Math.abs(lhsValue - rhsValue) < EPSILON;

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

    return { passed: true, skipped: false };

  } catch (err) {
    // If mathjs can't parse/evaluate it, don't block the pipeline —
    // defer to the Validator rather than false-failing a valid question.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[MathSanityCheck] Equation contains non-scalar expression (${message}) — deferring to Validator agent.`);
    return { passed: true, skipped: true };
  }
}