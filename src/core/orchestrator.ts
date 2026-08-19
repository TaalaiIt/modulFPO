import { ProviderRegistry } from '../providers/common/providerRegistry';
import { IdempotencyManager } from './idempotency/idempotencyManager';
import { RoutingService } from './routing/routingService';
import { AuditLogger, AuditEventType } from './audit/auditLogger';
import {
  NormalizedFiscalOperation,
  FiscalResult,
  OperationStatus,
  CoreError
} from './operations/types';

export interface DispatchHandler {
  (operation: NormalizedFiscalOperation, agentId: string): Promise<FiscalResult>;
}

export class IntegrationOrchestrator {
  public providerRegistry: ProviderRegistry;
  public idempotencyManager: IdempotencyManager;
  public routingService: RoutingService;
  public auditLogger: AuditLogger;
  private directDispatchHandler?: DispatchHandler;

  constructor(options?: {
    providerRegistry?: ProviderRegistry;
    idempotencyManager?: IdempotencyManager;
    routingService?: RoutingService;
    auditLogger?: AuditLogger;
    directDispatchHandler?: DispatchHandler;
  }) {
    this.providerRegistry = options?.providerRegistry || new ProviderRegistry();
    this.idempotencyManager = options?.idempotencyManager || new IdempotencyManager();
    this.routingService = options?.routingService || new RoutingService();
    this.auditLogger = options?.auditLogger || new AuditLogger();
    this.directDispatchHandler = options?.directDispatchHandler;
  }

  public setDirectDispatchHandler(handler: DispatchHandler): void {
    this.directDispatchHandler = handler;
  }

  /**
   * Main entry point for all incoming external fiscal requests
   */
  public async handleFiscalRequest(
    providerCode: string,
    rawRequest: {
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
      rawBody?: string | Buffer;
      url?: string;
      method?: string;
    }
  ): Promise<{ statusCode: number; headers?: Record<string, string>; body: unknown; rawResult: FiscalResult }> {
    const adapter = this.providerRegistry.getOrThrow(providerCode);

    // 1. Verify signature/authentication
    if (adapter.verifyRequest) {
      const auth = await adapter.verifyRequest(rawRequest);
      if (!auth.valid) {
        this.auditLogger.log({
          eventType: AuditEventType.OPERATION_FAILED,
          providerCode,
          message: `Provider authentication/signature failed: ${auth.error}`
        });

        const errorResult = this.createErrorResult(
          'unknown',
          providerCode,
          auth.accountId || 'unknown',
          'unknown',
          {
            code: 'AUTH_FAILED',
            message: auth.error || 'Provider authentication/signature verification failed.',
            isRetryable: false,
            httpStatusCode: 401
          }
        );
        const providerRes = await adapter.mapToProviderResponse(errorResult);
        return { ...providerRes, rawResult: errorResult };
      }
    }

    // 2. Map to NormalizedFiscalOperation
    const operation = await adapter.mapToNormalized(rawRequest);

    this.auditLogger.log({
      eventType: AuditEventType.OPERATION_RECEIVED,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId,
      externalOperationId: operation.externalOperationId,
      operationType: operation.operationType,
      storeId: operation.storeId,
      message: `Received ${operation.operationType} operation from ${operation.providerCode}`
    });

    // 3. Check Idempotency (UC-15, UC-18)
    const idempCheck = await this.idempotencyManager.checkOrStart(operation);

    if (idempCheck.action === 'RETURN_CACHED') {
      this.auditLogger.log({
        eventType: AuditEventType.OPERATION_COMPLETED,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        message: `Idempotent duplicate request. Returning cached fiscal result without calling FPO. (UC-18)`
      });
      const providerRes = await adapter.mapToProviderResponse(idempCheck.result);
      return { ...providerRes, rawResult: idempCheck.result };
    }

    if (idempCheck.action === 'REJECT') {
      this.auditLogger.log({
        eventType: AuditEventType.OPERATION_FAILED,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        message: `Idempotency check rejected: ${idempCheck.error.code} - ${idempCheck.error.message}`
      });
      const errorResult = this.createErrorResult(
        operation.operationId,
        operation.providerCode,
        operation.providerAccountId,
        operation.externalOperationId,
        idempCheck.error
      );
      const providerRes = await adapter.mapToProviderResponse(errorResult);
      return { ...providerRes, rawResult: errorResult };
    }

    const { key } = idempCheck;

    // 4. Resolve Target Agent & Store Routing (UC-01, UC-23)
    const storeBinding = this.routingService.getStoreBinding(
      operation.providerCode,
      operation.providerAccountId,
      operation.storeId
    );

    const targetAgentId = operation.agentId || storeBinding?.agentId || 'default-agent';

    // 5. Dispatch command to Agent
    let agentResult: FiscalResult;
    try {
      this.auditLogger.log({
        eventType: AuditEventType.OPERATION_DISPATCHED,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        agentId: targetAgentId,
        message: `Dispatching ${operation.operationType} to agent ${targetAgentId}`
      });

      if (this.directDispatchHandler) {
        agentResult = await this.directDispatchHandler(operation, targetAgentId);
      } else {
        const transport = this.routingService.getAgentTransport(targetAgentId);
        if (!transport || !transport.isOnline()) {
          throw new Error(`Target Fiscal Agent '${targetAgentId}' is offline or not connected.`);
        }
        agentResult = await transport.send<NormalizedFiscalOperation, FiscalResult>('COMMAND', operation);
      }
    } catch (dispatchErr: unknown) {
      const errMessage = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);

      // Check if dispatch failed before sending or timed out after sending
      const isTimeout = errMessage.includes('timeout') || errMessage.includes('TIMEOUT');
      if (isTimeout) {
        // UNKNOWN status handling (UC-15)
        const unknownError: CoreError = {
          code: 'UNKNOWN_STATUS_TIMEOUT',
          message: 'Operation response timed out after dispatch. State set to UNKNOWN. Blind retry blocked.',
          isRetryable: false,
          httpStatusCode: 504
        };
        await this.idempotencyManager.markUnknown(key, unknownError);
        agentResult = this.createErrorResult(
          operation.operationId,
          operation.providerCode,
          operation.providerAccountId,
          operation.externalOperationId,
          unknownError
        );
        agentResult.status = OperationStatus.UNKNOWN;
      } else {
        const networkError: CoreError = {
          code: 'AGENT_COMMUNICATION_ERROR',
          message: `Cannot reach agent: ${errMessage}`,
          isRetryable: true,
          httpStatusCode: 503
        };
        await this.idempotencyManager.markFailed(key, networkError);
        agentResult = this.createErrorResult(
          operation.operationId,
          operation.providerCode,
          operation.providerAccountId,
          operation.externalOperationId,
          networkError
        );
      }
    }

    // 6. Handle successful response & receipt generation
    if (agentResult.success && agentResult.status === OperationStatus.SUCCESS) {
      // Generate receipt if requested by provider adapter
      if (!agentResult.receipt) {
        try {
          const receiptData = await adapter.generateReceiptData(operation, agentResult, {
            paperWidthMm: storeBinding?.paperWidthMm || 80
          });
          agentResult.receipt = receiptData;
        } catch (receiptErr: unknown) {
          this.auditLogger.log({
            eventType: AuditEventType.OPERATION_FAILED,
            message: `Receipt generation failed: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`
          });
        }
      }

      await this.idempotencyManager.markSuccess(key, agentResult);

      this.auditLogger.log({
        eventType: AuditEventType.OPERATION_COMPLETED,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        fiscalDocNumber: agentResult.fiscalDocNumber,
        fiscalDocSign: agentResult.fiscalDocSign,
        message: `Operation ${operation.operationType} completed successfully. FD: ${agentResult.fiscalDocNumber}, FPD: ${agentResult.fiscalDocSign}`
      });
    } else if (agentResult.status === OperationStatus.UNKNOWN) {
      await this.idempotencyManager.markUnknown(key, agentResult.error);
    } else if (!agentResult.success) {
      if (agentResult.error) {
        await this.idempotencyManager.markFailed(key, agentResult.error);
      }
    }

    const providerResponse = await adapter.mapToProviderResponse(agentResult);
    return { ...providerResponse, rawResult: agentResult };
  }

  private createErrorResult(
    operationId: string,
    providerCode: string,
    providerAccountId: string,
    externalOperationId: string,
    error: CoreError
  ): FiscalResult {
    return {
      success: false,
      operationId,
      providerCode,
      providerAccountId,
      externalOperationId,
      operationType: 'SALE' as any,
      status: OperationStatus.FAILED,
      error,
      completedAt: new Date().toISOString()
    };
  }
}
