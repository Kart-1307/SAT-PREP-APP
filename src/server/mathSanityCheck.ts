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
//
// BLIND SPOT (fixed here): the equation check above only proves that
// verification.variable_value satisfies equation_lhs = equation_rhs. It
// never compared that value against exact_computed_answer — the string
// that actually becomes the correct answer choice text in the assembled
// question. If the solver model's exact_computed_answer drifts from the
// value it just verified (e.g. leaves a stray intermediate value like
// "-800/3" while variable_value/the explanation correctly say "-160"),
// the check above still returns PASS, and the mismatch only surfaces
// later at the (slower, less reliable) independent Validator step —
// burning a full attempt. For the single-variable case we now also
// assert exact_computed_answer is numerically equivalent to
// variable_value. This is skipped for multi-variable systems (e.g. "x, y")
// since exact_computed_answer there is often a derived expression, not
// one of the raw variable values, and false-failing that would be worse
// than deferring to the Validator.
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

    // Cross-check: does the value we just verified actually match the
    // string that will become the correct answer choice? Only meaningful
    // for the single-variable case (see comment above) AND only when
    // exact_computed_answer is itself a bare scalar (e.g. "-160" or "10/3").
    //
    // IMPORTANT: for skills like "Equivalent expressions", the verification
    // block means something different — variable_value (e.g. x = 2) is just
    // a TEST POINT substituted into both the original and the factored
    // expression to prove they're identical; it is NOT the answer. In that
    // case exact_computed_answer is the factored expression itself (e.g.
    // "(2x + 3)(3x^2 - 4)"), which will never numerically equal a test-point
    // value like 2 — comparing them was a false-positive bug that rejected
    // every correct equivalent-expression question. Detect this by trying
    // to evaluate exact_computed_answer as a scope-free scalar first: if it
    // contains a free variable (or otherwise doesn't reduce to a plain
    // number), it's an expression/identity answer, not a numeric one, so we
    // defer to the Validator instead of flagging a mismatch.
    if (variables.length === 1) {
      const exactComputedAnswer = question.metadata?.exam_specific?.exact_computed_answer;
      if (exactComputedAnswer !== undefined && exactComputedAnswer !== null && String(exactComputedAnswer).trim() !== '') {
        let answerAsScalar: number | null = null;
        try {
          const evaluated = evaluate(String(exactComputedAnswer)); // no scope — any free variable throws
          if (typeof evaluated === 'number' && !isNaN(evaluated)) {
            answerAsScalar = evaluated;
          }
        } catch {
          // Not a bare scalar (contains a free variable, or isn't a valid
          // standalone expression at all, e.g. "y = 2.5x + 5") — this is an
          // expression-form answer, not a numeric one. Nothing to
          // cross-check here; defer to the Validator.
        }

        if (answerAsScalar !== null) {
          const EPSILON = 0.0001;
          const answerMatchesVerifiedValue =
            Math.abs(answerAsScalar - values[0]) < EPSILON ||
            Math.abs((answerAsScalar - values[0]) / (values[0] || 1)) < EPSILON;

          if (!answerMatchesVerifiedValue) {
            return {
              passed: false,
              skipped: false,
              reason: `Math sanity check FAILED: the verification equation checks out for ${variables[0]} = ${values[0]}, but the answer choice text ("${exactComputedAnswer}") does not match ${values[0]} — exact_computed_answer has drifted from the value that was actually verified. SPECIFIC FIX REQUIRED: set exact_computed_answer (and the correct answer choice) to ${values[0]}, not "${exactComputedAnswer}".`,
            };
          }
        }
      }
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