import {
  IProviderAdapter,
  VendorLifecycleEvent,
  VendorLifecycleResult
} from '../common/IProviderAdapter';
import {
  NormalizedFiscalOperation,
  FiscalResult,
  ReceiptData,
  OperationType,
  PaymentMethod
} from '../../core/operations/types';

export class MockProviderAdapter implements IProviderAdapter {
  public readonly providerCode = 'MOCK';

  async verifyRequest(request: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<{ valid: boolean; accountId?: string; error?: string }> {
    const authHeader = request.headers['x-mock-auth'] || request.headers['authorization'];
    const accountId = (request.headers['x-mock-account-id'] as string) || 'mock-acc-1';

    if (authHeader === 'invalid') {
      return { valid: false, error: 'Invalid mock authentication header' };
    }
    return { valid: true, accountId };
  }

  async mapToNormalized(rawRequest: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    url?: string;
    method?: string;
  }): Promise<NormalizedFiscalOperation> {
    const body = (rawRequest.body || {}) as Record<string, unknown>;
    const headers = rawRequest.headers;

    const providerAccountId = (headers['x-mock-account-id'] as string) || (body.accountId as string) || 'mock-account-default';
    const externalOperationId = (body.externalId as string) || (body.id as string) || `mock-op-${Date.now()}`;
    const storeId = (body.storeId as string) || (headers['x-mock-store-id'] as string) || 'mock-store-1';
    const opTypeStr = (body.type as string) || 'SALE';

    let operationType = OperationType.SALE;
    if (opTypeStr.toUpperCase() === 'OPEN_SHIFT') operationType = OperationType.OPEN_SHIFT;
    else if (opTypeStr.toUpperCase() === 'RETURN') operationType = OperationType.RETURN;
    else if (opTypeStr.toUpperCase() === 'DEPOSIT') operationType = OperationType.DEPOSIT;
    else if (opTypeStr.toUpperCase() === 'WITHDRAW') operationType = OperationType.WITHDRAW;
    else if (opTypeStr.toUpperCase() === 'CLOSE_SHIFT') operationType = OperationType.CLOSE_SHIFT;
    else if (opTypeStr.toUpperCase() === 'X_REPORT') operationType = OperationType.X_REPORT;

    const items = (body.items as Array<Record<string, unknown>> || []).map((it) => ({
      name: (it.name as string) || 'Mock Item',
      price: Number(it.price || 0),
      quantity: Number(it.quantity || 1),
      totalSum: Number(it.totalSum || (Number(it.price || 0) * Number(it.quantity || 1))),
      calcItemAttributeCode: it.calcItemAttributeCode ? Number(it.calcItemAttributeCode) : 1
    }));

    const payments = (body.payments as Array<Record<string, unknown>> || []).map((p) => ({
      method: (p.method as PaymentMethod) || PaymentMethod.CASH,
      sum: Number(p.sum || 0)
    }));

    const totalSum = Number(body.totalSum || items.reduce((acc, it) => acc + it.totalSum, 0));
    const totalCashSum = payments.filter(p => p.method === PaymentMethod.CASH).reduce((acc, p) => acc + p.sum, 0);
    const totalCashlessSum = payments.filter(p => p.method !== PaymentMethod.CASH).reduce((acc, p) => acc + p.sum, 0);

    return {
      operationId: `mock-internal-${Date.now()}`,
      providerCode: this.providerCode,
      providerAccountId,
      externalOperationId,
      operationType,
      storeId,
      cashier: body.cashier as { name?: string; inn?: string } | undefined,
      items: items.length > 0 ? items : undefined,
      payments: payments.length > 0 ? payments : undefined,
      totalSum: totalSum > 0 ? totalSum : undefined,
      totalCashSum,
      totalCashlessSum,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  async mapToProviderResponse(result: FiscalResult): Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body: unknown;
  }> {
    if (!result.success) {
      return {
        statusCode: result.error?.httpStatusCode || 400,
        body: {
          mockSuccess: false,
          error: result.error?.message || 'Operation failed',
          code: result.error?.code || 'CORE_ERROR'
        }
      };
    }

    return {
      statusCode: 200,
      body: {
        mockSuccess: true,
        operationId: result.operationId,
        externalId: result.externalOperationId,
        fiscalDocNumber: result.fiscalDocNumber,
        fiscalDocSign: result.fiscalDocSign,
        fnNumber: result.fnNumber,
        kktRegNumber: result.kktRegNumber,
        fiscalDateTime: result.fiscalDateTime,
        receipt: result.receipt
      }
    };
  }

  async generateReceiptData(
    operation: NormalizedFiscalOperation,
    fiscalResult: Partial<FiscalResult>
  ): Promise<ReceiptData> {
    return {
      format: 'RAW_TEXT',
      data: `[MOCK RECEIPT] Op: ${operation.operationType}, Total: ${operation.totalSum || 0}, FPD: ${fiscalResult.fiscalDocSign || 'N/A'}`
    };
  }

  async handleVendorLifecycle(event: VendorLifecycleEvent): Promise<VendorLifecycleResult> {
    if (event.action === 'INSTALL') {
      return { status: 'Activated', message: 'Mock provider installed successfully' };
    }
    return { status: 'Activated' };
  }
}
