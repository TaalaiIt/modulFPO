/**
 * Driver FPO API JSON v1.3.0 Models & DTOs
 * Государственная налоговая служба Кыргызской Республики (ГНС)
 * FiscalConnector / Драйвер ФПО
 */

export type FpoOperationType = 'INCOME' | 'INCOME_RETURN' | 'EXPENDITURE' | 'EXPENDITURE_RETURN';

export type FpoReceiptOperationType = FpoOperationType; // Backward compat alias

export type FpoMeasure =
  | 'PIECE'
  | 'GRAM'
  | 'KG'
  | 'TON'
  | 'MILLIMETER'
  | 'CENTIMETER'
  | 'DECIMETER'
  | 'METER'
  | 'SQUARE_CENTIMETER'
  | 'SQUARE_DECIMETER'
  | 'SQUARE_METER'
  | 'LITER'
  | 'MILLILITER'
  | 'CUBE_METER'
  | 'KWH'
  | 'GCAL'
  | 'DAY'
  | 'HOUR'
  | 'MINUTE'
  | 'SECOND'
  | 'KILOBYTE'
  | 'MEGABYTE'
  | 'GIGABYTE'
  | 'TERABYTE'
  | 'LINE_METER'
  | 'PACK'
  | 'UNDEFINED'
  | 'SERVICE';

export type FpoVatCode = 0 | 1; // 0 = 0%, 1 = 12%
export type FpoStCode = 0 | 1 | 2 | 3 | 4 | 5; // 0 = 0%, 1 = 1%, 2 = 2%, 3 = 3%, 4 = 4%, 5 = 5%

// 1. SAM Cards: GET /driver/sam-cards
export interface FpoSamCard {
  slot?: number;
  cardPresent?: boolean;
  cardId?: string;
  atr?: string;
  [key: string]: unknown;
}

export interface FpoSamCardsResponse {
  samCards: FpoSamCard[];
  [key: string]: unknown;
}

// 2. Verify PIN: POST /driver/verify-pin
export interface FpoVerifyPinRequest {
  registrationNumber?: string;
  rnm?: string;
  pin: string;
}

export interface FpoVerifyPinResponse {
  registrationNumber?: string;
  fiscalModuleNumber?: string;
  fmExpirationDate?: string;
  queueSize?: number;
  // Compat helpers
  success?: boolean;
  message?: string;
}

// 3. Auth: POST /driver/auth
export interface FpoAuthRequest {
  login?: string;
  password?: string;
  registrationNumber?: string;
  rnm?: string;
}

export interface FpoAuthResponse {
  accessToken: string;
  refreshToken?: string;
  fullName?: string;
  cashierName?: string;
  tin?: string;
  registrationNumber?: string;
  fiscalMemoryNumber?: string;
  taxSystemCodes?: number[];
  calcItemAttrCodes?: number[];
  locationOriginalAddress?: string;
  entrepreneurshipObjectCode?: number;
  businessActivityCode?: number;
  taxAuthorityDepartmentCode?: number;
  expiresIn?: number;
  success?: boolean;
}

// 4. State Shift: GET /driver/state-shift
export type FpoShiftStatus = 'CLOSED' | 'OPEN' | 'EXPIRED';

export interface FpoStateShiftResponse {
  shiftOpened: boolean;
  openShiftDateTime?: string;
  fmExpirationDate?: string;
  queueSize?: number;
  // Backward compat helpers
  shiftStatus?: FpoShiftStatus;
  shiftNumber?: number;
  openTime?: string;
  expiredTime?: string;
}

// 5. Cashier DTO
export interface FpoCashierDto {
  name: string;
  inn?: string;
}

// 6. Open Shift: POST /driver/open-shift
export interface FpoOpenShiftRequest {
  cashier?: FpoCashierDto;
  [key: string]: unknown;
}

export interface FpoOpenShiftResponse {
  receiptType?: 'OPEN_SHIFT' | string;
  receiptName?: string;
  date?: string;
  cashier?: string;
  customerTin?: string;
  locationOriginalAddress?: string;
  shiftNumber: number;
  cashRegisterVersion?: string;
  registrationNumber?: string;
  fmNumber?: string;
  fdNumber?: number;
  fiscalMark?: string;
  // Backward-compat aliases
  success?: boolean;
  fiscalDocNumber?: number;
  fiscalDocSign?: string;
  fnNumber?: string;
  kktRegNumber?: string;
  time?: string;
}

// 7. Receipt Position DTO
export interface FpoReceiptPositionDto {
  calcItemAttributeCode?: number; // 0, 1, 4, 7...
  sgtin?: string;                 // Marking DataMatrix / SGTIN
  name: string;
  price: number;                  // 2 decimals
  quantity: number;               // 4 decimals
  cost: number;                   // price * quantity, 2 decimals
  measure?: FpoMeasure | string;  // PIECE, KG, etc.
  vat?: number;                   // 0 or 1
  st?: number;                    // 0..5
  // Compatibility aliases
  vatRate?: string;
  salesTaxRate?: string;
}

export type FpoReceiptItemDto = FpoReceiptPositionDto; // Alias

// 8. Send Receipt: POST /driver/cash-register/receipt
export interface FpoReceiptRequest {
  positions?: FpoReceiptPositionDto[];
  operationType: FpoOperationType;
  paySum?: number;
  deliverySum?: number;
  totalSum?: number;
  totalCashSum?: number;
  totalCashlessSum?: number;
  originFdNumber?: number;
  originFnSerialNumber?: string;
  // Compatibility aliases
  cashier?: FpoCashierDto;
  items?: FpoReceiptPositionDto[];
  originDate?: string;
}

export interface FpoReceiptResponse {
  receiptType?: string;
  receiptName?: string;
  date?: string;
  cashier?: string;
  customerTin?: string;
  locationOriginalAddress?: string;
  shiftNumber?: number;
  positions?: FpoReceiptPositionDto[];
  totalSum?: number;
  totalCashSum?: number;
  totalCashlessSum?: number;
  cashRegisterVersion?: string;
  registrationNumber?: string;
  fmNumber?: string;
  fdNumber?: number;
  fiscalMark?: string;
  qrCodeUrl?: string;
  // Backward-compat aliases
  success?: boolean;
  fiscalDocNumber?: number;
  fiscalDocSign?: string;
  fnNumber?: string;
  kktRegNumber?: string;
  time?: string;
}

// 9. Deposit & Withdraw: POST /driver/cash-transaction/deposit, withdraw
export interface FpoDepositRequest {
  amount?: number;
  sum?: number; // compat
  cashier?: FpoCashierDto;
}

export interface FpoWithdrawRequest {
  amount?: number;
  sum?: number; // compat
  cashier?: FpoCashierDto;
}

export interface FpoCashTransactionResult {
  receiptType?: 'DEPOSIT' | 'WITHDRAW' | string;
  receiptName?: string;
  date?: string;
  cashier?: string;
  customerTin?: string;
  locationOriginalAddress?: string;
  shiftNumber?: number;
  taxSystemName?: string;
  amount?: number;
  cashRegisterVersion?: string;
  registrationNumber?: string;
  fmNumber?: string;
  // Backward-compat aliases
  success?: boolean;
  fiscalDocNumber?: number;
  fiscalDocSign?: string;
  time?: string;
  newBalance?: number;
}

// 10. GET /driver/cash-transaction
export interface FpoCashTransactionResponse {
  totalAmount: number;
  withdrawTotal: number;
  withdrawCount: number;
  depositTotal: number;
  depositCount: number;
  // Compat aliases
  cashSum?: number;
  totalIncomeSum?: number;
  totalExpenditureSum?: number;
}

// 11. Shift Report Transaction Detail
export interface FpoShiftReportTransaction {
  operationType: FpoOperationType;
  ticketsAmount: number;
  cashSum: number;
  cashlessSum: number;
  totalSum: number;
  vatSummary?: Record<string, number>;
  stSummary?: Record<string, number>;
}

// 12. Close Shift: POST /driver/close-shift
export interface FpoCloseShiftResponse {
  receiptType?: 'CLOSE_SHIFT' | string;
  receiptName?: string;
  date?: string;
  cashier?: string;
  customerTin?: string;
  locationOriginalAddress?: string;
  shiftNumber: number;
  taxSystemName?: string;
  shiftReportTransactions?: FpoShiftReportTransaction[];
  totalCashSum?: number;
  totalCashlessSum?: number;
  totalSum?: number;
  depositTotal?: number;
  withdrawalTotal?: number;
  cashTotal?: number;
  cashRegisterVersion?: string;
  registrationNumber?: string;
  fmNumber?: string;
  fdNumber?: number;
  fiscalMark?: string;
  // Backward-compat aliases
  success?: boolean;
  fiscalDocNumber?: number;
  fiscalDocSign?: string;
  fnNumber?: string;
  kktRegNumber?: string;
  time?: string;
  chequesTotal?: number;
  fiscalDocsTotal?: number;
}

// 13. X-Report: GET /driver/x-report
export interface FpoXReportResponse {
  receiptType?: 'X_REPORT' | string;
  receiptName?: string;
  date?: string;
  cashier?: string;
  customerTin?: string;
  locationOriginalAddress?: string;
  shiftNumber: number;
  taxSystemName?: string;
  shiftReportTransactions?: FpoShiftReportTransaction[];
  totalCashSum?: number;
  totalCashlessSum?: number;
  totalSum?: number;
  depositTotal?: number;
  withdrawalTotal?: number;
  cashTotal?: number;
  cashRegisterVersion?: string;
  registrationNumber?: string;
  fmNumber?: string;
  fdNumber?: number | null;
  fiscalMark?: string | null;
  // Backward-compat aliases
  success?: boolean;
  cashSum?: number;
  incomeTotal?: number;
  returnTotal?: number;
  time?: string;
}

// 14. Available Tax Rates: GET /driver/cash-register/available-tax-rates
export interface FpoTaxRateItem {
  vatRate: string;
  stRate: string;
  calculationItemAttributeCode: number;
}

export type FpoAvailableTaxRatesResponse = FpoTaxRateItem[] | {
  vatRates?: string[];
  salesTaxRates?: string[];
};

// 15. Standardized Error
export class FpoError extends Error {
  public code: number;
  public errorCodeName: string;
  public details?: Record<string, unknown>;

  constructor(code: number, message: string, errorCodeName = 'FPO_ERROR', details?: Record<string, unknown>) {
    super(message);
    this.name = 'FpoError';
    this.code = code;
    this.errorCodeName = errorCodeName;
    this.details = details;
  }
}
