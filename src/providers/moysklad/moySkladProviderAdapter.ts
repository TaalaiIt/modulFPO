import {
  IProviderAdapter,
  VendorLifecycleEvent,
  VendorLifecycleResult
} from '../common/IProviderAdapter';
import {
  NormalizedFiscalOperation,
  FiscalResult,
  ReceiptData
} from '../../core/operations/types';
import { MoySkladSecurity } from './security/moySkladSecurity';
import { MoySkladLifecycle } from './lifecycle/moySkladLifecycle';
import { MoySkladMapper } from './mapper/moySkladMapper';
import { MoySkladReceiptGenerator } from './receipt/moySkladReceiptGenerator';
import { AuditLogger } from '../../core/audit/auditLogger';

export class MoySkladProviderAdapter implements IProviderAdapter {
  public readonly providerCode = 'MOYSKLAD';

  public security: MoySkladSecurity;
  public lifecycle: MoySkladLifecycle;
  public mapper: MoySkladMapper;
  public receiptGenerator: MoySkladReceiptGenerator;

  constructor(auditLogger?: AuditLogger) {
    this.security = new MoySkladSecurity();
    this.lifecycle = new MoySkladLifecycle(this.security, auditLogger);
    this.mapper = new MoySkladMapper();
    this.receiptGenerator = new MoySkladReceiptGenerator();
  }

  public async verifyRequest(request: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    rawBody?: string | Buffer;
  }): Promise<{ valid: boolean; accountId?: string; error?: string }> {
    const accountId =
      (request.headers['x-lognex-fiscal-account-id'] as string) ||
      ((request.body as Record<string, unknown>)?.accountId as string);

    if (!accountId) {
      return { valid: false, error: 'Missing X-Lognex-Fiscal-Account-Id header.' };
    }

    const signature = request.headers['x-lognex-fiscal-signature'] as string | undefined;
    const rawBody = request.rawBody || JSON.stringify(request.body || {});

    const sigResult = this.security.verifySignature(accountId, signature, rawBody);
    if (!sigResult.valid) {
      return { valid: false, accountId, error: sigResult.error };
    }

    return { valid: true, accountId };
  }

  public async mapToNormalized(rawRequest: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    url?: string;
    method?: string;
  }): Promise<NormalizedFiscalOperation> {
    const url = rawRequest.url || '/1/retaildemand';
    const body = (rawRequest.body || {}) as Record<string, unknown>;
    return this.mapper.mapToNormalized(url, rawRequest.headers, body);
  }

  public async mapToProviderResponse(result: FiscalResult): Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body: unknown;
  }> {
    return this.mapper.mapToProviderResponse(result);
  }

  public async generateReceiptData(
    operation: NormalizedFiscalOperation,
    fiscalResult: Partial<FiscalResult>,
    options?: { paperWidthMm?: number }
  ): Promise<ReceiptData> {
    return this.receiptGenerator.generateReceipt(operation, fiscalResult, options);
  }

  public async handleVendorLifecycle(event: VendorLifecycleEvent): Promise<VendorLifecycleResult> {
    return this.lifecycle.handleEvent(event);
  }
}
