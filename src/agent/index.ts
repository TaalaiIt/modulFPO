import { HttpFiscalConnectorClient } from '../fpo/client/fiscalConnectorClient';
import { LicenseClient } from '../licensing/client/licenseClient';
import { SecureLocalStorage } from './secureStorage';
import { AgentService } from './agentService';
import { AgentWsClient } from './transport/agentWsClient';
import { AuditLogger } from '../core/audit/auditLogger';

async function main() {
  const agentId = process.env.AGENT_ID || 'AGENT-LOCAL-001';
  const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:3000/agent-ws';
  const licenseServerUrl = process.env.LICENSE_SERVER_URL || 'http://localhost:3000/api/v1/module';
  const fpoUrl = process.env.FPO_URL || 'http://localhost:8080';

  console.log(`🚀 Starting SmartDev Fiscal Agent ${agentId}...`);

  const storage = new SecureLocalStorage();
  const auditLogger = new AuditLogger();
  const fpoClient = new HttpFiscalConnectorClient(fpoUrl);

  const licenseTransport = {
    async register(req: any) {
      const res = await fetch(`${licenseServerUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return res.json();
    },
    async verify(req: any) {
      const res = await fetch(`${licenseServerUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return res.json();
    },
    async heartbeat(req: any) {
      const res = await fetch(`${licenseServerUrl}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return res.json();
    }
  };

  const licenseClient = new LicenseClient(agentId, licenseTransport, undefined, auditLogger);
  const agentService = new AgentService(agentId, fpoClient, licenseClient, storage, auditLogger);

  const secrets = storage.loadSecrets();
  const deviceToken = secrets?.deviceToken || 'pending_activation';

  const wsClient = new AgentWsClient(
    { gatewayUrl, agentId, deviceToken },
    agentService,
    auditLogger
  );

  wsClient.start();
  console.log(`📡 Fiscal Agent connected/connecting to Gateway: ${gatewayUrl}`);
}

if (require.main === module) {
  main();
}
