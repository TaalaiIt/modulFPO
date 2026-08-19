import { IFiscalConnectorClient } from '../client/fiscalConnectorClient';
import { FpoError } from '../models/fpoTypes';
import { CoreError } from '../../core/operations/types';
import { AuditLogger, AuditEventType } from '../../core/audit/auditLogger';

export interface RecoveryCredentials {
  rnm: string;
  pin: string;
  login?: string;
  password?: string;
}

export class FpoRecoveryEngine {
  private client: IFiscalConnectorClient;
  private credentialsProvider: () => Promise<RecoveryCredentials>;
  private auditLogger?: AuditLogger;

  constructor(
    client: IFiscalConnectorClient,
    credentialsProvider: () => Promise<RecoveryCredentials>,
    auditLogger?: AuditLogger
  ) {
    this.client = client;
    this.credentialsProvider = credentialsProvider;
    this.auditLogger = auditLogger;
  }

  /**
   * Executes an FPO operation with automatic recovery for errors 40417 (NOT_VERIFY_PIN) and 4011 (REAUTHORIZATION_REQUIRED).
   * Ensures at most 1 automatic recovery attempt per error type.
   */
  public async executeWithRecovery<T>(
    operationName: string,
    operationFn: () => Promise<T>,
    context?: { operationId?: string; externalOperationId?: string; providerCode?: string; providerAccountId?: string }
  ): Promise<T> {
    let pinRetried = false;
    let authRetried = false;

    while (true) {
      try {
        return await operationFn();
      } catch (err: unknown) {
        if (!(err instanceof FpoError)) {
          throw err;
        }

        // Case 1: Error 40417 NOT_VERIFY_PIN
        if (err.code === 40417 && !pinRetried) {
          pinRetried = true;
          this.auditLogger?.log({
            eventType: AuditEventType.RECOVERY_ATTEMPT,
            providerCode: context?.providerCode,
            providerAccountId: context?.providerAccountId,
            externalOperationId: context?.externalOperationId,
            message: `FPO returned 40417 NOT_VERIFY_PIN during ${operationName}. Initiating automatic verify-pin.`,
            details: { operationName, errorCode: err.code }
          });

          const creds = await this.credentialsProvider();
          try {
            await this.client.verifyPin({ rnm: creds.rnm, pin: creds.pin });
          } catch (pinErr: unknown) {
            const pinMsg = pinErr instanceof Error ? pinErr.message : String(pinErr);
            throw new FpoError(
              40417,
              `Automatic verify-pin failed after 40417: ${pinMsg}`,
              'VERIFY_PIN_RECOVERY_FAILED',
              { originalError: err.message, pinError: pinMsg }
            );
          }

          // Retry the original operation after successful PIN verification
          continue;
        }

        // Case 2: Error 4011 REAUTHORIZATION_REQUIRED
        if (err.code === 4011 && !authRetried) {
          authRetried = true;
          this.auditLogger?.log({
            eventType: AuditEventType.RECOVERY_ATTEMPT,
            providerCode: context?.providerCode,
            providerAccountId: context?.providerAccountId,
            externalOperationId: context?.externalOperationId,
            message: `FPO returned 4011 REAUTHORIZATION_REQUIRED during ${operationName}. Initiating automatic re-auth.`,
            details: { operationName, errorCode: err.code }
          });

          const creds = await this.credentialsProvider();
          try {
            await this.client.auth({ rnm: creds.rnm, login: creds.login, password: creds.password });
          } catch (authErr: unknown) {
            const authMsg = authErr instanceof Error ? authErr.message : String(authErr);
            throw new FpoError(
              4011,
              `Automatic re-auth failed after 4011: ${authMsg}`,
              'REAUTH_RECOVERY_FAILED',
              { originalError: err.message, authError: authMsg }
            );
          }

          // Retry original operation after successful authentication
          continue;
        }

        // Check if error is timeout after send
        if (err.code === 40800 || err.errorCodeName === 'TIMEOUT_AFTER_SEND') {
          this.auditLogger?.log({
            eventType: AuditEventType.OPERATION_UNKNOWN,
            providerCode: context?.providerCode,
            providerAccountId: context?.providerAccountId,
            externalOperationId: context?.externalOperationId,
            message: `FiscalConnector response timed out after hardware send during ${operationName}. Operation marked UNKNOWN. Blind retry forbidden.`,
            details: { operationName, errorCode: err.code }
          });
        }

        // If not recoverable or already retried, propagate error
        throw err;
      }
    }
  }

  public mapFpoErrorToCoreError(err: unknown): CoreError {
    if (err instanceof FpoError) {
      if (err.code === 40401) {
        return {
          code: 'SAM_CARD_MISSING',
          message: 'SAM card is not present in reader. Please insert SAM card and retry.',
          isRetryable: true,
          httpStatusCode: 400,
          details: err.details
        };
      }
      if (err.code === 40417) {
        return {
          code: 'SAM_PIN_NOT_VERIFIED',
          message: 'SAM card PIN verification required.',
          isRetryable: false,
          httpStatusCode: 400,
          details: err.details
        };
      }
      if (err.code === 4011) {
        return {
          code: 'FPO_REAUTH_REQUIRED',
          message: 'FPO tax authority session expired. Re-authorization required.',
          isRetryable: false,
          httpStatusCode: 401,
          details: err.details
        };
      }
      if (err.code === 40919 || err.errorCodeName === 'DRAWER_NOT_EMPTY') {
        return {
          code: 'DRAWER_NOT_EMPTY',
          message: err.message,
          isRetryable: false,
          httpStatusCode: 400,
          details: err.details
        };
      }
      if (err.code === 40800 || err.errorCodeName === 'TIMEOUT_AFTER_SEND') {
        return {
          code: 'UNKNOWN_STATUS_TIMEOUT',
          message: 'FiscalConnector request timed out after submission. Operation status is UNKNOWN. Blind retry blocked.',
          isRetryable: false,
          httpStatusCode: 504,
          details: err.details
        };
      }
      if (err.code === 503 || err.errorCodeName === 'CONNECTION_ERROR' || err.errorCodeName === 'CONNECTION_REFUSED') {
        return {
          code: 'FISCAL_CONNECTOR_UNREACHABLE',
          message: err.message,
          isRetryable: true,
          httpStatusCode: 503,
          details: err.details
        };
      }
      return {
        code: `FPO_${err.code}`,
        message: err.message,
        isRetryable: false,
        httpStatusCode: 400,
        details: err.details
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: 'CORE_INTERNAL_ERROR',
      message: msg,
      isRetryable: false,
      httpStatusCode: 500
    };
  }
}
