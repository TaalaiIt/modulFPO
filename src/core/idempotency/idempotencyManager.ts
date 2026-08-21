import crypto from 'crypto';
import {
  NormalizedFiscalOperation,
  FiscalResult,
  OperationStatus,
  CoreError
} from '../operations/types';

export interface IdempotencyRecord {
  key: string;
  providerCode: string;
  providerAccountId: string;
  externalOperationId: string;
  operationType: string;
  payloadHash: string;
  status: OperationStatus;
  result?: FiscalResult;
  error?: CoreError;
  createdAt: string;
  updatedAt: string;
}

export interface IIdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(record: IdempotencyRecord): Promise<void>;
  update(key: string, updates: Partial<IdempotencyRecord>): Promise<void>;
}

export class InMemoryIdempotencyStore implements IIdempotencyStore {
  private records: Map<string, IdempotencyRecord> = new Map();

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) || null;
  }

  async set(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.key, { ...record });
  }

  async update(key: string, updates: Partial<IdempotencyRecord>): Promise<void> {
    const existing = this.records.get(key);
    if (!existing) {
      throw new Error(`Record with key ${key} not found`);
    }
    this.records.set(key, {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }

  clear(): void {
    this.records.clear();
  }
}

export class IdempotencyManager {
  private store: IIdempotencyStore;
  private locks: Map<string, Promise<void>> = new Map();

  constructor(store?: IIdempotencyStore) {
    this.store = store || new InMemoryIdempotencyStore();
  }

  /**
   * Generates standard Core idempotency key
   * key = providerCode:providerAccountId:operationType:externalOperationId
   */
  public buildKey(
    providerCode: string,
    providerAccountId: string,
    operationType: string,
    externalOperationId: string
  ): string {
    return `${providerCode.toUpperCase()}:${providerAccountId}:${operationType.toUpperCase()}:${externalOperationId}`;
  }

  /**
   * Calculates SHA-256 hash of payload
   */
  public calculateHash(payload: unknown): string {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Evaluates incoming operation against idempotency store.
   * Returns:
   * - { action: 'PROCEED', key, hash } if it's a new or retryable request
   * - { action: 'RETURN_CACHED', result } if previously succeeded with matching payload
   * - { action: 'REJECT', error } if conflict or blocked in UNKNOWN / in-flight
   */
  public async checkOrStart(
    op: NormalizedFiscalOperation
  ): Promise<
    | { action: 'PROCEED'; key: string; hash: string }
    | { action: 'RETURN_CACHED'; result: FiscalResult }
    | { action: 'REJECT'; error: CoreError }
  > {
    const key = this.buildKey(
      op.providerCode,
      op.providerAccountId,
      op.operationType,
      op.externalOperationId
    );
    return this.withKeyLock(key, async () => {
      const hash = op.payloadHash || this.calculateHash(op.rawExternalPayload || op);

      const existing = await this.store.get(key);
      if (!existing) {
      // First time seeing this operation
      const record: IdempotencyRecord = {
        key,
        providerCode: op.providerCode,
        providerAccountId: op.providerAccountId,
        externalOperationId: op.externalOperationId,
        operationType: op.operationType,
        payloadHash: hash,
        status: OperationStatus.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this.store.set(record);
        return { action: 'PROCEED', key, hash };
      }

    // Existing record found
    // 1. Check if hash matches
      if (existing.payloadHash !== hash) {
      return {
        action: 'REJECT',
        error: {
          code: 'PAYLOAD_CONFLICT',
          message: `Operation with key ${key} was already registered with different payload data.`,
          isRetryable: false,
          httpStatusCode: 409
        }
      };
      }

    // 2. Check existing status
      if (existing.status === OperationStatus.SUCCESS && existing.result) {
      return {
        action: 'RETURN_CACHED',
        result: existing.result
      };
      }

      if (existing.status === OperationStatus.PROCESSING) {
      return {
        action: 'REJECT',
        error: {
          code: 'OPERATION_IN_PROGRESS',
          message: `Operation ${key} is currently being processed. Please wait.`,
          isRetryable: true,
          httpStatusCode: 429
        }
      };
      }

      if (existing.status === OperationStatus.UNKNOWN) {
      return {
        action: 'REJECT',
        error: {
          code: 'OPERATION_STATUS_UNKNOWN',
          message: `Operation ${key} is in UNKNOWN state. FiscalConnector response was lost. Blind retry is forbidden to prevent duplicate fiscal document. Reconciliation required.`,
          isRetryable: false,
          httpStatusCode: 504
        }
      };
      }

      if (existing.status === OperationStatus.FAILED) {
      // Allow retry if previously failed
      await this.store.update(key, {
        status: OperationStatus.PROCESSING,
        updatedAt: new Date().toISOString()
      });
        return { action: 'PROCEED', key, hash };
      }

      return { action: 'PROCEED', key, hash };
    });
  }

  private async withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  /**
   * Mark operation as successful with cached result
   */
  public async markSuccess(key: string, result: FiscalResult): Promise<void> {
    await this.store.update(key, {
      status: OperationStatus.SUCCESS,
      result,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Mark operation as UNKNOWN (when communication was lost after sending to FPO)
   */
  public async markUnknown(key: string, error?: CoreError): Promise<void> {
    await this.store.update(key, {
      status: OperationStatus.UNKNOWN,
      error,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Mark operation as FAILED (e.g. pre-validation failure, license failure)
   */
  public async markFailed(key: string, error: CoreError): Promise<void> {
    await this.store.update(key, {
      status: OperationStatus.FAILED,
      error,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Resolve an UNKNOWN record after reconciliation
   */
  public async resolveUnknown(key: string, result: FiscalResult): Promise<void> {
    await this.store.update(key, {
      status: OperationStatus.SUCCESS,
      result,
      error: undefined,
      updatedAt: new Date().toISOString()
    });
  }

  public async getRecord(key: string): Promise<IdempotencyRecord | null> {
    return this.store.get(key);
  }
}
