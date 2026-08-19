import {
  NormalizedFiscalOperation,
  FiscalResult,
  ReceiptData
} from '../../core/operations/types';

export interface VendorLifecycleEvent {
  action: 'INSTALL' | 'ACTIVATE' | 'SUSPEND' | 'RESUME' | 'DELETE' | 'SETTINGS_UPDATE';
  appId: string;
  accountId: string;
  payload: Record<string, unknown>;
}

export interface VendorLifecycleResult {
  status: 'Activated' | 'SettingsRequired' | 'Suspended' | 'Deleted' | 'Error';
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface IProviderAdapter {
  readonly providerCode: string;

  /**
   * Translates incoming external webhook / REST payload into NormalizedFiscalOperation
   */
  mapToNormalized(rawRequest: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    query?: Record<string, string | string[] | undefined>;
    url?: string;
    method?: string;
  }): Promise<NormalizedFiscalOperation>;

  /**
   * Translates Core FiscalResult into external provider-specific response format
   */
  mapToProviderResponse(result: FiscalResult): Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body: unknown;
  }>;

  /**
   * Generates receipt payload (e.g. PDF/ZIP/Base64 for MoySklad or raw text/JSON)
   */
  generateReceiptData(
    operation: NormalizedFiscalOperation,
    fiscalResult: Partial<FiscalResult>,
    options?: { paperWidthMm?: number }
  ): Promise<ReceiptData>;

  /**
   * Handles vendor lifecycle events (install, uninstall, etc.) if supported
   */
  handleVendorLifecycle?(event: VendorLifecycleEvent): Promise<VendorLifecycleResult>;

  /**
   * Validates signature / authorization headers
   */
  verifyRequest?(request: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    rawBody?: string | Buffer;
  }): Promise<{ valid: boolean; accountId?: string; error?: string }>;
}
