import crypto from 'crypto';

export interface MoySkladAppInstallation {
  appId: string;
  accountId: string;
  accessToken: string;
  fiscalApiId?: string;
  fiscalApiPublicKey?: string; // RSA Public Key (additional.fiscalApi.token)
  status: 'Activated' | 'SettingsRequired' | 'Suspended' | 'Deleted';
  retailStoreBindings: Map<string, { agentId: string; rnm: string; paperWidthMm: number }>;
  createdAt: string;
  updatedAt: string;
}

export class MoySkladSecurity {
  private installations: Map<string, MoySkladAppInstallation> = new Map(); // accountId -> installation

  public registerInstallation(inst: MoySkladAppInstallation): void {
    this.installations.set(inst.accountId, { ...inst, updatedAt: new Date().toISOString() });
  }

  public getInstallation(accountId: string): MoySkladAppInstallation | undefined {
    return this.installations.get(accountId);
  }

  public removeInstallation(accountId: string): void {
    this.installations.delete(accountId);
  }

  /**
   * Verifies X-Lognex-Fiscal-Signature header using registered RSA public key
   */
  public verifySignature(
    accountId: string,
    signatureHeader: string | undefined,
    rawBody: string | Buffer
  ): { valid: boolean; error?: string } {
    const inst = this.installations.get(accountId);
    if (!inst) {
      return { valid: false, error: `Account ${accountId} is not registered or installed in SmartDev.` };
    }

    if (inst.status === 'Suspended') {
      return { valid: false, error: `App installation for account ${accountId} is suspended.` };
    }

    if (inst.status === 'Deleted') {
      return { valid: false, error: `App installation for account ${accountId} was deleted.` };
    }

    // If no public key configured (or development/test mode), accept valid account
    if (!inst.fiscalApiPublicKey) {
      return { valid: true };
    }

    if (!signatureHeader) {
      return { valid: false, error: 'Missing X-Lognex-Fiscal-Signature header.' };
    }

    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(rawBody);
      const isVerified = verifier.verify(inst.fiscalApiPublicKey, signatureHeader, 'base64');
      return { valid: isVerified, error: isVerified ? undefined : 'RSA signature verification failed.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `Signature verification exception: ${msg}` };
    }
  }
}
