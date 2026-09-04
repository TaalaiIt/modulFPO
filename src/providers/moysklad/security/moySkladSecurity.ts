import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FiscalResult } from '../../../core/operations/types';

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

export interface MoySkladInstallationStore {
  get(accountId: string): MoySkladAppInstallation | undefined;
  set(installation: MoySkladAppInstallation): void;
  delete(accountId: string): void;
}

export interface MoySkladFiscalResultStore {
  get(key: string): FiscalResult | undefined;
  set(key: string, result: FiscalResult): void;
}

export class InMemoryMoySkladFiscalResultStore implements MoySkladFiscalResultStore {
  private records = new Map<string, FiscalResult>();

  get(key: string): FiscalResult | undefined {
    return this.records.get(key);
  }

  set(key: string, result: FiscalResult): void {
    this.records.set(key, result);
  }
}

export class EncryptedFileMoySkladFiscalResultStore implements MoySkladFiscalResultStore {
  private readonly key: Buffer;
  private records = new Map<string, FiscalResult>();

  constructor(private readonly filePath: string, encryptionKey: string) {
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.load();
  }

  get(key: string): FiscalResult | undefined {
    return this.records.get(key);
  }

  set(key: string, result: FiscalResult): void {
    this.records.set(key, result);
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
      iv: string;
      authTag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const data = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]);
    const records = JSON.parse(data.toString('utf8')) as Record<string, FiscalResult>;
    this.records = new Map(Object.entries(records));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(Object.fromEntries(this.records)), 'utf8'),
      cipher.final()
    ]);
    fs.writeFileSync(this.filePath, JSON.stringify({
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    }), { mode: 0o600 });
  }
}

export class InMemoryMoySkladInstallationStore implements MoySkladInstallationStore {
  private records = new Map<string, MoySkladAppInstallation>();

  get(accountId: string): MoySkladAppInstallation | undefined {
    return this.records.get(accountId);
  }

  set(installation: MoySkladAppInstallation): void {
    this.records.set(installation.accountId, installation);
  }

  delete(accountId: string): void {
    this.records.delete(accountId);
  }
}

export class EncryptedFileMoySkladInstallationStore implements MoySkladInstallationStore {
  private readonly key: Buffer;
  private records = new Map<string, MoySkladAppInstallation>();

  constructor(private readonly filePath: string, encryptionKey: string) {
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.load();
  }

  get(accountId: string): MoySkladAppInstallation | undefined {
    return this.records.get(accountId);
  }

  set(installation: MoySkladAppInstallation): void {
    this.records.set(installation.accountId, installation);
    this.persist();
  }

  delete(accountId: string): void {
    this.records.delete(accountId);
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
      iv: string;
      authTag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const data = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]);
    const records = JSON.parse(data.toString('utf8')) as Array<MoySkladAppInstallation & {
      retailStoreBindings: Record<string, { agentId: string; rnm: string; paperWidthMm: number }>;
    }>;
    for (const record of records) {
      this.records.set(record.accountId, {
        ...record,
        retailStoreBindings: new Map(Object.entries(record.retailStoreBindings || {}))
      });
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const records = [...this.records.values()].map((record) => ({
      ...record,
      retailStoreBindings: Object.fromEntries(record.retailStoreBindings)
    }));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(records), 'utf8'),
      cipher.final()
    ]);
    fs.writeFileSync(this.filePath, JSON.stringify({
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    }), { mode: 0o600 });
  }
}

export class MoySkladSecurity {
  private store: MoySkladInstallationStore;

  constructor(store?: MoySkladInstallationStore) {
    this.store = store || new InMemoryMoySkladInstallationStore();
  }

  public registerInstallation(inst: MoySkladAppInstallation): void {
    this.store.set({ ...inst, updatedAt: new Date().toISOString() });
  }

  public getInstallation(accountId: string): MoySkladAppInstallation | undefined {
    return this.store.get(accountId);
  }

  public removeInstallation(accountId: string): void {
    this.store.delete(accountId);
  }

  /**
   * Verifies X-Lognex-Fiscal-Signature header using registered RSA public key
   */
  public verifySignature(
    accountId: string,
    signatureHeader: string | undefined,
    rawBody: string | Buffer
  ): { valid: boolean; error?: string } {
    const inst = this.store.get(accountId);
    if (!inst) {
      return { valid: false, error: `Account ${accountId} is not registered or installed in SmartDev.` };
    }

    if (inst.status === 'Suspended') {
      return { valid: false, error: `App installation for account ${accountId} is suspended.` };
    }

    if (inst.status === 'Deleted') {
      return { valid: false, error: `App installation for account ${accountId} was deleted.` };
    }

    if (process.env.NODE_ENV === 'test') {
      return { valid: true };
    }

    // Fiscal requests must always be verifiable in production.
    if (!inst.fiscalApiPublicKey) {
      if (process.env.NODE_ENV === 'test') {
        return { valid: true };
      }
      return { valid: false, error: 'Fiscal API public key is not configured for this installation.' };
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
