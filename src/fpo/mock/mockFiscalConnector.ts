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
  FpoShiftReportTransaction,
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
  private totalIncomeCash = 0;
  private totalIncomeCashless = 0;
  private totalExpenditure = 0;
  private totalExpenditureCash = 0;
  private totalExpenditureCashless = 0;
  private depositTotal = 0;
  private depositCount = 0;
  private withdrawTotal = 0;
  private withdrawCount = 0;
  private currentCash = 0;
  private shiftOpenTime?: string;

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
      rnm: initialConfig?.rnm ?? '0000000000022441',
      fnNumber: initialConfig?.fnNumber ?? '0000000000021120',
      correctPin: initialConfig?.correctPin ?? '95204',
      simulate40417Once: initialConfig?.simulate40417Once ?? false,
      simulate4011Once: initialConfig?.simulate4011Once ?? false,
      simulateAuthNetworkFailure: initialConfig?.simulateAuthNetworkFailure ?? false,
      simulateTimeoutOnReceipt: initialConfig?.simulateTimeoutOnReceipt ?? false,
      simulateFpoOffline: initialConfig?.simulateFpoOffline ?? false
    };
    this.currentCash = this.config.initialCash;
    if (this.config.shiftStatus === 'OPEN') {
      this.shiftOpenTime = new Date(Date.now() - 3600000).toISOString();
    }
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
    if (req.pin !== this.config.correctPin && req.pin !== '1234') {
      throw new FpoError(40402, 'Invalid SAM PIN', 'INVALID_PIN');
    }

    this.config.pinVerified = true;
    return {
      registrationNumber: req.registrationNumber || req.rnm || this.config.rnm,
      fiscalModuleNumber: this.config.fnNumber,
      fmExpirationDate: '2028-12-12T19:00:00.000+00:00',
      queueSize: 0,
      success: true,
      message: 'PIN successfully verified'
    };
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
    const rnm = req.registrationNumber || req.rnm || this.config.rnm;

    return {
      accessToken: `fpo_access_token_${Math.random().toString(36).substring(2, 10)}`,
      refreshToken: `fpo_refresh_token_${Math.random().toString(36).substring(2, 10)}`,
      fullName: 'Нагрузочный Тестовый Пользователь',
      cashierName: 'Нагрузочный Тестовый Пользователь',
      tin: '11111111111111',
      registrationNumber: rnm,
      fiscalMemoryNumber: this.config.fnNumber,
      taxSystemCodes: [3],
      calcItemAttrCodes: [1, 4, 7],
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      entrepreneurshipObjectCode: 63,
      businessActivityCode: 14,
      taxAuthorityDepartmentCode: 2,
      expiresIn: 300,
      success: true
    };
  }

  public async getStateShift(): Promise<FpoStateShiftResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/state-shift', timestamp: new Date().toISOString() });
    const isOpened = this.config.shiftStatus === 'OPEN';
    return {
      shiftOpened: isOpened,
      openShiftDateTime: isOpened ? (this.shiftOpenTime || new Date().toISOString()) : undefined,
      fmExpirationDate: '2028-12-12T19:00:00.000+00:00',
      queueSize: 0,
      shiftStatus: this.config.shiftStatus,
      shiftNumber: this.config.shiftNumber,
      openTime: isOpened ? (this.shiftOpenTime || new Date().toISOString()) : undefined
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
    this.shiftOpenTime = new Date().toISOString();

    const fdNumber = this.fdCounter;
    const fiscalMark = `${Math.floor(100000000000000 + Math.random() * 900000000000000)}`;
    const fiscalDocSign = `FPD-${fdNumber}-${fiscalMark.substring(0, 8)}`;
    const now = new Date().toISOString();

    return {
      receiptType: 'OPEN_SHIFT',
      receiptName: 'Открытие смены',
      date: now,
      cashier: req?.cashier?.name || 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      fdNumber,
      fiscalMark,
      // Backward compat aliases
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: now
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

    const cashSum = req.totalCashSum || 0;
    const cashlessSum = req.totalCashlessSum || 0;
    const totalSum = req.totalSum || (cashSum + cashlessSum);

    if (req.operationType === 'INCOME') {
      this.currentCash += cashSum;
      this.totalIncome += totalSum;
      this.totalIncomeCash += cashSum;
      this.totalIncomeCashless += cashlessSum;
    } else if (req.operationType === 'INCOME_RETURN') {
      this.currentCash -= cashSum;
      this.totalExpenditure += totalSum;
      this.totalExpenditureCash += cashSum;
      this.totalExpenditureCashless += cashlessSum;
    } else if (req.operationType === 'EXPENDITURE') {
      this.currentCash -= cashSum;
      this.totalExpenditure += totalSum;
      this.totalExpenditureCash += cashSum;
      this.totalExpenditureCashless += cashlessSum;
    } else if (req.operationType === 'EXPENDITURE_RETURN') {
      this.currentCash += cashSum;
      this.totalIncome += totalSum;
      this.totalIncomeCash += cashSum;
      this.totalIncomeCashless += cashlessSum;
    }

    this.chequesInShift += 1;
    this.docsInShift += 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const fiscalMark = `${Math.floor(100000000000000 + Math.random() * 900000000000000)}`;
    const fiscalDocSign = `FPD-${fdNumber}-${fiscalMark.substring(0, 8)}`;
    const now = new Date().toISOString();

    const receiptTypeMap: Record<string, string> = {
      INCOME: 'RECEIPT_INCOME',
      INCOME_RETURN: 'RECEIPT_INCOME_RETURN',
      EXPENDITURE: 'RECEIPT_EXPENDITURE',
      EXPENDITURE_RETURN: 'RECEIPT_EXPENDITURE_RETURN'
    };

    return {
      receiptType: receiptTypeMap[req.operationType] || 'RECEIPT_INCOME',
      receiptName: req.operationType === 'INCOME' ? 'Кассовый чек (Приход)' : 'Кассовый чек (Возврат прихода)',
      date: now,
      cashier: req.cashier?.name || 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      positions: req.positions || req.items || [],
      totalSum,
      totalCashSum: cashSum,
      totalCashlessSum: cashlessSum,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      fdNumber,
      fiscalMark,
      qrCodeUrl: `https://tax.gov.kg/check?kkt=${this.config.rnm}&fn=${this.config.fnNumber}&fd=${fdNumber}&fpd=${fiscalMark}`,
      // Backward compat aliases
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: now
    };
  }

  public async deposit(req: FpoDepositRequest): Promise<FpoCashTransactionResult> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/cash-transaction/deposit', body: req, timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    const amount = req.amount ?? req.sum ?? 0;
    this.currentCash += amount;
    this.depositTotal += amount;
    this.depositCount += 1;
    this.docsInShift += 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const now = new Date().toISOString();

    return {
      receiptType: 'DEPOSIT',
      receiptName: 'Внесение наличных',
      date: now,
      cashier: req.cashier?.name || 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      taxSystemName: 'Упрощенная система налогообложения на основе единого налога',
      amount,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      // Backward compat aliases
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign: `FPD-DEP-${fdNumber}`,
      time: now,
      newBalance: this.currentCash
    };
  }

  public async withdraw(req: FpoWithdrawRequest): Promise<FpoCashTransactionResult> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/cash-transaction/withdraw', body: req, timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    const amount = req.amount ?? req.sum ?? 0;
    if (this.currentCash < amount) {
      throw new FpoError(40918, `Insufficient cash in drawer: requested ${amount}, available ${this.currentCash}`, 'INSUFFICIENT_CASH');
    }

    this.currentCash -= amount;
    this.withdrawTotal += amount;
    this.withdrawCount += 1;
    this.docsInShift += 1;
    this.fdCounter += 1;

    const fdNumber = this.fdCounter;
    const now = new Date().toISOString();

    return {
      receiptType: 'WITHDRAW',
      receiptName: 'Изъятие наличных',
      date: now,
      cashier: req.cashier?.name || 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      taxSystemName: 'Упрощенная система налогообложения на основе единого налога',
      amount,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      // Backward compat aliases
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign: `FPD-WITH-${fdNumber}`,
      time: now,
      newBalance: this.currentCash
    };
  }

  public async getCashTransaction(): Promise<FpoCashTransactionResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/cash-transaction', timestamp: new Date().toISOString() });
    return {
      totalAmount: this.currentCash,
      withdrawTotal: this.withdrawTotal,
      withdrawCount: this.withdrawCount,
      depositTotal: this.depositTotal,
      depositCount: this.depositCount,
      // Backward compat aliases
      cashSum: this.currentCash,
      totalIncomeSum: this.totalIncome,
      totalExpenditureSum: this.totalExpenditure
    };
  }

  private buildShiftReportTransactions(): FpoShiftReportTransaction[] {
    return [
      {
        operationType: 'INCOME',
        ticketsAmount: this.chequesInShift,
        cashSum: this.totalIncomeCash,
        cashlessSum: this.totalIncomeCashless,
        totalSum: this.totalIncome,
        vatSummary: {},
        stSummary: { ST_2: Number((this.totalIncome * 0.02).toFixed(2)) }
      },
      {
        operationType: 'INCOME_RETURN',
        ticketsAmount: 0,
        cashSum: 0,
        cashlessSum: 0,
        totalSum: 0,
        vatSummary: {},
        stSummary: {}
      },
      {
        operationType: 'EXPENDITURE',
        ticketsAmount: 0,
        cashSum: this.totalExpenditureCash,
        cashlessSum: this.totalExpenditureCashless,
        totalSum: this.totalExpenditure,
        vatSummary: {},
        stSummary: {}
      },
      {
        operationType: 'EXPENDITURE_RETURN',
        ticketsAmount: 0,
        cashSum: 0,
        cashlessSum: 0,
        totalSum: 0,
        vatSummary: {},
        stSummary: {}
      }
    ];
  }

  public async closeShift(): Promise<FpoCloseShiftResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'POST /driver/close-shift', timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

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
    const fiscalMark = `${Math.floor(100000000000000 + Math.random() * 900000000000000)}`;
    const fiscalDocSign = `FPD-Z-${fdNumber}-${this.config.shiftNumber}`;
    const now = new Date().toISOString();

    return {
      receiptType: 'CLOSE_SHIFT',
      receiptName: 'Закрытие смены',
      date: now,
      cashier: 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      taxSystemName: 'Упрощенная система налогообложения на основе единого налога',
      shiftReportTransactions: this.buildShiftReportTransactions(),
      totalCashSum: this.totalIncomeCash,
      totalCashlessSum: this.totalIncomeCashless,
      totalSum: this.totalIncome,
      depositTotal: this.depositTotal,
      withdrawalTotal: this.withdrawTotal,
      cashTotal: this.currentCash,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      fdNumber,
      fiscalMark,
      // Backward compat aliases
      success: true,
      fiscalDocNumber: fdNumber,
      fiscalDocSign,
      fnNumber: this.config.fnNumber,
      kktRegNumber: this.config.rnm,
      time: now,
      chequesTotal: this.chequesInShift,
      fiscalDocsTotal: this.docsInShift
    };
  }

  public async getXReport(): Promise<FpoXReportResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/x-report', timestamp: new Date().toISOString() });

    if (this.config.shiftStatus !== 'OPEN') {
      throw new FpoError(40902, 'Shift is not open', 'SHIFT_NOT_OPEN');
    }

    const now = new Date().toISOString();

    return {
      receiptType: 'X_REPORT',
      receiptName: 'Х-Отчет',
      date: now,
      cashier: 'Нагрузочный Тестовый Пользователь',
      customerTin: '11111111111111',
      locationOriginalAddress: 'test, 720017, город Бишкек, Московская улица, 126a',
      shiftNumber: this.config.shiftNumber,
      taxSystemName: 'Упрощенная система налогообложения на основе единого налога',
      shiftReportTransactions: this.buildShiftReportTransactions(),
      totalCashSum: this.totalIncomeCash,
      totalCashlessSum: this.totalIncomeCashless,
      totalSum: this.totalIncome,
      depositTotal: this.depositTotal,
      withdrawalTotal: this.withdrawTotal,
      cashTotal: this.currentCash,
      cashRegisterVersion: 'FiscalConnector 1.0',
      registrationNumber: this.config.rnm,
      fmNumber: this.config.fnNumber,
      fdNumber: null,
      fiscalMark: null,
      // Backward compat aliases
      success: true,
      shiftNumberCompat: this.config.shiftNumber,
      cashSum: this.currentCash,
      incomeTotal: this.totalIncome,
      returnTotal: this.totalExpenditure,
      time: now
    } as unknown as FpoXReportResponse;
  }

  public async getAvailableTaxRates(): Promise<FpoAvailableTaxRatesResponse> {
    this.checkOffline();
    this.operationLog.push({ endpoint: 'GET /driver/cash-register/available-tax-rates', timestamp: new Date().toISOString() });
    return [
      {
        vatRate: 'VAT_0',
        stRate: 'ST_0',
        calculationItemAttributeCode: 1
      },
      {
        vatRate: 'VAT_0',
        stRate: 'ST_2',
        calculationItemAttributeCode: 1
      },
      {
        vatRate: 'VAT_12',
        stRate: 'ST_2',
        calculationItemAttributeCode: 1
      }
    ];
  }
}
