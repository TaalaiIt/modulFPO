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
  FpoReceiptPositionDto,
  FpoDepositRequest,
  FpoWithdrawRequest,
  FpoCashTransactionResponse,
  FpoCashTransactionResult,
  FpoCloseShiftResponse,
  FpoXReportResponse,
  FpoAvailableTaxRatesResponse,
  FpoError
} from '../models/fpoTypes';

export interface IFiscalConnectorClient {
  getSamCards(): Promise<FpoSamCardsResponse>;
  verifyPin(req: FpoVerifyPinRequest): Promise<FpoVerifyPinResponse>;
  auth(req: FpoAuthRequest): Promise<FpoAuthResponse>;
  getStateShift(): Promise<FpoStateShiftResponse>;
  openShift(req?: FpoOpenShiftRequest): Promise<FpoOpenShiftResponse>;
  createReceipt(req: FpoReceiptRequest): Promise<FpoReceiptResponse>;
  deposit(req: FpoDepositRequest): Promise<FpoCashTransactionResult>;
  withdraw(req: FpoWithdrawRequest): Promise<FpoCashTransactionResult>;
  getCashTransaction(): Promise<FpoCashTransactionResponse>;
  closeShift(): Promise<FpoCloseShiftResponse>;
  getXReport(): Promise<FpoXReportResponse>;
  getAvailableTaxRates(): Promise<FpoAvailableTaxRatesResponse>;
}

export class HttpFiscalConnectorClient implements IFiscalConnectorClient {
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;
  private registrationNumber?: string;
  private responseType: 'json' | 'pdf' = 'json';
  private receiptWidthMm: 56 | 80 = 80;

  constructor(baseUrl = 'http://localhost:8080', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  public setToken(token: string): void {
    this.token = token;
  }

  public configure(options: { registrationNumber?: string; receiptWidthMm?: 56 | 80; responseType?: 'json' | 'pdf' }): void {
    if (options.registrationNumber) this.registrationNumber = options.registrationNumber;
    if (options.receiptWidthMm) this.receiptWidthMm = options.receiptWidthMm;
    if (options.responseType) this.responseType = options.responseType;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      overrideRnm?: string;
    } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Response-Type': this.responseType,
      'WIDTH-RECEIPT': String(this.receiptWidthMm),
      ...(options.headers || {})
    };

    if (this.token) {
      headers['Authorization'] = this.token;
    }

    const rnm = options.overrideRnm || this.registrationNumber;
    if (rnm) {
      headers['Registration-Number'] = rnm;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || (options.body ? 'POST' : 'GET'),
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const code = (data as { code?: number }).code || response.status;
        const msg = (data as { message?: string }).message || `FPO error ${response.status}: ${response.statusText}`;
        const errName = (data as { errorCodeName?: string }).errorCodeName || 'FPO_HTTP_ERROR';
        throw new FpoError(code, msg, errName, data as Record<string, unknown>);
      }

      return data as T;
    } catch (err: unknown) {
      if (err instanceof FpoError) throw err;
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
        throw new FpoError(40800, `FiscalConnector request timeout (${this.timeoutMs}ms) for ${endpoint}`, 'TIMEOUT_ERROR');
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new FpoError(503, `Cannot connect to FiscalConnector at ${this.baseUrl}: ${message}`, 'CONNECTION_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  async getSamCards(): Promise<FpoSamCardsResponse> {
    return this.request<FpoSamCardsResponse>('/driver/sam-cards', { method: 'GET' });
  }

  async verifyPin(req: FpoVerifyPinRequest): Promise<FpoVerifyPinResponse> {
    const rnm = req.registrationNumber || req.rnm || this.registrationNumber || '';
    const body = {
      registrationNumber: rnm,
      pin: req.pin
    };
    return this.request<FpoVerifyPinResponse>('/driver/verify-pin', {
      method: 'POST',
      body,
      overrideRnm: rnm
    });
  }

  async auth(req: FpoAuthRequest): Promise<FpoAuthResponse> {
    const rnm = req.registrationNumber || req.rnm || this.registrationNumber;
    const body: Record<string, unknown> = {
      login: req.login || '',
      password: req.password || ''
    };

    const res = await this.request<FpoAuthResponse>('/driver/auth', {
      method: 'POST',
      body,
      overrideRnm: rnm
    });

    if (res.accessToken) {
      this.setToken(res.accessToken);
    }
    return res;
  }

  async getStateShift(): Promise<FpoStateShiftResponse> {
    return this.request<FpoStateShiftResponse>('/driver/state-shift', { method: 'GET' });
  }

  async openShift(req?: FpoOpenShiftRequest): Promise<FpoOpenShiftResponse> {
    return this.request<FpoOpenShiftResponse>('/driver/open-shift', {
      method: 'POST',
      body: req || {}
    });
  }

  async createReceipt(req: FpoReceiptRequest): Promise<FpoReceiptResponse> {
    const rawPositions = req.positions || req.items || [];
    const positions: FpoReceiptPositionDto[] = rawPositions.map((p) => {
      // Map vat/st from string or number if needed
      let vat = p.vat;
      if (vat === undefined && p.vatRate) {
        vat = p.vatRate === 'VAT_12' ? 1 : 0;
      }
      let st = p.st;
      if (st === undefined && p.salesTaxRate) {
        const match = p.salesTaxRate.match(/\d+/);
        if (match) {
          const salesTaxValue = parseInt(match[0], 10);
          st = salesTaxValue === 5 ? 4 : salesTaxValue;
        } else {
          st = 0;
        }
      }

      return {
        calcItemAttributeCode: p.calcItemAttributeCode ?? 0,
        sgtin: p.sgtin,
        name: p.name,
        price: Number(p.price.toFixed(2)),
        quantity: Number(p.quantity.toFixed(4)),
        cost: Number(p.cost.toFixed(2)),
        measure: p.measure || 'PIECE',
        vat: (vat ?? 0),
        st: (st ?? 0)
      };
    });

    const cashSum = req.totalCashSum ?? 0;
    const cashlessSum = req.totalCashlessSum ?? 0;
    const totalSum = Number((req.totalSum ?? (cashSum + cashlessSum)).toFixed(2));
    const paySum = Number((req.paySum ?? (cashSum + cashlessSum)).toFixed(2));
    const deliverySum = Number((req.deliverySum ?? 0).toFixed(2));
    const totalCashSum = Number(cashSum.toFixed(2));
    const totalCashlessSum = Number(cashlessSum.toFixed(2));

    const payload: Record<string, unknown> = {
      positions,
      operationType: req.operationType,
      paySum,
      deliverySum,
      totalSum,
      totalCashSum,
      totalCashlessSum
    };

    if (req.originFdNumber !== undefined) {
      payload.originFdNumber = req.originFdNumber;
    }
    if (req.originFnSerialNumber !== undefined) {
      payload.originFnSerialNumber = req.originFnSerialNumber;
    }

    return this.request<FpoReceiptResponse>('/driver/cash-register/receipt', {
      method: 'POST',
      body: payload
    });
  }

  async deposit(req: FpoDepositRequest): Promise<FpoCashTransactionResult> {
    const amount = Number((req.amount ?? req.sum ?? 0).toFixed(2));
    return this.request<FpoCashTransactionResult>('/driver/cash-transaction/deposit', {
      method: 'POST',
      body: { amount }
    });
  }

  async withdraw(req: FpoWithdrawRequest): Promise<FpoCashTransactionResult> {
    const amount = Number((req.amount ?? req.sum ?? 0).toFixed(2));
    return this.request<FpoCashTransactionResult>('/driver/cash-transaction/withdraw', {
      method: 'POST',
      body: { amount }
    });
  }

  async getCashTransaction(): Promise<FpoCashTransactionResponse> {
    return this.request<FpoCashTransactionResponse>('/driver/cash-transaction', { method: 'GET' });
  }

  async closeShift(): Promise<FpoCloseShiftResponse> {
    return this.request<FpoCloseShiftResponse>('/driver/close-shift', {
      method: 'POST',
      body: {}
    });
  }

  async getXReport(): Promise<FpoXReportResponse> {
    return this.request<FpoXReportResponse>('/driver/x-report', { method: 'GET' });
  }

  async getAvailableTaxRates(): Promise<FpoAvailableTaxRatesResponse> {
    return this.request<FpoAvailableTaxRatesResponse>('/driver/cash-register/available-tax-rates', { method: 'GET' });
  }
}
