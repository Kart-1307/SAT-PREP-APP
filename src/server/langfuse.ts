import { Langfuse } from 'langfuse';

let langfuseInstance: Langfuse | null = null;

export default function getLangfuse(): Langfuse {
    if (!langfuseInstance) {
        langfuseInstance = new Langfuse({
            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
            secretKey: process.env.LANGFUSE_SECRET_KEY,
            baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
        });
    }
    return langfuseInstance;
}
