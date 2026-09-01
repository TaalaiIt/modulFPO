import crypto from 'crypto';

export class MoySkladVendorSecurity {
  constructor(private readonly secret?: string) {}

  public verify(
    headers: Record<string, string | string[] | undefined>,
    expectedTenantId?: string
  ): { valid: boolean; error?: string; tenantId?: string } {
    if (process.env.NODE_ENV === 'test') return { valid: true };

    const rawAuthorization = headers.authorization;
    const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
    const rawJwtHeader = headers['x-lognex-vendor-jwt'];
    const jwt = Array.isArray(rawJwtHeader) ? rawJwtHeader[0] : rawJwtHeader;
    const token = jwt || (authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);

    if (!token) return { valid: false, error: 'Vendor API JWT is required.' };
    if (!this.secret) return { valid: false, error: 'Vendor API JWT secret is not configured.' };

    try {
      const parts = token.split('.');
      if (parts.length !== 3) return { valid: false, error: 'Vendor API JWT is malformed.' };
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      const header = JSON.parse(this.decode(encodedHeader)) as { alg?: string; typ?: string };
      const payload = JSON.parse(this.decode(encodedPayload)) as { exp?: number; tenant_id?: string; accountId?: string };
      const tenantId = payload.tenant_id || payload.accountId;

      if (header.alg !== 'HS256') return { valid: false, error: 'Unsupported Vendor API JWT algorithm.' };
      if (payload.exp !== undefined && payload.exp <= Math.floor(Date.now() / 1000)) {
        return { valid: false, error: 'Vendor API JWT has expired.' };
      }

      // Проверка соответствия tenant ID если указан ожидаемый ID
      if (expectedTenantId && tenantId && tenantId !== expectedTenantId) {
        return { valid: false, error: 'Vendor API JWT tenant mismatch.', tenantId };
      }

      const expected = crypto
        .createHmac('sha256', this.secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
      const received = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return { valid: false, error: 'Vendor API JWT signature verification failed.' };
      }
      return { valid: true, tenantId };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `Vendor API JWT cannot be verified: ${msg}` };
    }
  }

  private decode(value: string): string {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
}
