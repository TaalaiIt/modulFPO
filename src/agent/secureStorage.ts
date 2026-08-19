import crypto from 'crypto';

export interface LocalAgentSecrets {
  rnm: string;
  pin: string;
  fpoLogin?: string;
  fpoPassword?: string;
  agentId: string;
  activationCode?: string;
  licenseKey?: string;
  deviceToken?: string;
  gatewayPairingCode?: string;
}

export class SecureLocalStorage {
  private encryptionKey: Buffer;
  private memoryCache: Map<string, string> = new Map();

  constructor(masterSecret = 'smartdev_agent_local_secure_storage_salt_2026') {
    this.encryptionKey = crypto.createHash('sha256').update(masterSecret).digest();
  }

  private encrypt(plainText: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  private decrypt(cipherText: string): string {
    const [ivHex, encryptedHex] = cipherText.split(':');
    if (!ivHex || !encryptedHex) throw new Error('Invalid encrypted storage format');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  public saveSecrets(secrets: LocalAgentSecrets): void {
    const serialized = JSON.stringify(secrets);
    const encrypted = this.encrypt(serialized);
    this.memoryCache.set('agent_secrets', encrypted);
  }

  public loadSecrets(): LocalAgentSecrets | null {
    const encrypted = this.memoryCache.get('agent_secrets');
    if (!encrypted) return null;
    try {
      const decrypted = this.decrypt(encrypted);
      return JSON.parse(decrypted) as LocalAgentSecrets;
    } catch {
      return null;
    }
  }

  public clear(): void {
    this.memoryCache.clear();
  }
}
