export enum OperationType {
  OPEN_SHIFT = 'OPEN_SHIFT',
  SALE = 'SALE',
  RETURN = 'RETURN',
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
  CLOSE_SHIFT = 'CLOSE_SHIFT',
  X_REPORT = 'X_REPORT'
}

export enum OperationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  UNKNOWN = 'UNKNOWN',
  FAILED = 'FAILED'
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  QR = 'QR',
  PREPAYMENT = 'PREPAYMENT',
  CREDIT = 'CREDIT'
}

export enum VatRate {
  VAT_0 = 'VAT_0',
  VAT_12 = 'VAT_12',
  NO_VAT = 'NO_VAT'
}

export enum SalesTaxRate {
  ST_0 = 'ST_0',
  ST_1 = 'ST_1',
  ST_2 = 'ST_2',
  ST_3 = 'ST_3',
  ST_5 = 'ST_5',
  NO_ST = 'NO_ST'
}

export interface ItemTax {
  vatRate?: VatRate;
  vatSum?: number;
  salesTaxRate?: SalesTaxRate;
  salesTaxSum?: number;
}

export interface FiscalItem {
  id?: string;
  name: string;
  price: number; // in KGS or currency units (e.g., 100.50)
  quantity: number;
  totalSum: number;
  tax?: ItemTax;
  calcItemAttributeCode?: number; // 1 = commodity, etc.
  measureUnit?: string;
  sgtin?: string; // Marking code
  gtin?: string;
}

export interface PaymentDetail {
  method: PaymentMethod;
  sum: number;
  details?: Record<string, unknown>;
}

export interface CashierInfo {
  name?: string;
  inn?: string;
  role?: string;
}

export interface OriginFiscalDocInfo {
  originFdNumber: number;
  originFnSerialNumber: string;
  originDate?: string;
}

export interface NormalizedFiscalOperation {
  operationId: string;
  providerCode: string;
  providerAccountId: string;
  externalOperationId: string;
  operationType: OperationType;
  storeId: string;
  agentId?: string;
  cashier?: CashierInfo;
  items?: FiscalItem[];
  payments?: PaymentDetail[];
  totalSum?: number;
  totalCashSum?: number;
  totalCashlessSum?: number;
  originFiscalDoc?: OriginFiscalDocInfo;
  payloadHash?: string;
  rawExternalPayload?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CoreError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  isRetryable: boolean;
  httpStatusCode?: number;
}

export interface ReceiptData {
  format: 'PDF_ZIP_BASE64' | 'RAW_TEXT' | 'JSON';
  data: string; // Base64 or plain string
  previewUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FiscalResult {
  success: boolean;
  operationId: string;
  providerCode: string;
  providerAccountId: string;
  externalOperationId: string;
  operationType: OperationType;
  status: OperationStatus;
  fiscalDocNumber?: number; // ФД
  fiscalDocSign?: string;   // ФПД
  fnNumber?: string;         // Заводской / серийный номер ФН
  kktRegNumber?: string;     // РНМ ККМ
  fiscalDateTime?: string;   // Время фискализации
  shiftNumber?: number;      // Номер смены
  chequesTotal?: number;     // Всего чеков за смену (для close-shift)
  fiscalDocsTotal?: number;  // Всего ФД за смену (для close-shift)
  qrCodeUrl?: string;        // Ссылка на чек в ГНС КР
  receipt?: ReceiptData;
  error?: CoreError;
  completedAt: string;
}
