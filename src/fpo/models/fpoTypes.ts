export interface FpoSamCard {
  slot: number;
  cardPresent: boolean;
  cardId?: string;
  atr?: string;
}

export interface FpoSamCardsResponse {
  samCards: FpoSamCard[];
}

export interface FpoVerifyPinRequest {
  rnm: string;
  pin: string;
}

export interface FpoVerifyPinResponse {
  success: boolean;
  message?: string;
}

export interface FpoAuthRequest {
  login?: string;
  password?: string;
  rnm: string;
}

export interface FpoAuthResponse {
  success: boolean;
  accessToken: string;
  expiresIn: number; // seconds
}

export type FpoShiftStatus = 'CLOSED' | 'OPEN' | 'EXPIRED';

export interface FpoStateShiftResponse {
  shiftStatus: FpoShiftStatus;
  shiftNumber: number;
  openTime?: string;
  expiredTime?: string;
}

export interface FpoCashierDto {
  name: string;
  inn?: string;
}

export interface FpoOpenShiftRequest {
  cashier?: FpoCashierDto;
}

export interface FpoOpenShiftResponse {
  success: boolean;
  shiftNumber: number;
  fiscalDocNumber: number;
  fiscalDocSign: string;
  fnNumber: string;
  kktRegNumber: string;
  time: string;
}

export type FpoReceiptOperationType = 'INCOME' | 'INCOME_RETURN';

export interface FpoReceiptItemDto {
  name: string;
  price: number; // KGS
  quantity: number;
  cost: number;  // total item sum
  vatRate?: string;       // VAT_0, VAT_12, NO_VAT
  salesTaxRate?: string;  // ST_0, ST_1, ST_2, ST_3, ST_5, NO_ST
  calcItemAttributeCode?: number; // 1 = commodity, etc.
  measure?: string;
  sgtin?: string;         // Marking DataMatrix / SGTIN
}

export interface FpoReceiptRequest {
  operationType: FpoReceiptOperationType;
  cashier?: FpoCashierDto;
  items: FpoReceiptItemDto[];
  totalCashSum: number;
  totalCashlessSum: number;
  originFdNumber?: number;
  originFnSerialNumber?: string;
  originDate?: string;
}

export interface FpoReceiptResponse {
  success: boolean;
  fiscalDocNumber: number;
  fiscalDocSign: string;
  fnNumber: string;
  kktRegNumber: string;
  time: string;
  qrCodeUrl?: string;
}

export interface FpoCashTransactionResponse {
  cashSum: number;
  totalIncomeSum: number;
  totalExpenditureSum: number;
}

export interface FpoDepositRequest {
  sum: number;
  cashier?: FpoCashierDto;
}

export interface FpoWithdrawRequest {
  sum: number;
  cashier?: FpoCashierDto;
}

export interface FpoCashTransactionResult {
  success: boolean;
  fiscalDocNumber: number;
  fiscalDocSign: string;
  time: string;
  newBalance: number;
}

export interface FpoCloseShiftResponse {
  success: boolean;
  shiftNumber: number;
  fiscalDocNumber: number;
  fiscalDocSign: string;
  fnNumber: string;
  kktRegNumber: string;
  time: string;
  chequesTotal: number;
  fiscalDocsTotal: number;
}

export interface FpoXReportResponse {
  success: boolean;
  shiftNumber: number;
  cashSum: number;
  incomeTotal: number;
  returnTotal: number;
  time: string;
}

export interface FpoAvailableTaxRatesResponse {
  vatRates: string[];
  salesTaxRates: string[];
}

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
