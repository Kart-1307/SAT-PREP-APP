import {
  ensureCollections,
  storeQuestionInQdrant,
  searchSimilarQuestions,
  MATH_COLLECTION_NAME,
  ENGLISH_COLLECTION_NAME,
} from './qdrantClient';
import { embedText } from './embeddings';
import {
  loadMathQuestionsFromJSON,
  loadEnglishQuestionsFromJSON,
  JSONQuestion
} from './jsonLoader';
import fs from 'fs';
import path from 'path';
import { Db } from 'mongodb';
import { getDb } from '../mongoClient';

export type { JSONQuestion };

const CACHE_STATUS_FILE = path.join(process.cwd(), 'rag_indexing_status.json');

interface IndexingCache {
  // Legacy keys — kept only so an old cache file on disk still parses.
  // Never written anymore; migrated into *BatchesDone on load.
  mathIndexed?: boolean;
  englishIndexed?: boolean;
  mathIndexed2?: boolean;
  englishIndexed2?: boolean;
  // Generic tracking: which 100-question batches have been indexed.
  mathBatchesDone: number[];
  englishBatchesDone: number[];
}

const KNOWN_CACHE_KEYS: (keyof IndexingCache)[] = [
  'mathIndexed',
  'englishIndexed',
  'mathIndexed2',
  'englishIndexed2',
  'mathBatchesDone',
  'englishBatchesDone',
];

function sanitizeCache(raw: Record<string, unknown>): IndexingCache {
  const clean: IndexingCache = { mathBatchesDone: [], englishBatchesDone: [] };
  for (const key of KNOWN_CACHE_KEYS) {
    if (raw[key] !== undefined) (clean as any)[key] = raw[key];
  }
  // One-time migration from old boolean flags → batch-number arrays.
  if (clean.mathIndexed && !clean.mathBatchesDone.includes(1)) clean.mathBatchesDone.push(1);
  if (clean.mathIndexed2 && !clean.mathBatchesDone.includes(2)) clean.mathBatchesDone.push(2);
  if (clean.englishIndexed && !clean.englishBatchesDone.includes(1)) clean.englishBatchesDone.push(1);
  if (clean.englishIndexed2 && !clean.englishBatchesDone.includes(2)) clean.englishBatchesDone.push(2);
  return clean;
}

function getCacheStatus(): IndexingCache {
  if (fs.existsSync(CACHE_STATUS_FILE)) {
    try {
      return sanitizeCache(JSON.parse(fs.readFileSync(CACHE_STATUS_FILE, 'utf8')));
    } catch (e) {
      return { mathBatchesDone: [], englishBatchesDone: [] };
    }
  }
  return { mathBatchesDone: [], englishBatchesDone: [] };
}

function updateCacheStatus(updates: Partial<IndexingCache>) {
  const current = getCacheStatus();
  fs.writeFileSync(CACHE_STATUS_FILE, JSON.stringify(sanitizeCache({ ...current, ...updates }), null, 2));
}

// Shared database connection pool for RAG tracking and usage history operations.
async function getRagDb(): Promise<Db> {
  return await getDb();
}

// Call this on DB reset — clears exemplar rotation history from MongoDB.
// *BatchesDone in local cache file are preserved so Qdrant is NOT re-embedded.
export async function resetExemplarUsage(): Promise<void> {
  try {
    const db = await getRagDb();
    await db.collection('rag_tracking').deleteMany({});
    console.log('[RAG] Exemplar usage history cleared from MongoDB');
  } catch (e) {
    console.warn('[RAG] Could not clear exemplar usage:', e);
  }
}

const BATCH_SIZE = 100;   // questions per batch
const EMBED_CHUNK = 10;   // how many to embed before logging progress

// ── Generic batch indexer ───────────────────────────────────────────────
// Replaces the old indexMathQuestionsFromJSON / _batch2 / indexEnglish... duplicates.
// batchNumber is 1-indexed: batch 1 = questions 1-100, batch 2 = 101-200,
// batch 3 = 201-300, batch 4 = 301-400, etc.
async function indexQuestionsBatch(
  subject: 'Math' | 'English',
  jsonFilePath: string,
  batchNumber: number
): Promise<void> {
  const cache = getCacheStatus();
  const doneList = subject === 'Math' ? cache.mathBatchesDone : cache.englishBatchesDone;

  if (doneList.includes(batchNumber)) {
    console.log(`[RAG] ✅ ${subject} batch ${batchNumber} already indexed. Skipping to save API quota.`);
    return;
  }

  const start = (batchNumber - 1) * BATCH_SIZE;
  const end = start + BATCH_SIZE;

  console.log(`[RAG] Starting ${subject} batch ${batchNumber} indexing (questions ${start + 1}-${end})...`);
  await ensureCollections();

  let questions = subject === 'Math'
    ? await loadMathQuestionsFromJSON(jsonFilePath)
    : await loadEnglishQuestionsFromJSON(jsonFilePath);

  if (questions.length <= start) {
    console.warn(`[RAG] Not enough ${subject} questions for batch ${batchNumber} (need more than ${start}, found ${questions.length}).`);
    return;
  }

  questions = questions.slice(start, end);
  console.log(`[RAG] Processing ${questions.length} ${subject} batch ${batchNumber} questions...`);

  const collectionName = subject === 'Math' ? MATH_COLLECTION_NAME : ENGLISH_COLLECTION_NAME;
  let successCount = 0;

  for (let i = 0; i < questions.length; i += EMBED_CHUNK) {
    const chunk = questions.slice(i, i + EMBED_CHUNK);
    for (const question of chunk) {
      try {
        const textToEmbed = `
          Domain: ${question.domain}
          Skill: ${question.skill}
          Difficulty: ${question.difficulty}
          Question: ${question.question_text}
        `.trim();
        const embedding = await embedText(textToEmbed);
        if (!embedding) { console.warn(`[RAG] Failed to embed ${subject} question: ${question.question_id}`); continue; }
        const stored = await storeQuestionInQdrant(collectionName, question.question_id, embedding, question);
        if (stored) successCount++;
      } catch (error) {
        console.error(`[RAG] Error processing ${subject} question ${question.question_id}:`, error);
      }
    }
    console.log(`[RAG] ${subject} batch ${batchNumber} chunk ${Math.floor(i / EMBED_CHUNK) + 1} complete → ${successCount} indexed`);
  }

  console.log(`[RAG] ${subject} batch ${batchNumber} complete: ${successCount}/${questions.length} stored in Qdrant`);

  updateCacheStatus(
    subject === 'Math'
      ? { mathBatchesDone: [...doneList, batchNumber] }
      : { englishBatchesDone: [...doneList, batchNumber] }
  );
}

// Thin public wrappers so call sites stay readable (indexMathQuestionsBatch(path, 3) etc.)
export async function indexMathQuestionsBatch(jsonFilePath: string, batchNumber: number): Promise<void> {
  return indexQuestionsBatch('Math', jsonFilePath, batchNumber);
}

export async function indexEnglishQuestionsBatch(jsonFilePath: string, batchNumber: number): Promise<void> {
  return indexQuestionsBatch('English', jsonFilePath, batchNumber);
}

// FUNCTION 3: Retrieve Exemplar Questions for Generator (unchanged)
export async function retrieveExemplarQuestionsForGeneration(params: {
  subject: string;
  domain: string;
  skill: string;
  difficulty: string;
  topK?: number;
}): Promise<JSONQuestion[]> {
  const { subject, domain, skill, difficulty, topK = 3 } = params;

  try {
    await ensureCollections();

    const collectionName = subject === 'Math'
      ? MATH_COLLECTION_NAME
      : ENGLISH_COLLECTION_NAME;

    const queryText = `
      Domain: ${domain}
      Skill: ${skill}
      Difficulty: ${difficulty}
    `.trim();

    const queryEmbedding = await embedText(queryText);
    if (!queryEmbedding) {
      console.warn('[RAG] Could not embed query for exemplar retrieval');
      return [];
    }

    // ── Round-robin tracking via MongoDB (shared across all users) ─────────
    const trackingKey = `${subject}|${domain}|${skill}|${difficulty}`;
    let usedForKey: string[] = [];

    try {
      const db = await getRagDb();
      const record = await db.collection('rag_tracking').findOne({ key: trackingKey }) as unknown as
        { key: string; usedIds: string[] } | null;
      usedForKey = record?.usedIds ?? [];
    } catch (e) {
      console.warn('[RAG] Could not read tracking, proceeding without exclusions:', e);
    }

    let results = await searchSimilarQuestions(
      collectionName,
      queryEmbedding,
      topK,
      usedForKey,
      difficulty
    );

    if (results.length < topK) {
      console.log(`[RAG] Rotation cycle complete for "${trackingKey}" — resetting`);
      try {
        const db = await getRagDb();
        await db.collection('rag_tracking').deleteOne({ key: trackingKey });
      } catch (e) {
        console.warn('[RAG] Could not reset tracking:', e);
      }
      results = await searchSimilarQuestions(collectionName, queryEmbedding, topK, [], difficulty);
    }

    // Last-resort fallback: if this domain/skill genuinely has no bank
    // questions at the requested difficulty, don't silently hand the
    // generator zero exemplars (which itself invites drift) — fall back to
    // an unfiltered search, but log it loudly since it means the exemplars
    // shown may not match the requested difficulty.
    if (results.length === 0) {
      console.warn(`[RAG] No "${difficulty}" exemplars found for "${trackingKey}" — falling back to difficulty-unfiltered search.`);
      results = await searchSimilarQuestions(collectionName, queryEmbedding, topK, usedForKey);
    }

    const pickedIds = results.map(r => r.data.question_id as string);
    try {
      const db = await getRagDb();
      await db.collection('rag_tracking').updateOne(
        { key: trackingKey },
        { $addToSet: { usedIds: { $each: pickedIds } } },
        { upsert: true }
      );
      const updated = await db.collection('rag_tracking').findOne({ key: trackingKey }) as unknown as
        { usedIds: string[] } | null;
      console.log(`[RAG] Rotation: ${updated?.usedIds?.length ?? pickedIds.length} used so far for "${trackingKey}"`);
    } catch (e) {
      console.warn('[RAG] Could not update tracking:', e);
    }

    const exemplars = results.map(r => ({
      question_id: r.data.question_id,
      exam: r.data.exam,
      subject: r.data.subject,
      difficulty: r.data.difficulty,
      domain: r.data.domain,
      skill: r.data.skill,
      page: r.data.page,
      question_text: r.data.question_text,
      answer_choices: r.data.answer_choices,
      correct_answer: r.data.correct_answer,
      explanation: r.data.explanation,
    } as JSONQuestion));

    console.log(`[RAG] Retrieved ${exemplars.length} exemplar questions for "${domain}/${skill}/${difficulty}"`);
    return exemplars;

  } catch (error) {
    console.warn('[RAG] Exemplar retrieval failed (non-fatal):', error);
    return [];
  }
}

// FUNCTION 4: Initialize RAG system with JSON files
// totalBatches controls how many 100-question batches get processed per subject.
// Already-indexed batches are skipped automatically — safe to bump this number
// any time you add more questions (e.g. 4 → covers 1-400, next time bump to 6 → 1-600).
export async function initializeRAGWithJSONFiles(
  mathJsonPath: string,
  englishJsonPath: string,
  totalBatches: number = 20
): Promise<void> {
  console.log('[RAG] Initializing RAG system with JSON question banks...');

  try {
    await ensureCollections();

    for (let b = 1; b <= totalBatches; b++) {
      console.log('[RAG] ─────────────────────────────────────');
      await indexMathQuestionsBatch(mathJsonPath, b);
      console.log('[RAG] ─────────────────────────────────────');
      await indexEnglishQuestionsBatch(englishJsonPath, b);
    }

    console.log('[RAG] ═════════════════════════════════════');
    console.log('[RAG] ✅ RAG system fully initialized');
    console.log('[RAG] ═════════════════════════════════════');

  } catch (error) {
    console.error('[RAG] Failed to initialize RAG system:', error);
    throw error;
  }
}