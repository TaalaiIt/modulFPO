import {
  FpoSamCardsResponse,
  FpoVerifyPinRequest,
  FpoVerifyPinResponse,
  FpoAuthRequest,
  FpoAuthResponse,
  FpoStateShiftResponse,
  FpoOpenShiftRequest,
  FpoOpenShiftResponse,
  FpoReceiptRequest,
  FpoReceiptResponse,
  FpoDepositRequest,
  FpoWithdrawRequest,
  FpoCashTransactionResponse,
  FpoCashTransactionResult,
  FpoCloseShiftResponse,
  FpoXReportResponse,
  FpoAvailableTaxRatesResponse,
  FpoError
} from '../models/fpoTypes';

export interface MockFpoConfig {
  samCardPresent?: boolean;
  pinVerified?: boolean;
  authenticated?: boolean;
  shiftStatus?: 'CLOSED' | 'OPEN' | 'EXPIRED';
  shiftNumber?: number;
  initialCash?: number;
  rnm?: string;
  fnNumber?: string;
  correctPin?: string;
  // Simulation hooks
  simulate40417Once?: boolean;
  simulate4011Once?: boolean;
  simulateAuthNetworkFailure?: boolean;
  simulateTimeoutOnReceipt?: boolean;
  simulateFpoOffline?: boolean;
}

export class MockFiscalConnector {
  private config: Required<MockFpoConfig>;
  private fdCounter = 100;
  private chequesInShift = 0;
  private docsInShift = 0;
  private totalIncome = 0;
  private totalExpenditure = 0;
  private currentCash = 0;

  // History for verification
  public operationLog: Array<{ endpoint: string; body?: unknown; timestamp: string }> = [];

  constructor(initialConfig?: MockFpoConfig) {
    this.config = {
      samCardPresent: initialConfig?.samCardPresent ?? true,
      pinVerified: initialConfig?.pinVerified ?? true,
      authenticated: initialConfig?.authenticated ?? true,
      shiftStatus: initialConfig?.shiftStatus ?? 'CLOSED',
      shiftNumber: initialConfig?.shiftNumber ?? 1,
      initialCash: initialConfig?.initialCash ?? 0,
      rnm: initialConfig?.rnm ?? '000123456789',
      fnNumber: initialConfig?.fnNumber ?? 'FM9876543210',
      correctPin: initialConfig?.correctPin ?? '1234',
      simulate40417Once: initialConfig?.simulate40417Once ?? false,
      simulate4011Once: initialConfig?.simulate4011Once ?? false,
      simulateAuthNetworkFailure: initialConfig?.simulateAuthNetworkFailure ?? false,
      simulateTimeoutOnReceipt: initialConfig?.simulateTimeoutOnReceipt ?? false,
      simulateFpoOffline: initialConfig?.simulateFpoOffline ?? false
    };
    this.currentCash = this.config.initialCash;
  }

  public updateConfig(updates: Partial<MockFpoConfig>): void {
    Object.assign(this.config, updates);
  }

  private checkOffline(): void {
    if (this.config.simulateFpoOffline) {
      throw new FpoError(503, 'FiscalConnector daemon unreachable at localhost:8080', 'CONNECTION_REFUSED');
    }
  }

  public async getSamCards(): Promise<FpoSamCardsResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/sam-cards', timestamp: new Date().toISOString() });
    return {
      samCards: [
        {
          slot: 0,
          cardPresent: this.config.samCardPresent,
          cardId: this.config.samCardPresent ? 'SAM-CARD-KR-001' : undefined,
          atr: this.config.samCardPresent ? '3B7F96000080318065B0' : undefined
        }
      ]
    };
  }

  public async verifyPin(req: FpoVerifyPinRequest): Promise<FpoVerifyPinResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/verify-pin', body: req, timestamp: new Date().toISOString() });

    if (!this.config.samCardPresent) {
      throw new FpoError(40401, 'SAM card not present in reader', 'SAM_NOT_PRESENT');
    }
    if (req.pin !== this.config.correctPin) {
      throw new FpoError(40402, 'Invalid SAM PIN', 'INVALID_PIN');
    }

    this.config.pinVerified = true;
    return { success: true, message: 'PIN successfully verified' };
  }

  public async auth(req: FpoAuthRequest): Promise<FpoAuthResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/auth', body: req, timestamp: new Date().toISOString() });

    if (this.config.simulateAuthNetworkFailure) {
      throw new FpoError(40801, 'Network timeout contacting GNS tax service', 'GNS_NETWORK_TIMEOUT');
    }
    if (!this.config.samCardPresent) {
      throw new FpoError(40401, 'SAM card not present in reader', 'SAM_NOT_PRESENT');
    }

    this.config.authenticated = true;
    return {
      success: true,
      accessToken: `fpo_access_token_${Math.random().toString(36).substring(2, 10)}`,
      expiresIn: 300 // 5 minutes
    };
  }

  public async getStateShift(): Promise<FpoStateShiftResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/state-shift', timestamp: new Date().toISOString() });
    return {
      shiftStatus: this.config.shiftStatus,
      shiftNumber: this.config.shiftNumber,
      openTime: this.config.shiftStatus !== 'CLOSED' ? new Date(Date.now() - 3600000).toISOString() : undefined
    };
  }

  public async openShift(req?: FpoOpenShiftRequest): Promise<FpoOpenShiftResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/open-shift', body: req, timestamp: new Date().toISOString() });

    if (!this.config.samCardPresent) {
      throw new FpoError(40401, 'SAM card not present in reader', 'SAM_NOT_PRESENT');
    }
    if (!this.config.pinVerified) {
      throw new FpoError(40417, 'PIN not verified for SAM card', 'NOT_VERIFY_PIN');
    }
    if (!this.config.authenticated) {
      throw new FpoError(4011, 'Reauthorization required with GNS tax authority', 'REAUTHORIZATION_REQUIRED');
    }
    if (this.config.shiftStatus === 'OPEN') {
      throw new FpoError(40901, 'Shift is already open', 'SHIFT_ALREADY_OPEN');
    }

    this.config.shiftStatus = 'OPEN';
    this.config.shiftNumber += 1;
    this.chequesInShift = 0;
    this.docsInShift = 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const fiscalDocSign = `FPD-${fdNumber}-${Date.now().toString(36).toUpperCase()}`;

    return {
      success: true,
      shiftNumber: this.config.shiftNumber,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: new Date().toISOString()
    };
  }

  public async createReceipt(req: FpoReceiptRequest): Promise<FpoReceiptResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/cash-register/receipt', body: req, timestamp: new Date().toISOString() });

    // Handle 40417 simulation
    if (this.config.simulate40417Once) {
      this.config.simulate40417Once = false;
      this.config.pinVerified = false;
      throw new FpoError(40417, 'PIN not verified for SAM card', 'NOT_VERIFY_PIN');
    }

    // Handle 4011 simulation
    if (this.config.simulate4011Once) {
      this.config.simulate4011Once = false;
      this.config.authenticated = false;
      throw new FpoError(4011, 'Reauthorization required with GNS tax authority', 'REAUTHORIZATION_REQUIRED');
    }

    // Handle timeout simulation
    if (this.config.simulateTimeoutOnReceipt) {
      this.config.simulateTimeoutOnReceipt = false;
      // In real world, receipt might have succeeded in hardware but response timed out
      this.fdCounter += 1;
      throw new FpoError(40800, 'FiscalConnector response timed out after hardware send', 'TIMEOUT_AFTER_SEND');
    }

    if (!this.config.samCardPresent) {
      throw new FpoError(40401, 'SAM card not present in reader', 'SAM_NOT_PRESENT');
    }
    if (!this.config.pinVerified) {
      throw new FpoError(40417, 'PIN not verified for SAM card', 'NOT_VERIFY_PIN');
    }
    if (!this.config.authenticated) {
      throw new FpoError(4011, 'Reauthorization required with GNS tax authority', 'REAUTHORIZATION_REQUIRED');
    }
    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    // Update cash drawer & statistics
    const totalSum = (req.totalCashSum || 0) + (req.totalCashlessSum || 0);
    if (req.operationType === 'INCOME') {
      this.currentCash += req.totalCashSum || 0;
      this.totalIncome += totalSum;
    } else {
      this.currentCash -= req.totalCashSum || 0;
      this.totalExpenditure += totalSum;
    }

    this.chequesInShift += 1;
    this.docsInShift += 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const fiscalDocSign = `FPD-${fdNumber}-${Math.floor(100000 + Math.random() * 900000)}`;

    return {
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: new Date().toISOString(),
      qrCodeUrl: `https://tax.gov.kg/check?kkt=${this.config.rnm}&fn=${this.config.fnNumber}&fd=${fdNumber}&fpd=${fiscalDocSign}`
    };
  }

  public async deposit(req: FpoDepositRequest): Promise<FpoCashTransactionResult> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/cash-transaction/deposit', body: req, timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    this.currentCash += req.sum;
    this.docsInShift += 1;
    this.fdCounter += 1;

    return {
      success: true,
      fiscalDocNumber: this.fdCounter,
      fiscalDocSign: `FPD-DEP-${this.fdCounter}`,
      time: new Date().toISOString(),
      newBalance: this.currentCash
    };
  }

  public async withdraw(req: FpoWithdrawRequest): Promise<FpoCashTransactionResult> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/cash-transaction/withdraw', body: req, timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }
    if (this.currentCash < req.sum) {
      throw new FpoError(40918, `Insufficient cash in drawer: requested ${req.sum}, available ${this.currentCash}`, 'INSUFFICIENT_CASH');
    }

    this.currentCash -= req.sum;
    this.docsInShift += 1;
    this.fdCounter += 1;

    return {
      success: true,
      fiscalDocNumber: this.fdCounter,
      fiscalDocSign: `FPD-WITH-${this.fdCounter}`,
      time: new Date().toISOString(),
      newBalance: this.currentCash
    };
  }

  public async getCashTransaction(): Promise<FpoCashTransactionResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/cash-transaction', timestamp: new Date().toISOString() });
    return {
      cashSum: this.currentCash,
      totalIncomeSum: this.totalIncome,
      totalExpenditureSum: this.totalExpenditure
    };
  }

  public async closeShift(): Promise<FpoCloseShiftResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/close-shift', timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    // Check non-zero drawer balance rule (error 40919 from FPO)
    if (this.currentCash > 0) {
      throw new FpoError(
        40919,
        `Cannot close shift with non-zero cash in drawer (${this.currentCash} KGS). Please perform cash withdrawal first.`,
        'DRAWER_NOT_EMPTY',
        { currentCash: this.currentCash }
      );
    }

    this.config.shiftStatus = 'CLOSED';
    this.docsInShift += 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const fiscalDocSign = `FPD-Z-${fdNumber}-${this.config.shiftNumber}`;

    const res: FpoCloseShiftResponse = {
      success: true,
      shiftNumber: this.config.shiftNumber,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: new Date().toISOString(),
      chequesTotal: this.chequesInShift,
      fiscalDocsTotal: this.docsInShift
    };

    return res;
  }

  public async getXReport(): Promise<FpoXReportResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/x-report', timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    return {
      success: true,
      shiftNumber: this.config.shiftNumber,
      cashSum: this.currentCash,
      incomeTotal: this.totalIncome,
      returnTotal: this.totalExpenditure,
      time: new Date().toISOString()
    };
  }

  public async getAvailableTaxRates(): Promise<FpoAvailableTaxRatesResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/cash-register/available-tax-rates', timestamp: new Date().toISOString() });
    return {
      vatRates: ['VAT_0', 'VAT_12', 'NO_VAT'],
      salesTaxRates: ['ST_0', 'ST_1', 'ST_2', 'ST_3', 'ST_5', 'NO_ST']
    };
  }
}
