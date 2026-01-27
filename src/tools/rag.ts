import { VectorStore } from '../store/vectordb.js';
import { embed } from '../clients/ollama.js';

export async function ragSearch(db: VectorStore, embedModel: string, query: string, topK = 5) {
  await db.init();
  const [q] = await embed(embedModel, [query]);
  const results = await db.search(q, topK);
  return results.map(r => ({ path: r.path, content: r.content }));
}

