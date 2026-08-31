import crypto from 'crypto';
import { MoySkladVendorSecurity } from '../../src/providers/moysklad/security/moySkladVendorSecurity';

function createVendorJwt(secret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: 'vendor-request-id'
  });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('MoySkladVendorSecurity', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts a signed MoySklad Vendor API JWT without appId or accountId claims', () => {
    const secret = 'test-vendor-secret';
    const security = new MoySkladVendorSecurity(secret);

    expect(security.verify({ authorization: `Bearer ${createVendorJwt(secret)}` })).toEqual({ valid: true });
  });
});
