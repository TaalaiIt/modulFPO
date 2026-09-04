import crypto from 'crypto';

function createVendorJwt(secret: string, payloadObj: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'pair-' + Date.now(),
    ...payloadObj
  });
  const signature = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + signature;
}

async function main() {
  const secret = process.env.MOYSKLAD_VENDOR_JWT_SECRET || 'NxT1k043qt8H900lBTP4gLqytlX1ZktiotEsYdeH2MX1HY4DWO24XSnLYmQaxuQnA9uFHNpvdK9niYXvGQZ515tOZYplOPjc91zIT7e0ifGlvqH1uD59M5EEQ0TZ5blt';
  const appId = process.env.APP_ID || '07a3671b-b8df-4de2-bccf-87de9bff1435';
  const accountId = process.env.ACCOUNT_ID || '4a4e8518-9d49-11f1-0a80-177c00003e8d';
  const storeId = process.env.STORE_ID || '4b2aca62-9d49-11f1-0a80-0283000ca5de';
  const agentId = process.env.AGENT_ID || 'AGENT-LOCAL-001';
  const rnm = process.env.RNM || '0000000000024294';
  const gatewayUrl = process.env.GATEWAY_HTTP_URL || 'https://esepmoysclad.smartdev.kg';

  const jwt = createVendorJwt(secret, {
    sub: 'admin@nurelmalabaev95',
    accountName: 'nurelmalabaev95',
    accountId
  });

  console.log('🔗 Pairing store ' + storeId + ' -> agent ' + agentId + '...');

  const url = gatewayUrl + '/vendor/1.0/apps/' + appId + '/' + accountId;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + jwt,
      'X-Lognex-Vendor-JWT': jwt
    },
    body: JSON.stringify({
      storeId,
      agentId,
      rnm,
      paperWidthMm: 80,
      accountName: 'nurelmalabaev95'
    })
  });

  const json = await response.json();
  console.log('✅ Response:', JSON.stringify(json, null, 2));
}

main().catch(console.error);
