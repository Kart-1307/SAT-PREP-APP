import { MongoClient, Db } from 'mongodb';

let connectionPromise: Promise<Db> | null = null;

// Indexes for collections hit by tight polling loops and page-load queries.
// createIndex is a no-op if the index already exists.
async function ensureIndexes(db: Db): Promise<void> {
  try {
    await Promise.all([
      db.collection('questions').createIndex({ question_id: 1 }, { unique: true }),
      db.collection('questions').createIndex({ exam_type: 1, status: 1 }),
      db.collection('questions').createIndex({ exam_type: 1, status: 1, 'metadata.created_at': -1 }),
      db.collection('audit_logs').createIndex({ id: 1 }, { unique: true }),
      db.collection('audit_logs').createIndex({ exam_type: 1, timestamp: -1 }),
      db.collection('pipeline_runs').createIndex({ question_id: 1 }, { unique: true }),
      db.collection('pipeline_runs').createIndex({ exam_type: 1, started_at: -1 }),
      db.collection('pipeline_runs').createIndex({ section: 1, domain: 1, skill_tag: 1, difficulty: 1, started_at: -1 }),
      db.collection('batch_runs').createIndex({ batch_id: 1 }, { unique: true }),
      db.collection('batch_runs').createIndex({ exam_type: 1, status: 1 })
    ]);
    console.log('[MongoDB] ✅ Indexes ensured');
  } catch (e) {
    // Non-fatal — app still works without indexes, just slower.
    console.warn('[MongoDB] Index creation skipped (non-fatal):', e);
  }
}

export async function getDb(): Promise<Db> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      // Read URI inside the function, not at module load time
      // This ensures dotenv has already run before we read the env var
      const uri = process.env.MONGODB_URI;

      if (!uri) {
        throw new Error('[MongoDB] MONGODB_URI is not set in .env.local');
      }

      const client = new MongoClient(uri, {
        // Let the driver keep retrying reads/writes across a transient
        // network blip instead of surfacing it immediately.
        retryWrites: true,
        retryReads: true,
        // Close idle connections after 30 seconds to prevent Atlas from dropping them and causing ECONNRESET
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 5000,
      });

      // CRITICAL: MongoClient is an EventEmitter. If it emits 'error' and
      // nothing is listening, Node throws it as an uncaught exception and
      // kills the entire process — which is exactly what was happening on
      // every ECONNRESET. These listeners just log it; the driver's own
      // connection pool handles reconnection automatically.
      client.on('error', (err) => {
        console.error('[MongoDB] Client error (non-fatal, connection pool will retry):', err);
      });
      client.on('close', () => {
        console.warn('[MongoDB] Connection closed — driver will attempt to reconnect.');
      });
      client.on('timeout', () => {
        console.warn('[MongoDB] Connection timeout — driver will attempt to reconnect.');
      });

      // Prevent process crash from unhandled transient connection errors
      process.on('uncaughtException', (err) => {
        const isMongoTransient = 
          err.message?.includes('ECONNRESET') || 
          err.message?.includes('MongoNetworkError') ||
          err.message?.includes('MongoError') ||
          err.name === 'MongoNetworkError';
        
        if (isMongoTransient) {
          console.warn('[MongoDB] Caught transient process network error (non-fatal, pool will auto-reconnect):', err.message);
          return;
        }
        console.error('[Process] Uncaught Exception:', err);
        process.exit(1);
      });

      try {
        await client.connect();
        const db = client.db();
        console.log('[MongoDB] ✅ Connected to MongoDB Atlas (satprep)');
        await ensureIndexes(db);
        return db;
      } catch (err) {
        connectionPromise = null;
        throw err;
      }
    })();
  }
  return connectionPromise;
}