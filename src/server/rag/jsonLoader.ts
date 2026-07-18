import fs from 'fs';

// ─────────────────────────────────────────────────────────
// Unified shape used across the RAG system (Math + English)
// ─────────────────────────────────────────────────────────
export interface JSONQuestion {
  question_id: string;
  exam: string;
  subject: string;          // "Math" or "English" / "Reading and Writing"
  difficulty: string;
  domain: string;
  skill: string;
  page?: number;
  question_text: string;

  // Math-specific fields (image-based)
  question_image?: string;
  rationale_text?: string;
  rationale_image?: string;
  figure_images?: string[];
  question_type?: 'MCQ' | 'NUMERIC';
  options?: Record<string, string>;   // e.g. { A: "options/xxx_A.png", ... }
  accepted_answers?: string[];        // e.g. ["403"] or ["D"]

  // English-specific fields (text-based)
  answer_choices?: Array<{
    choice_id: string;
    choice_text: string;
  }>;
  correct_answer?: string;
  explanation?: string;
}

// ─────────────────────────────────────────────────────────
// MATH LOADER
// ─────────────────────────────────────────────────────────
interface RawMathQuestion {
  question_id: string;
  exam: string;
  subject: string;
  difficulty: string;
  domain: string;
  skill: string;
  page?: number;
  question_text: string;
  question_image?: string;
  rationale_text?: string;
  rationale_image?: string;
  figure_images?: string[];
  question_type?: string;
  options?: Record<string, string>;
  accepted_answers?: string[];
}

export async function loadMathQuestionsFromJSON(
  filePath: string
): Promise<JSONQuestion[]> {
  if (!fs.existsSync(filePath)) {
    console.warn(`[JSONLoader] Math file not found: ${filePath}`);
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const questions: RawMathQuestion[] = JSON.parse(raw);

    const mapped: JSONQuestion[] = questions.map((q) => ({
      question_id: q.question_id,
      exam: q.exam,
      subject: q.subject,
      difficulty: q.difficulty,
      domain: q.domain,
      skill: q.skill,
      page: q.page,
      question_text: q.question_text || '',
      question_image: q.question_image,
      rationale_text: q.rationale_text,
      rationale_image: q.rationale_image,
      figure_images: q.figure_images || [],
      question_type: q.question_type as 'MCQ' | 'NUMERIC' | undefined,
      options: q.options || {},
      accepted_answers: q.accepted_answers || [],
    }));

    console.log(`[JSONLoader] Math: loaded ${mapped.length} questions from ${filePath}`);
    return mapped;

  } catch (err) {
    console.error(`[JSONLoader] Failed to parse Math file ${filePath}:`, err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// ENGLISH LOADER
// ─────────────────────────────────────────────────────────
interface RawEnglishQuestion {
  page?: number;
  question_id: string;
  assessment: string;
  test: string;
  domain: string;
  skill: string;
  difficulty: string;
  question: string;
  A: string;
  B: string;
  C: string;
  D: string;
  correct_answer: string;
  correct_option_text?: string;
  rationale: string;
}

export async function loadEnglishQuestionsFromJSON(
  filePath: string
): Promise<JSONQuestion[]> {
  if (!fs.existsSync(filePath)) {
    console.warn(`[JSONLoader] English file not found: ${filePath}`);
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const questions: RawEnglishQuestion[] = JSON.parse(raw);

    const mapped: JSONQuestion[] = questions.map((q) => ({
      question_id: q.question_id,
      exam: q.assessment || 'SAT',
      subject: q.test || 'Reading and Writing',
      difficulty: q.difficulty,
      domain: q.domain,
      skill: q.skill,
      page: q.page,
      question_text: q.question || '',
      answer_choices: [
        { choice_id: 'A', choice_text: q.A },
        { choice_id: 'B', choice_text: q.B },
        { choice_id: 'C', choice_text: q.C },
        { choice_id: 'D', choice_text: q.D },
      ],
      correct_answer: q.correct_answer,
      explanation: q.rationale,
    }));

    console.log(`[JSONLoader] English: loaded ${mapped.length} questions from ${filePath}`);
    return mapped;

  } catch (err) {
    console.error(`[JSONLoader] Failed to parse English file ${filePath}:`, err);
    return [];
  }
}