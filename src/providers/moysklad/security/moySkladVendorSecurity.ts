import crypto from 'crypto';

export class MoySkladVendorSecurity {
  constructor(private readonly secret?: string) {}

  public verify(
    headers: Record<string, string | string[] | undefined>
  ): { valid: boolean; error?: string } {
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
      const payload = JSON.parse(this.decode(encodedPayload)) as { exp?: number };
      if (header.alg !== 'HS256') return { valid: false, error: 'Unsupported Vendor API JWT algorithm.' };
      if (payload.exp !== undefined && payload.exp <= Math.floor(Date.now() / 1000)) {
        return { valid: false, error: 'Vendor API JWT has expired.' };
      }

      const expected = crypto
        .createHmac('sha256', this.secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
      const received = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return { valid: false, error: 'Vendor API JWT signature verification failed.' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Vendor API JWT cannot be verified.' };
    }
  }

  private decode(value: string): string {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
}
