import { evaluate } from 'mathjs';
import { Question } from '../types';

// ═══════════════════════════════════════════════════════════
// Deterministic Math Sanity Check (Pre-Validation Filter)
//
// Does NOT ask an AI whether the math is right. Instead, it
// takes the equation the Generator produced, substitutes the
// claimed answer back in, and checks both sides are equal —
// the same way you'd check your own work with a calculator.
//
// This only runs when the Generator provided a structured
// "verification" block (equation_lhs, equation_rhs, variable,
// variable_value). If that block is missing or can't be
// evaluated (e.g. geometry, word problems without a clean
// equation), the check is SKIPPED — not failed — and math
// correctness is left to the Validator as before.
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

  try {
    const scope: Record<string, number> = {
      [verification.variable]: verification.variable_value,
    };

    const lhsValue = evaluate(verification.equation_lhs, scope);
    const rhsValue = evaluate(verification.equation_rhs, scope);

    const EPSILON = 0.0001;
    const matches =
      typeof lhsValue === 'number' &&
      typeof rhsValue === 'number' &&
      Math.abs(lhsValue - rhsValue) < EPSILON;

    if (!matches) {
      return {
        passed: false,
        skipped: false,
        reason: `Math sanity check FAILED: substituting ${verification.variable} = ${verification.variable_value} gives "${verification.equation_lhs}" = ${lhsValue}, but "${verification.equation_rhs}" = ${rhsValue}. These do not match — the marked correct_answer does not actually satisfy the stated equation. Recheck the arithmetic and regenerate.`,
      };
    }

    return { passed: true, skipped: false };

  } catch (err) {
    // If mathjs can't parse/evaluate it, don't block the pipeline —
    // defer to the Validator rather than false-failing a valid question.
    console.warn('[MathSanityCheck] Could not evaluate equation, deferring to Validator:', err);
    return { passed: true, skipped: true };
  }
}