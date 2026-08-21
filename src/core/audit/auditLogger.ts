export enum AuditEventType {
  OPERATION_RECEIVED = 'OPERATION_RECEIVED',
  OPERATION_DISPATCHED = 'OPERATION_DISPATCHED',
  OPERATION_COMPLETED = 'OPERATION_COMPLETED',
  OPERATION_FAILED = 'OPERATION_FAILED',
  OPERATION_UNKNOWN = 'OPERATION_UNKNOWN',
  OPERATION_RECONCILED = 'OPERATION_RECONCILED',
  LICENSE_CHECKED = 'LICENSE_CHECKED',
  LICENSE_GRACE = 'LICENSE_GRACE',
  LICENSE_BLOCKED = 'LICENSE_BLOCKED',
  RECOVERY_ATTEMPT = 'RECOVERY_ATTEMPT',
  DIAGNOSTIC_RUN = 'DIAGNOSTIC_RUN',
  PROVIDER_LIFECYCLE = 'PROVIDER_LIFECYCLE'
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  providerCode?: string;
  providerAccountId?: string;
  externalOperationId?: string;
  operationType?: string;
  storeId?: string;
  agentId?: string;
  rnm?: string;
  fiscalDocNumber?: number;
  fiscalDocSign?: string;
  message: string;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private records: AuditRecord[] = [];
  private static sensitiveKeyRegex = /pin|password|secret|token|access_token|authorization|samcardpin/i;

  public log(event: Omit<AuditRecord, 'id' | 'timestamp'>): AuditRecord {
    const record: AuditRecord = {
      id: Math.random().toString(36).substring(2, 12),
      timestamp: new Date().toISOString(),
      ...event,
      details: this.sanitize(event.details)
    };

    this.records.push(record);
    return record;
  }

  public getRecords(filter?: Partial<AuditRecord>): AuditRecord[] {
    if (!filter) return [...this.records];
    return this.records.filter((rec) => {
      for (const [k, v] of Object.entries(filter)) {
        if ((rec as unknown as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    });
  }

  public clear(): void {
    this.records = [];
  }

  private sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (AuditLogger.sensitiveKeyRegex.test(k)) {
        clean[k] = '***REDACTED***';
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        clean[k] = this.sanitize(v as Record<string, unknown>);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}
