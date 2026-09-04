export interface StoreBinding {
  providerCode: string;
  providerAccountId: string;
  storeId: string;
  agentId: string;
  rnm: string;
  paperWidthMm: number;
  allowedPaymentTypes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IAgentTransport {
  agentId: string;
  isOnline(): boolean;
  send<TReq, TRes>(type: string, payload: TReq, timeoutMs?: number): Promise<TRes>;
}

export class RoutingService {
  private storeBindings: Map<string, StoreBinding> = new Map();
  private agentTransports: Map<string, IAgentTransport> = new Map();

  private getStoreKey(providerCode: string, providerAccountId: string, storeId: string): string {
    return `${providerCode.toUpperCase()}:${providerAccountId}:${storeId}`;
  }

  public registerStoreBinding(binding: StoreBinding): void {
    const key = this.getStoreKey(binding.providerCode, binding.providerAccountId, binding.storeId);
    this.storeBindings.set(key, { ...binding, updatedAt: new Date().toISOString() });
  }

  public getStoreBinding(
    providerCode: string,
    providerAccountId: string,
    storeId: string
  ): StoreBinding | undefined {
    const key = this.getStoreKey(providerCode, providerAccountId, storeId);
    return this.storeBindings.get(key);
  }

  public registerAgentTransport(agentId: string, transport: IAgentTransport): void {
    this.agentTransports.set(agentId, transport);
  }

  public unregisterAgentTransport(agentId: string): void {
    this.agentTransports.delete(agentId);
  }

  public getAgentTransport(agentId: string): IAgentTransport | undefined {
    return this.agentTransports.get(agentId);
  }

  public isAgentOnline(agentId: string): boolean {
    const transport = this.agentTransports.get(agentId);
    return !!transport && transport.isOnline();
  }

  public getConnectedAgents(): string[] {
    return Array.from(this.agentTransports.entries())
      .filter(([, transport]) => transport.isOnline())
      .map(([agentId]) => agentId);
  }

  public clear(): void {
    this.storeBindings.clear();
    this.agentTransports.clear();
  }
}
