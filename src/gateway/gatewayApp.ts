import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IntegrationOrchestrator } from '../core/orchestrator';
import { MoySkladProviderAdapter } from '../providers/moysklad/moySkladProviderAdapter';
import { MockProviderAdapter } from '../providers/mock/mockProviderAdapter';
import { LicenseServer } from '../licensing/server/licenseServer';
import { GatewayWsServer, WsAgentTransport } from './transport/gatewayWsServer';
import { EncryptedFileMoySkladInstallationStore } from '../providers/moysklad/security/moySkladSecurity';
import { FiscalResult } from '../core/operations/types';

export interface GatewayAppOptions {
  orchestrator?: IntegrationOrchestrator;
  licenseServer?: LicenseServer;
  validateAgentToken?: (agentId: string, token: string) => boolean;
}

export function buildGatewayApp(options?: GatewayAppOptions): {
  fastify: FastifyInstance;
  orchestrator: IntegrationOrchestrator;
  licenseServer: LicenseServer;
  wsServer: GatewayWsServer;
} {
  const fastify = Fastify({ logger: false });
  const orchestrator = options?.orchestrator || new IntegrationOrchestrator();
  const licenseServer = options?.licenseServer || new LicenseServer({
    storagePath: process.env.SMARTDEV_LICENSE_STORAGE_PATH,
    storageKey: process.env.SMARTDEV_LICENSE_STORAGE_KEY,
    tokenSecret: process.env.SMARTDEV_LICENSE_TOKEN_SECRET,
    rebindSecret: process.env.SMARTDEV_REBIND_SECRET
  });

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = body as string;
    (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Register Provider Adapters
  const installationStore = process.env.MOYSKLAD_STORAGE_PATH && process.env.MOYSKLAD_STORAGE_KEY
    ? new EncryptedFileMoySkladInstallationStore(
        process.env.MOYSKLAD_STORAGE_PATH,
        process.env.MOYSKLAD_STORAGE_KEY
      )
    : undefined;
  const msAdapter = new MoySkladProviderAdapter(orchestrator.auditLogger, installationStore);
  const mockAdapter = new MockProviderAdapter();

  if (!orchestrator.providerRegistry.get('MOYSKLAD')) {
    orchestrator.providerRegistry.register(msAdapter);
  }
  if (!orchestrator.providerRegistry.get('MOCK')) {
    orchestrator.providerRegistry.register(mockAdapter);
  }

  // Setup WebSocket server for Agent connections
  const wsServer = new GatewayWsServer({
    onAgentConnected: (agentId: string, transport: WsAgentTransport) => {
      orchestrator.routingService.registerAgentTransport(agentId, transport);
    },
    onAgentDisconnected: (agentId: string) => {
      orchestrator.routingService.unregisterAgentTransport(agentId);
    },
    validateAgentToken: options?.validateAgentToken,
    auditLogger: orchestrator.auditLogger
  });

  // Attach WebSocket to Node HTTP server after fastify is ready
  fastify.addHook('onReady', (done) => {
    wsServer.attach(fastify.server);
    done();
  });

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // ==========================================
  // Vendor API 1.0 Routes (MoySklad lifecycle)
  // ==========================================
  fastify.post('/vendor/1.0/apps/:appId/:accountId', async (req: FastifyRequest<{ Params: { appId: string; accountId: string } }>, reply: FastifyReply) => {
    const { appId, accountId } = req.params;
    const vendorAuth = msAdapter.verifyVendorRequest(req.headers as Record<string, string | string[] | undefined>, appId, accountId);
    if (!vendorAuth.valid) return reply.status(401).send({ errors: [{ error: vendorAuth.error, error_message: vendorAuth.error }] });
    const body = (req.body || {}) as Record<string, unknown>;
    const res = await msAdapter.handleVendorLifecycle({
      action: 'INSTALL',
      appId,
      accountId,
      payload: body
    });
    return reply.status(res.status === 'Error' ? 400 : 200).send(res);
  });

  fastify.put('/vendor/1.0/apps/:appId/:accountId', async (req: FastifyRequest<{ Params: { appId: string; accountId: string } }>, reply: FastifyReply) => {
    const { appId, accountId } = req.params;
    const vendorAuth = msAdapter.verifyVendorRequest(req.headers as Record<string, string | string[] | undefined>, appId, accountId);
    if (!vendorAuth.valid) return reply.status(401).send({ errors: [{ error: vendorAuth.error, error_message: vendorAuth.error }] });
    const body = (req.body || {}) as Record<string, unknown>;
    const res = await msAdapter.handleVendorLifecycle({
      action: 'SETTINGS_UPDATE',
      appId,
      accountId,
      payload: body
    });
    return reply.status(res.status === 'Error' ? 400 : 200).send(res);
  });

  fastify.delete('/vendor/1.0/apps/:appId/:accountId', async (req: FastifyRequest<{ Params: { appId: string; accountId: string } }>, reply: FastifyReply) => {
    const { appId, accountId } = req.params;
    const vendorAuth = msAdapter.verifyVendorRequest(req.headers as Record<string, string | string[] | undefined>, appId, accountId);
    if (!vendorAuth.valid) return reply.status(401).send({ errors: [{ error: vendorAuth.error, error_message: vendorAuth.error }] });
    const res = await msAdapter.handleVendorLifecycle({
      action: 'DELETE',
      appId,
      accountId,
      payload: {}
    });
    return reply.status(200).send(res);
  });

  fastify.post('/vendor/1.0/apps/:appId/:accountId/suspend', async (req: FastifyRequest<{ Params: { appId: string; accountId: string } }>, reply: FastifyReply) => {
    const { appId, accountId } = req.params;
    const vendorAuth = msAdapter.verifyVendorRequest(req.headers as Record<string, string | string[] | undefined>, appId, accountId);
    if (!vendorAuth.valid) return reply.status(401).send({ errors: [{ error: vendorAuth.error, error_message: vendorAuth.error }] });
    const res = await msAdapter.handleVendorLifecycle({
      action: 'SUSPEND',
      appId,
      accountId,
      payload: {}
    });
    return reply.status(200).send(res);
  });

  fastify.post('/vendor/1.0/apps/:appId/:accountId/resume', async (req: FastifyRequest<{ Params: { appId: string; accountId: string } }>, reply: FastifyReply) => {
    const { appId, accountId } = req.params;
    const vendorAuth = msAdapter.verifyVendorRequest(req.headers as Record<string, string | string[] | undefined>, appId, accountId);
    if (!vendorAuth.valid) return reply.status(401).send({ errors: [{ error: vendorAuth.error, error_message: vendorAuth.error }] });
    const res = await msAdapter.handleVendorLifecycle({
      action: 'RESUME',
      appId,
      accountId,
      payload: {}
    });
    return reply.status(200).send(res);
  });

  // ==========================================
  // Fiscal API 1.0 Routes (MoySklad)
  // ==========================================
  const handleMoySkladFiscal = async (req: FastifyRequest, reply: FastifyReply) => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const body = req.body;
    const url = req.url;
    const method = req.method;

    const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
      headers,
      body,
      rawBody: (req as FastifyRequest & { rawBody?: string }).rawBody,
      url,
      method
    });

    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        reply.header(k, v);
      }
    }
    return reply.status(res.statusCode).send(res.body);
  };

  fastify.put('/1/openshift', handleMoySkladFiscal);
  fastify.put('/fiscal/1.0/openshift', handleMoySkladFiscal);

  fastify.post('/1/retaildemand', handleMoySkladFiscal);
  fastify.post('/fiscal/1.0/retaildemand', handleMoySkladFiscal);

  fastify.post('/1/retaisalesreturn', handleMoySkladFiscal);
  fastify.post('/1/retailsalesreturn', handleMoySkladFiscal);
  fastify.post('/fiscal/1.0/retaisalesreturn', handleMoySkladFiscal);
  fastify.post('/fiscal/1.0/retailsalesreturn', handleMoySkladFiscal);

  fastify.post('/1/retaildrawercashin', handleMoySkladFiscal);
  fastify.post('/fiscal/1.0/retaildrawercashin', handleMoySkladFiscal);

  fastify.post('/1/retaildrawercashout', handleMoySkladFiscal);
  fastify.post('/fiscal/1.0/retaildrawercashout', handleMoySkladFiscal);

  fastify.put('/1/closeshift', handleMoySkladFiscal);
  fastify.put('/fiscal/1.0/closeshift', handleMoySkladFiscal);

  // ==========================================
  // Generic Provider Fiscal Routes
  // ==========================================
  fastify.post('/api/v1/providers/:providerCode/fiscal', async (req: FastifyRequest<{ Params: { providerCode: string } }>, reply: FastifyReply) => {
    const { providerCode } = req.params;
    const res = await orchestrator.handleFiscalRequest(providerCode, {
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      url: req.url,
      method: req.method
    });
    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        reply.header(k, v);
      }
    }
    return reply.status(res.statusCode).send(res.body);
  });

  // ==========================================
  // SmartDev License Server Routes
  // ==========================================
  fastify.post('/api/v1/module/register', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await licenseServer.register(req.body as any);
      return reply.status(200).send(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: msg });
    }
  });

  fastify.post('/api/v1/module/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const res = await licenseServer.verify(req.body as any);
    return reply.status(res.valid ? 200 : 403).send(res);
  });

  fastify.get('/api/v1/module/license', async (req: FastifyRequest, reply: FastifyReply) => {
    const authorization = req.headers.authorization;
    const deviceToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!deviceToken) {
      return reply.status(401).send({ success: false, error: 'Bearer device_token is required.' });
    }
    const license = licenseServer.getLicenseByDeviceToken(deviceToken);
    return license
      ? reply.status(200).send({ success: true, ...license })
      : reply.status(401).send({ success: false, error: 'Invalid device_token.' });
  });

  fastify.post('/api/v1/operations/reconcile', async (req: FastifyRequest, reply: FastifyReply) => {
    const expectedToken = process.env.SMARTDEV_RECONCILIATION_TOKEN;
    const suppliedToken = req.headers['x-reconciliation-token'];
    if (!expectedToken || suppliedToken !== expectedToken) {
      return reply.status(401).send({ success: false, error: 'Reconciliation authorization failed.' });
    }
    const body = req.body as { providerCode?: string; key?: string; result?: FiscalResult };
    if (!body?.providerCode || !body.key || !body.result) {
      return reply.status(400).send({ success: false, error: 'providerCode, key and result are required.' });
    }
    try {
      await orchestrator.reconcileUnknown(body.providerCode, body.key, body.result);
      return reply.status(200).send({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(409).send({ success: false, error: message });
    }
  });

  fastify.post('/api/v1/module/heartbeat', async (req: FastifyRequest, reply: FastifyReply) => {
    const res = await licenseServer.heartbeat(req.body as any);
    return reply.status(200).send(res);
  });

  fastify.post('/api/v1/module/rebind', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const res = await licenseServer.rebind(req.body as any);
      return reply.status(200).send(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: msg });
    }
  });

  return { fastify, orchestrator, licenseServer, wsServer };
}
