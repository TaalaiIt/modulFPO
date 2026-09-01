import crypto from 'crypto';
import { MoySkladVendorSecurity } from '../../src/providers/moysklad/security/moySkladVendorSecurity';

function createVendorJwt(secret: string, customPayload?: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: 'vendor-request-id',
    ...(customPayload || {})
  });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('MoySkladVendorSecurity', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const secret = 'test-vendor-secret';

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts a signed MoySklad Vendor API JWT without appId or accountId claims', () => {
    const security = new MoySkladVendorSecurity(secret);
    expect(security.verify({ authorization: `Bearer ${createVendorJwt(secret)}` })).toEqual({ valid: true });
  });

  it('accepts a signed JWT when tenant_id matches accountName in allowed candidates', () => {
    const security = new MoySkladVendorSecurity(secret);
    const token = createVendorJwt(secret, { tenant_id: 'nurelmalabaev95' });
    const result = security.verify(
      { authorization: `Bearer ${token}` },
      ['4a4e8518-9d49-11f1-0a80-177c00003e8d', 'nurelmalabaev95']
    );
    expect(result.valid).toBe(true);
    expect(result.tenantId).toBe('nurelmalabaev95');
  });

  it('accepts a signed JWT when sub claim has user@accountName format', () => {
    const security = new MoySkladVendorSecurity(secret);
    const token = createVendorJwt(secret, { sub: 'admin@nurelmalabaev95' });
    const result = security.verify(
      { 'x-lognex-vendor-jwt': token },
      ['4a4e8518-9d49-11f1-0a80-177c00003e8d', 'nurelmalabaev95']
    );
    expect(result.valid).toBe(true);
  });

  it('rejects JWT when tenant claims do not match expected candidates', () => {
    const security = new MoySkladVendorSecurity(secret);
    const token = createVendorJwt(secret, { tenant_id: 'other_account' });
    const result = security.verify(
      { authorization: `Bearer ${token}` },
      ['4a4e8518-9d49-11f1-0a80-177c00003e8d', 'nurelmalabaev95']
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Vendor API JWT tenant mismatch.');
  });

  it('rejects JWT with invalid signature', () => {
    const security = new MoySkladVendorSecurity(secret);
    const token = createVendorJwt('wrong-secret', { tenant_id: 'nurelmalabaev95' });
    const result = security.verify(
      { authorization: `Bearer ${token}` },
      ['nurelmalabaev95']
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Vendor API JWT signature verification failed.');
  });
});
