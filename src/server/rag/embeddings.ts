import { GoogleGenAI } from '@google/genai';

let aiClient: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || 'DUMMY_KEY',
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
  }
  return aiClient;
}

// Single source of truth — qdrantClient.ts imports this too, so the
// embedder and the collections can never drift out of sync again.
export const EMBEDDING_DIMENSIONS = 768;

// Gemini's smaller, non-default output sizes aren't guaranteed to be
// pre-normalized. Cosine distance needs unit vectors, so normalize here
// regardless — it's a no-op if the vector already is normalized.
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}

export async function embedText(text: string): Promise<number[] | null> {
  const maxRetries = 3;
  // Hard per-call timeout — this had none before and could hang far longer
  // than any outer budget (pipeline attempt, batch item) accounted for.
  const REQUEST_TIMEOUT_MS = 12000;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Embeddings] Embedding text (Attempt ${attempt}/${maxRetries})...`);
      const ai = getAI();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await ai.models.embedContent({
          model: 'gemini-embedding-001', // GA/stable. Swap to 'gemini-embedding-2-preview' later if you want, but "preview" can change without notice.
          contents: text,
          config: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            abortSignal: controller.signal,
          },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const vec =
        (res as any).embeddings?.[0]?.values ||
        (res as any).embedding?.values;

      if (!vec) {
        console.warn('[Embeddings] No vector values found in response.', JSON.stringify(res));
        lastError = new Error('No vector values in response');
        continue;
      }

      if (vec.length !== EMBEDDING_DIMENSIONS) {
        console.warn(
          `[Embeddings] ⚠️ Got ${vec.length} dims but expected ${EMBEDDING_DIMENSIONS}. ` +
          `This WILL break Qdrant upserts — fix outputDimensionality or EMBEDDING_DIMENSIONS.`
        );
      }

      console.log(`[Embeddings] ✅ Successfully embedded (${vec.length} dimensions)`);
      return l2Normalize(vec as number[]);

    } catch (err: any) {
      lastError = err;
      const isTimeout = err.name === "AbortError" || String(err.message || "").toLowerCase().includes("abort");
      if (isTimeout) {
        console.warn(`[Embeddings] Attempt ${attempt}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Retrying...`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      } else if (err.status === 429 || err.status === 503) {
        console.warn(`[Embeddings] Attempt ${attempt}: Service overloaded (${err.status}). Retrying in 2s...`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
      } else {
        console.warn(`[Embeddings] Attempt ${attempt} failed:`, err.message);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  console.warn('[Embeddings] All embedding attempts failed. Returning null.', lastError);
  return null;
}

export async function checkEmbeddingDimension(): Promise<number | null> {
  const vec = await embedText('test sentence for dimension check');
  if (vec) {
    console.log(`[Embeddings] Confirmed dimension: ${vec.length}`);
    return vec.length;
  }
  return null;
}