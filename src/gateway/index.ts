import { buildGatewayApp } from './gatewayApp';

async function main() {
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
