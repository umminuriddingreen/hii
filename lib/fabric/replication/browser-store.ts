import { validateReplicatedOperation } from './validation.ts';
import {
  ReplicationStoreError,
  type ReplicatedOperation,
  type ReplicationAppendResult,
  type ReplicationFrontier,
  type ReplicationNamespace,
  type ReplicationOperationStore
} from './types.ts';
import { calculateFrontier, compareOperations, namespaceKey, operationIsMissing } from './store.ts';

const DATABASE_NAME = 'hii-replication-v1';
const DATABASE_VERSION = 1;
const OPERATIONS = 'operations';
const SEQUENCES = 'sequences';

type OperationRecord = {
  key: string;
  sequenceKey: string;
  namespace: string;
  operation: ReplicatedOperation;
};

type SequenceRecord = { key: string; value: number };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function abortQuietly(transaction: IDBTransaction) {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have completed or aborted.
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function mapStorageError(error: unknown, action: string): ReplicationStoreError {
  if (error instanceof ReplicationStoreError) return error;
  if (error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
    return new ReplicationStoreError('quota-exceeded', `Replication storage quota was exceeded while ${action}.`);
  }
  return new ReplicationStoreError('write-failed', `Replication storage failed while ${action}.`);
}

export class IndexedDbReplicationStore implements ReplicationOperationStore {
  private readonly factory: IDBFactory | undefined;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(factory: IDBFactory | undefined = globalThis.indexedDB) {
    this.factory = factory;
  }

  async append(namespace: Readonly<ReplicationNamespace>, operation: Readonly<ReplicatedOperation>): Promise<ReplicationAppendResult> {
    if (operation.accountId !== namespace.accountId || operation.workspaceId !== namespace.workspaceId) {
      throw new ReplicationStoreError('corrupt-store', 'Operation namespace does not match its durable store namespace.');
    }
    const database = await this.database();
    const transaction = database.transaction(OPERATIONS, 'readwrite');
    const store = transaction.objectStore(OPERATIONS);
    const scope = namespaceKey(namespace);
    const key = `${scope}\u001f${operation.operationId}`;
    const sequenceKey = `${scope}\u001f${operation.deviceId}\u001f${operation.sequence}`;
    try {
      const existing = await requestResult(store.get(key) as IDBRequest<OperationRecord | undefined>);
      if (existing) {
        if (canonical(existing.operation) !== canonical(operation)) {
          abortQuietly(transaction);
          throw new ReplicationStoreError('corrupt-store', 'An operation ID was reused with different durable content.');
        }
        await transactionDone(transaction);
        return { appended: false };
      }
      const sequenceIndex = store.index('bySequence');
      const sequenceOwner = await requestResult(sequenceIndex.get(sequenceKey) as IDBRequest<OperationRecord | undefined>);
      if (sequenceOwner) {
        abortQuietly(transaction);
        throw new ReplicationStoreError('corrupt-store', 'A device sequence was reused by another operation.');
      }
      store.add({ key, sequenceKey, namespace: scope, operation: structuredClone(operation) } satisfies OperationRecord);
      await transactionDone(transaction);
      return { appended: true };
    } catch (error) {
      abortQuietly(transaction);
      throw mapStorageError(error, 'appending an operation');
    }
  }

  async readAll(namespace: Readonly<ReplicationNamespace>): Promise<ReplicatedOperation[]> {
    try {
      const database = await this.database();
      const transaction = database.transaction(OPERATIONS, 'readonly');
      const records = await requestResult(transaction.objectStore(OPERATIONS).index('byNamespace').getAll(namespaceKey(namespace)) as IDBRequest<OperationRecord[]>);
      await transactionDone(transaction);
      return records.map((record) => {
        if (record.namespace !== namespaceKey(namespace) || !record.operation) throw new ReplicationStoreError('corrupt-store', 'Replication storage contains an invalid operation record.');
        return validateReplicatedOperation(record.operation);
      }).sort(compareOperations);
    } catch (error) {
      if (error instanceof ReplicationStoreError) throw error;
      throw new ReplicationStoreError('corrupt-store', 'Replication operations could not be read safely.');
    }
  }

  async readMissing(namespace: Readonly<ReplicationNamespace>, frontier: ReplicationFrontier): Promise<ReplicatedOperation[]> {
    return (await this.readAll(namespace)).filter((operation) => operationIsMissing(operation, frontier));
  }

  async frontier(namespace: Readonly<ReplicationNamespace>): Promise<ReplicationFrontier> {
    return calculateFrontier(await this.readAll(namespace));
  }

  async allocateSequence(namespace: Readonly<ReplicationNamespace>, deviceId: string): Promise<number> {
    if (!deviceId || deviceId.length > 128) throw new ReplicationStoreError('write-failed', 'A safe device ID is required to allocate a sequence.');
    const database = await this.database();
    const transaction = database.transaction(SEQUENCES, 'readwrite');
    const store = transaction.objectStore(SEQUENCES);
    const key = `${namespaceKey(namespace)}\u001f${deviceId}`;
    try {
      const current = await requestResult(store.get(key) as IDBRequest<SequenceRecord | undefined>);
      const next = (current?.value ?? 0) + 1;
      if (!Number.isSafeInteger(next)) throw new ReplicationStoreError('write-failed', 'Device sequence space is exhausted.');
      store.put({ key, value: next } satisfies SequenceRecord);
      await transactionDone(transaction);
      return next;
    } catch (error) {
      abortQuietly(transaction);
      throw mapStorageError(error, 'allocating a device sequence');
    }
  }

  private database(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new ReplicationStoreError('storage-unavailable', 'IndexedDB is unavailable; durable replication cannot start.'));
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory!.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OPERATIONS)) {
          const operations = database.createObjectStore(OPERATIONS, { keyPath: 'key' });
          operations.createIndex('byNamespace', 'namespace');
          operations.createIndex('bySequence', 'sequenceKey', { unique: true });
        }
        if (!database.objectStoreNames.contains(SEQUENCES)) database.createObjectStore(SEQUENCES, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new ReplicationStoreError('storage-unavailable', 'IndexedDB could not be opened.'));
      request.onblocked = () => reject(new ReplicationStoreError('storage-unavailable', 'IndexedDB upgrade is blocked by another HII tab.'));
    });
    return this.databasePromise;
  }
}
