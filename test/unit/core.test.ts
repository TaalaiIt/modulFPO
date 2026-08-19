import {
  IdempotencyManager,
  InMemoryIdempotencyStore
} from '../../src/core/idempotency/idempotencyManager';
import { AuditLogger, AuditEventType } from '../../src/core/audit/auditLogger';
import { RoutingService } from '../../src/core/routing/routingService';
import {
  NormalizedFiscalOperation,
  OperationType,
  OperationStatus,
  FiscalResult
} from '../../src/core/operations/types';

describe('Integration Core Subsystem Unit Tests', () => {
  describe('IdempotencyManager', () => {
    let manager: IdempotencyManager;

    beforeEach(() => {
      manager = new IdempotencyManager(new InMemoryIdempotencyStore());
    });

    it('should generate correct idempotency key', () => {
      const key = manager.buildKey('MOYSKLAD', 'acc-123', 'SALE', 'demand-456');
      expect(key).toBe('MOYSKLAD:acc-123:SALE:demand-456');
    });

    it('should proceed on first request and calculate hash', async () => {
      const op: NormalizedFiscalOperation = {
        operationId: 'op-1',
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-101',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 150,
        createdAt: new Date().toISOString()
      };

      const check = await manager.checkOrStart(op);
      expect(check.action).toBe('PROCEED');
      if (check.action === 'PROCEED') {
        expect(check.key).toBe('MOCK:acc-1:SALE:doc-101');
        expect(check.hash).toBeDefined();
      }
    });

    it('should return cached result on identical duplicate request (UC-18)', async () => {
      const op: NormalizedFiscalOperation = {
        operationId: 'op-1',
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-101',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 150,
        createdAt: new Date().toISOString()
      };

      const check1 = await manager.checkOrStart(op);
      expect(check1.action).toBe('PROCEED');

      const mockResult: FiscalResult = {
        success: true,
        operationId: op.operationId,
        providerCode: op.providerCode,
        providerAccountId: op.providerAccountId,
        externalOperationId: op.externalOperationId,
        operationType: OperationType.SALE,
        status: OperationStatus.SUCCESS,
        fiscalDocNumber: 105,
        fiscalDocSign: 'FPD-105-ABC',
        completedAt: new Date().toISOString()
      };

      if (check1.action === 'PROCEED') {
        await manager.markSuccess(check1.key, mockResult);
      }

      // Duplicate identical call
      const check2 = await manager.checkOrStart(op);
      expect(check2.action).toBe('RETURN_CACHED');
      if (check2.action === 'RETURN_CACHED') {
        expect(check2.result.fiscalDocNumber).toBe(105);
        expect(check2.result.fiscalDocSign).toBe('FPD-105-ABC');
      }
    });

    it('should reject with PAYLOAD_CONFLICT if same key has different payload', async () => {
      const op1: NormalizedFiscalOperation = {
        operationId: 'op-1',
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-101',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 150,
        rawExternalPayload: { sum: 150 },
        createdAt: new Date().toISOString()
      };

      await manager.checkOrStart(op1);

      const op2Modified: NormalizedFiscalOperation = {
        operationId: 'op-2',
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-101',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 200,
        rawExternalPayload: { sum: 200 }, // Different!
        createdAt: new Date().toISOString()
      };

      const check2 = await manager.checkOrStart(op2Modified);
      expect(check2.action).toBe('REJECT');
      if (check2.action === 'REJECT') {
        expect(check2.error.code).toBe('PAYLOAD_CONFLICT');
      }
    });

    it('should reject retry when operation is in UNKNOWN status (UC-15)', async () => {
      const op: NormalizedFiscalOperation = {
        operationId: 'op-1',
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-101',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 150,
        rawExternalPayload: { sum: 150 },
        createdAt: new Date().toISOString()
      };

      const check1 = await manager.checkOrStart(op);
      if (check1.action === 'PROCEED') {
        await manager.markUnknown(check1.key, {
          code: 'TIMEOUT',
          message: 'Timeout after sending to FPO',
          isRetryable: false
        });
      }

      // Retry attempt
      const check2 = await manager.checkOrStart(op);
      expect(check2.action).toBe('REJECT');
      if (check2.action === 'REJECT') {
        expect(check2.error.code).toBe('OPERATION_STATUS_UNKNOWN');
      }
    });
  });

  describe('AuditLogger', () => {
    let logger: AuditLogger;

    beforeEach(() => {
      logger = new AuditLogger();
    });

    it('should sanitize sensitive credentials (PIN, password, secret, token)', () => {
      const record = logger.log({
        eventType: AuditEventType.DIAGNOSTIC_RUN,
        message: 'Agent test',
        details: {
          rnm: '000123456789',
          pin: '1234',
          fpoPassword: 'SecretPassword!',
          access_token: 'jwt.token.here',
          nested: {
            authSecret: 'super-secret'
          }
        }
      });

      expect(record.details?.pin).toBe('***REDACTED***');
      expect(record.details?.fpoPassword).toBe('***REDACTED***');
      expect(record.details?.access_token).toBe('***REDACTED***');
      expect((record.details?.nested as any)?.authSecret).toBe('***REDACTED***');
      expect(record.details?.rnm).toBe('000123456789');
    });
  });

  describe('RoutingService', () => {
    let routing: RoutingService;

    beforeEach(() => {
      routing = new RoutingService();
    });

    it('should store and resolve store bindings', () => {
      routing.registerStoreBinding({
        providerCode: 'MOCK',
        providerAccountId: 'acc-1',
        storeId: 'store-100',
        agentId: 'agent-pc-1',
        rnm: '000123456789',
        paperWidthMm: 80,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const binding = routing.getStoreBinding('MOCK', 'acc-1', 'store-100');
      expect(binding).toBeDefined();
      expect(binding?.agentId).toBe('agent-pc-1');
      expect(binding?.paperWidthMm).toBe(80);
    });
  });
});
