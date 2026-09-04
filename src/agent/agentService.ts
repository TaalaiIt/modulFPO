import { HttpFiscalConnectorClient, IFiscalConnectorClient } from '../fpo/client/fiscalConnectorClient';
import { FpoRecoveryEngine, RecoveryCredentials } from '../fpo/recovery/fpoRecoveryEngine';
import { LicenseClient } from '../licensing/client/licenseClient';
import { SecureLocalStorage, LocalAgentSecrets } from './secureStorage';
import {
  NormalizedFiscalOperation,
  FiscalResult,
  OperationType,
  OperationStatus,
  CoreError
} from '../core/operations/types';
import { AuditLogger, AuditEventType } from '../core/audit/auditLogger';
import { FpoReceiptPositionDto, FpoSamCard, FpoError } from '../fpo/models/fpoTypes';

export interface AgentDiagnosticResult {
  healthy: boolean;
  fcConnected: boolean;
  samCardPresent: boolean;
  pinVerified: boolean;
  shiftStatus?: string;
  rnm: string;
  fnNumber?: string;
  errors: string[];
}

export class AgentService {
  private agentId: string;
  private fpoClient: IFiscalConnectorClient;
  private recoveryEngine: FpoRecoveryEngine;
  private licenseClient: LicenseClient;
  private storage: SecureLocalStorage;
  private auditLogger?: AuditLogger;

  constructor(
    agentId: string,
    fpoClient: IFiscalConnectorClient,
    licenseClient: LicenseClient,
    storage: SecureLocalStorage,
    auditLogger?: AuditLogger
  ) {
    this.agentId = agentId;
    this.fpoClient = fpoClient;
    this.licenseClient = licenseClient;
    this.storage = storage;
    this.auditLogger = auditLogger;

    const credentialsProvider = async (): Promise<RecoveryCredentials> => {
      const secrets = this.storage.loadSecrets();
      if (!secrets) {
        throw new Error('Local agent credentials not found in secure storage');
      }
      return {
        rnm: secrets.rnm,
        pin: secrets.pin,
        login: secrets.fpoLogin,
        password: secrets.fpoPassword
      };
    };

    this.recoveryEngine = new FpoRecoveryEngine(this.fpoClient, credentialsProvider, this.auditLogger);
  }

  public getAgentId(): string {
    return this.agentId;
  }

  private extractSamCards(samRes: unknown): FpoSamCard[] {
    if (Array.isArray(samRes)) return samRes as FpoSamCard[];
    if (samRes && typeof samRes === 'object' && 'samCards' in samRes) {
      return (samRes as { samCards: FpoSamCard[] }).samCards || [];
    }
    return [];
  }

  /**
   * UC-01 diagnostic check
   */
  public async runDiagnostics(): Promise<AgentDiagnosticResult> {
    const secrets = this.storage.loadSecrets();
    const result: AgentDiagnosticResult = {
      healthy: false,
      fcConnected: false,
      samCardPresent: false,
      pinVerified: false,
      rnm: secrets?.rnm || 'UNKNOWN',
      errors: []
    };

    if (!secrets) {
      result.errors.push('No local credentials configured in agent storage');
      return result;
    }

    try {
      // 1. Check SAM cards if endpoint available
      try {
        const samRes = await this.fpoClient.getSamCards();
        result.fcConnected = true;
        const cards = this.extractSamCards(samRes);
        const card = cards.find((c) => c.cardPresent);
        if (card) {
          result.samCardPresent = true;
        }
      } catch (samErr: unknown) {
        // If /driver/sam-cards is 404, verifyPin below will check card presence
      }

      // 2. Test PIN verification (checks FC connectivity, SAM presence, and PIN)
      try {
        const pinRes = await this.fpoClient.verifyPin({
          registrationNumber: secrets.rnm,
          rnm: secrets.rnm,
          pin: secrets.pin
        });
        result.fcConnected = true;
        result.samCardPresent = true;
        result.pinVerified = true;
        result.fnNumber = pinRes.fiscalModuleNumber;
      } catch (pinErr: unknown) {
        if (pinErr instanceof FpoError) {
          result.fcConnected = true;
          if (pinErr.code === 40401 || pinErr.code === 40416) {
            result.errors.push('SAM card is not present or not selected in reader');
          } else if (pinErr.code === 40402) {
            result.samCardPresent = true;
            result.errors.push('Invalid SAM PIN');
          } else {
            result.errors.push(`PIN verification error: ${pinErr.message}`);
          }
        } else {
          result.errors.push(`FiscalConnector unreachable: ${pinErr instanceof Error ? pinErr.message : String(pinErr)}`);
        }
      }

      // 3. Check shift status
      if (result.pinVerified) {
        try {
          const stateRes = await this.fpoClient.getStateShift();
          const isOpened = stateRes.shiftOpened ?? (stateRes.shiftStatus === 'OPEN');
          result.shiftStatus = isOpened ? 'OPEN' : 'CLOSED';
        } catch (stateErr: unknown) {
          if (stateErr instanceof FpoError && stateErr.code === 40920) {
            result.shiftStatus = 'EXPIRED';
          }
        }
      }

      result.healthy = result.fcConnected && result.samCardPresent && result.pinVerified && result.errors.length === 0;

      this.auditLogger?.log({
        eventType: AuditEventType.DIAGNOSTIC_RUN,
        agentId: this.agentId,
        rnm: secrets.rnm,
        message: `Agent diagnostics complete. Healthy: ${result.healthy}`,
        details: { healthy: result.healthy, errors: result.errors }
      });

      return result;
    } catch (err: unknown) {
      result.errors.push(`Diagnostics error: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  /**
   * Executes a normalized fiscal command on this agent
   */
  public async executeOperation(operation: NormalizedFiscalOperation): Promise<FiscalResult> {
    const secrets = this.storage.loadSecrets();
    if (!secrets) {
      return this.buildFailedResult(operation, {
        code: 'AGENT_CREDENTIALS_MISSING',
        message: 'Agent credentials not initialized in local secure storage.',
        isRetryable: false,
        httpStatusCode: 500
      });
    }

    if (this.fpoClient instanceof HttpFiscalConnectorClient) {
      const paperWidth = operation.metadata?.paperWidthMm;
      this.fpoClient.configure({
        registrationNumber: (operation.metadata?.registrationNumber as string | undefined) || secrets.rnm,
        receiptWidthMm: paperWidth === 56 ? 56 : 80
      });
    }

    // 1. Check Licensing pre-flight gatekeeper (UC-20, UC-21, UC-22)
    const isLocalOp = operation.providerCode === 'SMARTDEV' || operation.providerCode === 'SMARTDEV_LOCAL';
    const licCheck = await this.licenseClient.checkEntitlement({
      providerCode: isLocalOp ? undefined : operation.providerCode,
      providerAccountId: operation.providerAccountId,
      rnm: secrets.rnm
    });

    if (!licCheck.allowed) {
      return this.buildFailedResult(operation, {
        code: licCheck.errorCode || 'LICENSE_BLOCKED',
        message: licCheck.reason || 'Operation blocked by license policy',
        isRetryable: false,
        httpStatusCode: 403
      });
    }

    try {
      switch (operation.operationType) {
        case OperationType.OPEN_SHIFT:
          return await this.handleOpenShift(operation, secrets);

        case OperationType.SALE:
          return await this.handleSale(operation, secrets);

        case OperationType.RETURN:
          return await this.handleReturn(operation, secrets);

        case OperationType.DEPOSIT:
          return await this.handleDeposit(operation);

        case OperationType.WITHDRAW:
          return await this.handleWithdraw(operation);

        case OperationType.CLOSE_SHIFT:
          return await this.handleCloseShift(operation);

        case OperationType.X_REPORT:
          return await this.handleXReport(operation);

        default:
          return this.buildFailedResult(operation, {
            code: 'UNSUPPORTED_OPERATION_TYPE',
            message: `Operation type ${operation.operationType} is not supported.`,
            isRetryable: false,
            httpStatusCode: 400
          });
      }
    } catch (err: unknown) {
      const coreError = this.recoveryEngine.mapFpoErrorToCoreError(err);
      return this.buildFailedResult(operation, coreError);
    }
  }

  private async handleOpenShift(
    operation: NormalizedFiscalOperation,
    secrets: LocalAgentSecrets
  ): Promise<FiscalResult> {
    // 1. Verify SAM cards if endpoint is supported by driver build
    try {
      const samCardsRes = await this.fpoClient.getSamCards();
      const cards = this.extractSamCards(samCardsRes);
      const card = cards.find((c) => c.cardPresent);
      if (cards.length > 0 && !card) {
        return this.buildFailedResult(operation, {
          code: 'SAM_CARD_MISSING',
          message: 'SAM card is missing in card reader. Please insert SAM card and retry. (UC-03)',
          isRetryable: true,
          httpStatusCode: 400
        });
      }
    } catch {
      // If /driver/sam-cards is 404, verifyPin in recoveryEngine will validate SAM card presence
    }

    // 2. Execute verify-pin and auth with recovery (UC-02, UC-04, UC-16, UC-17)
    return await this.recoveryEngine.executeWithRecovery('OPEN_SHIFT', async () => {
      // First verify PIN if needed
      await this.fpoClient.verifyPin({
        registrationNumber: secrets.rnm,
        rnm: secrets.rnm,
        pin: secrets.pin
      });

      // Then authenticate with GNS
      await this.fpoClient.auth({
        registrationNumber: secrets.rnm,
        rnm: secrets.rnm,
        login: secrets.fpoLogin,
        password: secrets.fpoPassword
      });

      // Check state
      const state = await this.fpoClient.getStateShift();
      const isShiftOpen = state.shiftOpened ?? (state.shiftStatus === 'OPEN');
      if (isShiftOpen) {
        // Already open
        return {
          success: true,
          operationId: operation.operationId,
          providerCode: operation.providerCode,
          providerAccountId: operation.providerAccountId,
          externalOperationId: operation.externalOperationId,
          operationType: OperationType.OPEN_SHIFT,
          status: OperationStatus.SUCCESS,
          shiftNumber: state.shiftNumber || 1,
          kktRegNumber: secrets.rnm,
          completedAt: new Date().toISOString()
        };
      }

      // Open shift
      const openRes = await this.fpoClient.openShift({
        cashier: operation.cashier ? { name: operation.cashier.name || 'Кассир', inn: operation.cashier.inn } : undefined
      });

      const fdNumber = openRes.fdNumber ?? openRes.fiscalDocNumber ?? 1;
      const fiscalDocSign = openRes.fiscalMark ?? openRes.fiscalDocSign ?? `FPD-${fdNumber}`;

      return {
        success: true,
        operationId: operation.operationId,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        operationType: OperationType.OPEN_SHIFT,
        status: OperationStatus.SUCCESS,
        fiscalDocNumber: fdNumber,
        fiscalDocSign,
        fnNumber: openRes.fmNumber ?? openRes.fnNumber ?? secrets.rnm,
        kktRegNumber: openRes.registrationNumber ?? openRes.kktRegNumber ?? secrets.rnm,
        shiftNumber: openRes.shiftNumber,
        fiscalDateTime: openRes.date ?? openRes.time ?? new Date().toISOString(),
        completedAt: new Date().toISOString()
      };
    }, {
      operationId: operation.operationId,
      externalOperationId: operation.externalOperationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId
    });
  }

  private mapItemsToPositions(items: NormalizedFiscalOperation['items'] = []): FpoReceiptPositionDto[] {
    return items.map((it) => {
      let vat = 0;
      if (it.tax?.vatRate === 'VAT_12') vat = 1;
      let st = 0;
      if (it.tax?.salesTaxRate) {
        const m = it.tax.salesTaxRate.match(/\d+/);
        if (m) st = parseInt(m[0], 10);
      }

      return {
        calcItemAttributeCode: it.calcItemAttributeCode ?? 1,
        sgtin: it.sgtin,
        name: it.name,
        price: it.price,
        quantity: it.quantity,
        cost: it.totalSum,
        measure: it.measureUnit || 'PIECE',
        vat,
        st,
        vatRate: it.tax?.vatRate,
        salesTaxRate: it.tax?.salesTaxRate
      };
    });
  }

  private async handleSale(
    operation: NormalizedFiscalOperation,
    secrets: LocalAgentSecrets
  ): Promise<FiscalResult> {
    const positions = this.mapItemsToPositions(operation.items);
    const cashSum = operation.totalCashSum || 0;
    const cashlessSum = operation.totalCashlessSum || 0;
    const totalSum = operation.totalSum || (cashSum + cashlessSum);

    return await this.recoveryEngine.executeWithRecovery('SALE', async () => {
      const res = await this.fpoClient.createReceipt({
        operationType: 'INCOME',
        cashier: operation.cashier ? { name: operation.cashier.name || 'Кассир', inn: operation.cashier.inn } : undefined,
        positions,
        items: positions,
        paySum: totalSum,
        deliverySum: 0,
        totalSum,
        totalCashSum: cashSum,
        totalCashlessSum: cashlessSum
      });

      const fdNumber = res.fdNumber ?? res.fiscalDocNumber ?? 1;
      const fiscalDocSign = res.fiscalMark ?? res.fiscalDocSign ?? `FPD-${fdNumber}`;

      return {
        success: true,
        operationId: operation.operationId,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        operationType: OperationType.SALE,
        status: OperationStatus.SUCCESS,
        fiscalDocNumber: fdNumber,
        fiscalDocSign,
        fnNumber: res.fmNumber ?? res.fnNumber ?? secrets.rnm,
        kktRegNumber: res.registrationNumber ?? res.kktRegNumber ?? secrets.rnm,
        fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
        qrCodeUrl: res.qrCodeUrl,
        completedAt: new Date().toISOString()
      };
    }, {
      operationId: operation.operationId,
      externalOperationId: operation.externalOperationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId
    });
  }

  private async handleReturn(
    operation: NormalizedFiscalOperation,
    secrets: LocalAgentSecrets
  ): Promise<FiscalResult> {
    if (!operation.originFiscalDoc) {
      return this.buildFailedResult(operation, {
        code: 'ORIGIN_FISCAL_DOC_REQUIRED',
        message: 'Return operation requires originFdNumber and originFnSerialNumber from original sale. (UC-08)',
        isRetryable: false,
        httpStatusCode: 400
      });
    }

    const positions = this.mapItemsToPositions(operation.items);
    const cashSum = operation.totalCashSum || 0;
    const cashlessSum = operation.totalCashlessSum || 0;
    const totalSum = operation.totalSum || (cashSum + cashlessSum);

    return await this.recoveryEngine.executeWithRecovery('RETURN', async () => {
      const res = await this.fpoClient.createReceipt({
        operationType: 'INCOME_RETURN',
        cashier: operation.cashier ? { name: operation.cashier.name || 'Кассир', inn: operation.cashier.inn } : undefined,
        positions,
        items: positions,
        paySum: totalSum,
        deliverySum: 0,
        totalSum,
        totalCashSum: cashSum,
        totalCashlessSum: cashlessSum,
        originFdNumber: operation.originFiscalDoc?.originFdNumber,
        originFnSerialNumber: operation.originFiscalDoc?.originFnSerialNumber,
        originDate: operation.originFiscalDoc?.originDate
      });

      const fdNumber = res.fdNumber ?? res.fiscalDocNumber ?? 1;
      const fiscalDocSign = res.fiscalMark ?? res.fiscalDocSign ?? `FPD-${fdNumber}`;

      return {
        success: true,
        operationId: operation.operationId,
        providerCode: operation.providerCode,
        providerAccountId: operation.providerAccountId,
        externalOperationId: operation.externalOperationId,
        operationType: OperationType.RETURN,
        status: OperationStatus.SUCCESS,
        fiscalDocNumber: fdNumber,
        fiscalDocSign,
        fnNumber: res.fmNumber ?? res.fnNumber ?? secrets.rnm,
        kktRegNumber: res.registrationNumber ?? res.kktRegNumber ?? secrets.rnm,
        fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
        qrCodeUrl: res.qrCodeUrl,
        completedAt: new Date().toISOString()
      };
    }, {
      operationId: operation.operationId,
      externalOperationId: operation.externalOperationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId
    });
  }

  private async handleDeposit(operation: NormalizedFiscalOperation): Promise<FiscalResult> {
    const sum = operation.totalSum || operation.totalCashSum || 0;
    const res = await this.fpoClient.deposit({
      amount: sum,
      sum,
      cashier: operation.cashier ? { name: operation.cashier.name || 'Кассир', inn: operation.cashier.inn } : undefined
    });

    const fdNumber = res.fiscalDocNumber || 1;
    const fiscalDocSign = res.fiscalDocSign || `FPD-DEP-${fdNumber}`;

    return {
      success: true,
      operationId: operation.operationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId,
      externalOperationId: operation.externalOperationId,
      operationType: OperationType.DEPOSIT,
      status: OperationStatus.SUCCESS,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }

  private async handleWithdraw(operation: NormalizedFiscalOperation): Promise<FiscalResult> {
    const sum = operation.totalSum || operation.totalCashSum || 0;
    const res = await this.fpoClient.withdraw({
      amount: sum,
      sum,
      cashier: operation.cashier ? { name: operation.cashier.name || 'Кассир', inn: operation.cashier.inn } : undefined
    });

    const fdNumber = res.fiscalDocNumber || 1;
    const fiscalDocSign = res.fiscalDocSign || `FPD-WITH-${fdNumber}`;

    return {
      success: true,
      operationId: operation.operationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId,
      externalOperationId: operation.externalOperationId,
      operationType: OperationType.WITHDRAW,
      status: OperationStatus.SUCCESS,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }

  private async handleCloseShift(operation: NormalizedFiscalOperation): Promise<FiscalResult> {
    // 1. Check cash balance before closing (UC-12, UC-13)
    const cashRes = await this.fpoClient.getCashTransaction();
    const cashInDrawer = cashRes.totalAmount ?? cashRes.cashSum ?? 0;
    if (cashInDrawer > 0) {
      return this.buildFailedResult(operation, {
        code: 'DRAWER_NOT_EMPTY',
        message: `Cannot close shift with non-zero cash in drawer (${cashInDrawer} KGS). Please perform cash withdrawal first. (UC-13)`,
        isRetryable: false,
        httpStatusCode: 400,
        details: { cashInDrawer }
      });
    }

    const res = await this.fpoClient.closeShift();
    const fdNumber = res.fdNumber ?? res.fiscalDocNumber ?? 1;
    const fiscalDocSign = res.fiscalMark ?? res.fiscalDocSign ?? `FPD-Z-${fdNumber}`;

    return {
      success: true,
      operationId: operation.operationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId,
      externalOperationId: operation.externalOperationId,
      operationType: OperationType.CLOSE_SHIFT,
      status: OperationStatus.SUCCESS,
      shiftNumber: res.shiftNumber,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: res.fmNumber ?? res.fnNumber,
      kktRegNumber: res.registrationNumber ?? res.kktRegNumber,
      fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
      chequesTotal: res.chequesTotal,
      fiscalDocsTotal: res.fiscalDocsTotal,
      completedAt: new Date().toISOString()
    };
  }

  private async handleXReport(operation: NormalizedFiscalOperation): Promise<FiscalResult> {
    const res = await this.fpoClient.getXReport();
    return {
      success: true,
      operationId: operation.operationId,
      providerCode: operation.providerCode,
      providerAccountId: operation.providerAccountId,
      externalOperationId: operation.externalOperationId,
      operationType: OperationType.X_REPORT,
      status: OperationStatus.SUCCESS,
      shiftNumber: res.shiftNumber,
      fiscalDateTime: res.date ?? res.time ?? new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }

  private buildFailedResult(op: NormalizedFiscalOperation, error: CoreError): FiscalResult {
    const isUnknown =
      error.code === 'UNKNOWN_STATUS_TIMEOUT' ||
      error.code === 'TIMEOUT_AFTER_SEND' ||
      error.code === 'OPERATION_STATUS_UNKNOWN';

    return {
      success: false,
      operationId: op.operationId,
      providerCode: op.providerCode,
      providerAccountId: op.providerAccountId,
      externalOperationId: op.externalOperationId,
      operationType: op.operationType,
      status: isUnknown ? OperationStatus.UNKNOWN : OperationStatus.FAILED,
      error,
      completedAt: new Date().toISOString()
    };
  }
}
