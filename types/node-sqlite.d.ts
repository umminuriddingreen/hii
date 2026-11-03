declare module 'node:sqlite' {
  export type StatementResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export class StatementSync {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Array<Record<string, unknown>>;
    run(...values: unknown[]): StatementResult;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
