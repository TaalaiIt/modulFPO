export interface MoySkladJsonApiClientOptions {
  accessToken: string;
  baseUrl?: string;
  region?: 'ru' | 'uz' | 'kz';
  fetchImpl?: typeof fetch;
}

export class MoySkladJsonApiClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly region?: 'ru' | 'uz' | 'kz';
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoySkladJsonApiClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl || 'https://api.moysklad.ru/api/remap/1.2').replace(/\/$/, '');
    this.region = options.region;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  public async get<T>(pathOrHref: string): Promise<T> {
    const url = pathOrHref.startsWith('http')
      ? pathOrHref
      : `${this.baseUrl}/${pathOrHref.replace(/^\//, '')}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json'
    };
    if (this.region) headers['X-Lognex-Accept-Region'] = this.region;

    const response = await this.fetchImpl(url, { method: 'GET', headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body as { errors?: Array<{ error_message?: string; error?: string; code?: number }> };
      const firstError = error.errors?.[0];
      throw new Error(
        firstError?.error_message || firstError?.error || `MoySklad JSON API request failed with HTTP ${response.status}`
      );
    }
    return body as T;
  }

  public getByHref<T>(href: string): Promise<T> {
    return this.get<T>(href);
  }

  public getContext<T = unknown>(): Promise<T> {
    return this.get<T>('/context/employee');
  }

  public getRetailStore<T = unknown>(storeId: string): Promise<T> {
    return this.get<T>(`/entity/retailstore/${encodeURIComponent(storeId)}`);
  }

  public getRetailDemand<T = unknown>(demandId: string): Promise<T> {
    return this.get<T>(`/entity/retaildemand/${encodeURIComponent(demandId)}?expand=positions`);
  }

  public getProductMetadata<T = unknown>(): Promise<T> {
    return this.get<T>('/entity/product/metadata');
  }

  public getProductAttributes<T = unknown>(): Promise<T> {
    return this.get<T>('/entity/product/metadata/attributes');
  }

  public getAdditionalFields<T = unknown>(entityType: string): Promise<T> {
    return this.get<T>(`/entity/${encodeURIComponent(entityType)}/metadata/attributes`);
  }
}
