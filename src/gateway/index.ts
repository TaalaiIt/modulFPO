import { buildGatewayApp } from './gatewayApp';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    const required = [
      'MOYSKLAD_VENDOR_JWT_SECRET',
      'MOYSKLAD_STORAGE_KEY',
      'SMARTDEV_LICENSE_STORAGE_KEY',
      'SMARTDEV_LICENSE_TOKEN_SECRET',
      'SMARTDEV_REBIND_SECRET',
      'SMARTDEV_RECONCILIATION_TOKEN'
    ];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
    }
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  const { fastify } = buildGatewayApp();

  try {
    await fastify.listen({ port, host });
    console.log(`🚀 SmartDev FPO Gateway running at http://${host}:${port}`);
    console.log(`📡 WebSocket endpoint: ws://${host}:${port}/agent-ws`);
  } catch (err) {
    console.error('Failed to start SmartDev FPO Gateway:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
