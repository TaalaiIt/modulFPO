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

  constructor(baseUrl = 'http://localhost:8080', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  public setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || (options.body ? 'POST' : 'GET'),
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
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
    return this.request<FpoVerifyPinResponse>('/driver/verify-pin', { body: req });
  }

  async auth(req: FpoAuthRequest): Promise<FpoAuthResponse> {
    const res = await this.request<FpoAuthResponse>('/driver/auth', { body: req });
    if (res.accessToken) {
      this.setToken(res.accessToken);
    }
    return res;
  }

  async getStateShift(): Promise<FpoStateShiftResponse> {
    return this.request<FpoStateShiftResponse>('/driver/state-shift', { method: 'GET' });
  }

  async openShift(req?: FpoOpenShiftRequest): Promise<FpoOpenShiftResponse> {
    return this.request<FpoOpenShiftResponse>('/driver/open-shift', { body: req || {} });
  }

  async createReceipt(req: FpoReceiptRequest): Promise<FpoReceiptResponse> {
    return this.request<FpoReceiptResponse>('/driver/cash-register/receipt', { body: req });
  }

  async deposit(req: FpoDepositRequest): Promise<FpoCashTransactionResult> {
    return this.request<FpoCashTransactionResult>('/driver/cash-transaction/deposit', { body: req });
  }

  async withdraw(req: FpoWithdrawRequest): Promise<FpoCashTransactionResult> {
    return this.request<FpoCashTransactionResult>('/driver/cash-transaction/withdraw', { body: req });
  }

  async getCashTransaction(): Promise<FpoCashTransactionResponse> {
    return this.request<FpoCashTransactionResponse>('/driver/cash-transaction', { method: 'GET' });
  }

  async closeShift(): Promise<FpoCloseShiftResponse> {
    return this.request<FpoCloseShiftResponse>('/driver/close-shift', { body: {} });
  }

  async getXReport(): Promise<FpoXReportResponse> {
    return this.request<FpoXReportResponse>('/driver/x-report', { method: 'GET' });
  }

  async getAvailableTaxRates(): Promise<FpoAvailableTaxRatesResponse> {
    return this.request<FpoAvailableTaxRatesResponse>('/driver/cash-register/available-tax-rates', { method: 'GET' });
  }
}
