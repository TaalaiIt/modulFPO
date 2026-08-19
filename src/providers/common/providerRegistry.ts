import { IProviderAdapter } from './IProviderAdapter';

export class ProviderRegistry {
  private adapters: Map<string, IProviderAdapter> = new Map();

  public register(adapter: IProviderAdapter): void {
    const code = adapter.providerCode.toUpperCase();
    if (this.adapters.has(code)) {
      throw new Error(`Provider adapter for code '${code}' is already registered.`);
    }
    this.adapters.set(code, adapter);
  }

  public get(providerCode: string): IProviderAdapter | undefined {
    return this.adapters.get(providerCode.toUpperCase());
  }

  public getOrThrow(providerCode: string): IProviderAdapter {
    const adapter = this.get(providerCode);
    if (!adapter) {
      throw new Error(`Unsupported provider code: '${providerCode}'. Available: [${this.getRegisteredCodes().join(', ')}]`);
    }
    return adapter;
  }

  public getRegisteredCodes(): string[] {
    return Array.from(this.adapters.keys());
  }

  public clear(): void {
    this.adapters.clear();
  }
}
