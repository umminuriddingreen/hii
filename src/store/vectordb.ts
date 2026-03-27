import path from 'node:path';
import { connect, Table } from '@lancedb/lancedb';

export type DocChunk = {
  id: string;
  docId: string;
  path: string;
  content: string;
  meta?: Record<string, any>;
  embedding: number[];
};

export class VectorStore {
  private dbPath: string;
  private tableName = 'chunks';
  private table?: Table;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const db = await connect(this.dbPath);
    const names = await db.tableNames();
    if (!names.includes(this.tableName)) {
      this.table = await db.createTable(this.tableName, [] as DocChunk[]);
    } else {
      this.table = await db.openTable(this.tableName);
    }
  }

  async upsert(chunks: DocChunk[]): Promise<void> {
    if (!this.table) throw new Error('VectorStore not initialized');
    await this.table.add(chunks);
  }

  async search(queryEmbedding: number[], k = 5): Promise<DocChunk[]> {
    if (!this.table) throw new Error('VectorStore not initialized');
    const result = await this.table.search(queryEmbedding).limit(k).toArray();
    return result as unknown as DocChunk[];
  }
}
