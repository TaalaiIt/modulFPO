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
import { MoySkladInstallationStore, MoySkladSecurity } from './security/moySkladSecurity';
import { MoySkladLifecycle } from './lifecycle/moySkladLifecycle';
import { MoySkladMapper } from './mapper/moySkladMapper';
import { MoySkladReceiptGenerator } from './receipt/moySkladReceiptGenerator';
import { AuditLogger } from '../../core/audit/auditLogger';
import { MoySkladJsonApiClient } from './client/moySkladJsonApiClient';
import { MOYSKLAD_FISCAL_DESCRIPTOR } from './fiscalDescriptor';
import { MoySkladVendorSecurity } from './security/moySkladVendorSecurity';

export class MoySkladProviderAdapter implements IProviderAdapter {
  public readonly providerCode = 'MOYSKLAD';

  public security: MoySkladSecurity;
  public lifecycle: MoySkladLifecycle;
  public mapper: MoySkladMapper;
  public receiptGenerator: MoySkladReceiptGenerator;
  public readonly fiscalDescriptor = MOYSKLAD_FISCAL_DESCRIPTOR;
  private readonly vendorSecurity: MoySkladVendorSecurity;
  private fiscalResults = new Map<string, FiscalResult>();

  constructor(auditLogger?: AuditLogger, installationStore?: MoySkladInstallationStore) {
    this.security = new MoySkladSecurity(installationStore);
    this.vendorSecurity = new MoySkladVendorSecurity(process.env.MOYSKLAD_VENDOR_JWT_SECRET);
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
    if (!request.rawBody && process.env.NODE_ENV !== 'test') {
      return { valid: false, accountId, error: 'Raw request body is required for signature verification.' };
    }
    const rawBody = request.rawBody || JSON.stringify(request.body || {});

    const sigResult = this.security.verifySignature(accountId, signature, rawBody);
    if (!sigResult.valid) {
      return { valid: false, accountId, error: sigResult.error };
    }

    return { valid: true, accountId };
  }

  public getJsonApiClient(accountId: string): MoySkladJsonApiClient {
    const installation = this.security.getInstallation(accountId);
    if (!installation?.accessToken) {
      throw new Error(`MoySklad installation for account ${accountId} is not configured.`);
    }
    return new MoySkladJsonApiClient({ accessToken: installation.accessToken });
  }

  public async loadContext(accountId: string): Promise<unknown> {
    return this.getJsonApiClient(accountId).getContext();
  }

  public async loadStore(accountId: string, storeId: string): Promise<unknown> {
    return this.getJsonApiClient(accountId).getRetailStore(storeId);
  }

  public async loadAdditionalFields(accountId: string, entityType: string): Promise<unknown> {
    return this.getJsonApiClient(accountId).getAdditionalFields(entityType);
  }

  public verifyVendorRequest(
    headers: Record<string, string | string[] | undefined>,
    expectedAccountId?: string | string[]
  ): { valid: boolean; error?: string; tenantId?: string } {
    return this.vendorSecurity.verify(headers, expectedAccountId);
  }

  public async mapToNormalized(rawRequest: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    url?: string;
    method?: string;
  }): Promise<NormalizedFiscalOperation> {
    const url = rawRequest.url || '/1/retaildemand';
    const body = { ...((rawRequest.body || {}) as Record<string, unknown>) };
    if (rawRequest.url?.toLowerCase().includes('retailsalesreturn') || rawRequest.url?.toLowerCase().includes('retaisalesreturn')) {
      const demand = body.demand as Record<string, unknown> | undefined;
      const demandMeta = demand?.meta as Record<string, unknown> | undefined;
      const originId = demandMeta?.id as string | undefined;
      const accountId = (rawRequest.headers['x-lognex-fiscal-account-id'] as string) || (body.accountId as string);
      const storedResult = originId && accountId ? this.fiscalResults.get(`${accountId}:${originId}`) : undefined;
      if (storedResult) {
        body.originFdNumber = storedResult.fiscalDocNumber;
        body.originFnSerialNumber = storedResult.fnNumber;
        body.originDate = storedResult.fiscalDateTime;
      }
    }
    return this.mapper.mapToNormalized(url, rawRequest.headers, body);
  }

  public recordFiscalResult(operation: NormalizedFiscalOperation, result: FiscalResult): void {
    if (operation.operationType === 'SALE' && result.success) {
      this.fiscalResults.set(`${operation.providerAccountId}:${operation.externalOperationId}`, result);
    }
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
