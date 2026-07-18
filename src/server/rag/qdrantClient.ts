import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIMENSIONS } from './embeddings';

// ✅ Use functions instead of constants so env vars are read at call time,
//    not at module-load time (which can be before dotenv has run).
function getQdrantUrl(): string {
  return process.env.QDRANT_URL || 'http://localhost:6333';
}

function getQdrantApiKey(): string | undefined {
  return process.env.QDRANT_API_KEY || undefined;
}

let client: QdrantClient | null = null;

export const MATH_COLLECTION_NAME = 'sat-math-questions';
export const ENGLISH_COLLECTION_NAME = 'sat-english-questions';

export function getQdrantClient(): QdrantClient {
  if (!client) {
    const url = getQdrantUrl();
    const apiKey = getQdrantApiKey();
    console.log(`[Qdrant] Connecting to: ${url}`);
    client = new QdrantClient({ url, apiKey });
  }
  return client;
}

// Creates a payload index on "question_id" so it can be used in search
// filters (must_not / match). Qdrant requires an explicit index before a
// field can be filtered on — without this, any search that excludes IDs
// (e.g. RAG rotation tracking) fails with "Index required but not found".
// Safe to call on every startup: if the index already exists, Qdrant
// returns a harmless error which we swallow here.
async function ensurePayloadIndex(collectionName: string): Promise<void> {
  const qdrant = getQdrantClient();
  try {
    await qdrant.createPayloadIndex(collectionName, {
      field_name: 'question_id',
      field_schema: 'keyword',
    });
    console.log(`[Qdrant] Payload index ensured on "question_id" for ${collectionName}`);
  } catch (error: any) {
    // Already exists → Qdrant returns a 4xx here, which is fine to ignore.
    const msg = error?.message || String(error);
    if (msg.toLowerCase().includes('already exists')) {
      console.log(`[Qdrant] Payload index already exists on "question_id" for ${collectionName}`);
    } else {
      console.error(`[Qdrant] Error creating payload index for ${collectionName}:`, error);
    }
  }
}

export async function createMathCollection(): Promise<void> {
  const qdrant = getQdrantClient();
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections?.some(c => c.name === MATH_COLLECTION_NAME);
    if (!exists) {
      console.log(`[Qdrant] Creating collection: ${MATH_COLLECTION_NAME}`);
      await qdrant.createCollection(MATH_COLLECTION_NAME, {
        vectors: { size: EMBEDDING_DIMENSIONS, distance: 'Cosine' },
      });
    } else {
      console.log(`[Qdrant] Collection already exists: ${MATH_COLLECTION_NAME}`);
    }
    await ensurePayloadIndex(MATH_COLLECTION_NAME);
  } catch (error) {
    console.error(`[Qdrant] Error creating math collection:`, error);
  }
}

export async function createEnglishCollection(): Promise<void> {
  const qdrant = getQdrantClient();
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections?.some(c => c.name === ENGLISH_COLLECTION_NAME);
    if (!exists) {
      console.log(`[Qdrant] Creating collection: ${ENGLISH_COLLECTION_NAME}`);
      await qdrant.createCollection(ENGLISH_COLLECTION_NAME, {
        vectors: { size: EMBEDDING_DIMENSIONS, distance: 'Cosine' },
      });
    } else {
      console.log(`[Qdrant] Collection already exists: ${ENGLISH_COLLECTION_NAME}`);
    }
    await ensurePayloadIndex(ENGLISH_COLLECTION_NAME);
  } catch (error) {
    console.error(`[Qdrant] Error creating English collection:`, error);
  }
}

export async function ensureCollections(): Promise<void> {
  await createMathCollection();
  await createEnglishCollection();
  console.log('[Qdrant] Both collections ready');
}

// Stores the FULL question object as payload (spread), so Math-only fields
// (options, accepted_answers, rationale_text, images...) and English-only
// fields (answer_choices, correct_answer, explanation) both survive.
// Returns true/false so callers can track *real* success counts.
export async function storeQuestionInQdrant(
  collectionName: string,
  questionId: string,
  embedding: number[],
  questionData: any
): Promise<boolean> {
  const qdrant = getQdrantClient();

  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    console.error(
      `[Qdrant] Refusing to store ${questionId}: embedding has ${embedding?.length ?? 0} dims, collection expects ${EMBEDDING_DIMENSIONS}.`
    );
    return false;
  }

  try {
    await qdrant.upsert(collectionName, {
      points: [
        {
          id: hashStringToNumber(questionId),
          vector: embedding,
          payload: { ...questionData, question_id: questionId },
        },
      ],
    });
    console.log(`[Qdrant] Stored question: ${questionId}`);
    return true;
  } catch (error) {
    console.error(`[Qdrant] Error storing question ${questionId}:`, error);
    return false;
  }
}

export async function searchSimilarQuestions(
  collectionName: string,
  queryEmbedding: number[],
  topK: number = 3,
  excludeIds: string[] = []
): Promise<any[]> {
  const qdrant = getQdrantClient();
  try {
    const filter = excludeIds.length > 0
      ? {
          must_not: [{
            key: 'question_id',
            match: { any: excludeIds },
          }],
        }
      : undefined;

    const results = await qdrant.search(collectionName, {
      vector: queryEmbedding,
      limit: topK,
      score_threshold: 0.5,
      with_payload: true,
      filter,
    });
    return results.map(r => ({ score: r.score, data: r.payload }));
  } catch (error) {
    console.error(`[Qdrant] Error searching questions:`, error);
    return [];
  }
}

export async function getCollectionStats(
  collectionName: string
): Promise<{ count: number; isReady: boolean }> {
  const qdrant = getQdrantClient();
  try {
    const collection = await qdrant.getCollection(collectionName);
    return { count: collection.points_count || 0, isReady: true };
  } catch (error) {
    console.error(`[Qdrant] Error getting collection stats:`, error);
    return { count: 0, isReady: false };
  }
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}