import { HttpFiscalConnectorClient } from '../fpo/client/fiscalConnectorClient';
import { LicenseClient } from '../licensing/client/licenseClient';
import { SecureLocalStorage } from './secureStorage';
import { AgentService } from './agentService';
import { AgentWsClient } from './transport/agentWsClient';
import { AuditLogger } from '../core/audit/auditLogger';
import {
  LicenseHeartbeatRequest,
  LicenseHeartbeatResponse,
  LicenseRegisterRequest,
  LicenseRegisterResponse,
  LicenseVerifyRequest,
  LicenseVerifyResponse
} from '../licensing/models/licenseTypes';

import fs from 'fs';
import path from 'path';

function loadEnvFile(filePath: string) {
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env.agent'));
loadEnvFile(path.resolve(process.cwd(), '.env'));

async function main() {
  const agentId = process.env.AGENT_ID || 'AGENT-LOCAL-001';
  const gatewayUrl = process.env.GATEWAY_URL || process.env.GATEWAY_WS_URL || 'wss://esepmoysclad.smartdev.kg/agent-ws';
  const licenseServerUrl = process.env.LICENSE_SERVER_URL || 'https://esepmoysclad.smartdev.kg/api/v1/module';
  const fpoUrl = process.env.FPO_URL || 'http://127.0.0.1:8080';

  console.log(`🚀 Starting SmartDev Fiscal Agent ${agentId}...`);

  const storage = new SecureLocalStorage();
  const auditLogger = new AuditLogger();
  const fpoClient = new HttpFiscalConnectorClient(fpoUrl);

  const licenseTransport = {
    async register(req: LicenseRegisterRequest): Promise<LicenseRegisterResponse> {
      const res = await fetch(`${licenseServerUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return (await res.json()) as LicenseRegisterResponse;
    },
    async verify(req: LicenseVerifyRequest): Promise<LicenseVerifyResponse> {
      const res = await fetch(`${licenseServerUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return (await res.json()) as LicenseVerifyResponse;
    },
    async heartbeat(req: LicenseHeartbeatRequest): Promise<LicenseHeartbeatResponse> {
      const res = await fetch(`${licenseServerUrl}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      return (await res.json()) as LicenseHeartbeatResponse;
    }
  };

  const secrets = storage.loadSecrets() || {
    agentId,
    rnm: process.env.FPO_RNM || process.env.REGISTRATION_NUMBER || '0000000000024294',
    pin: process.env.FPO_PIN || process.env.PIN || '71178',
    fpoLogin: process.env.FPO_LOGIN || process.env.LOGIN || 'goodoo@gamil.com',
    fpoPassword: process.env.FPO_PASSWORD || process.env.PASSWORD || '123456!',
    deviceToken: process.env.DEVICE_TOKEN || 'dev_token_smartdev_agent_01'
  };
  storage.saveSecrets(secrets);

  fpoClient.configure({ registrationNumber: secrets.rnm, receiptWidthMm: 80 });

  const licenseClient = new LicenseClient(agentId, licenseTransport, undefined, auditLogger);
  const agentService = new AgentService(agentId, fpoClient, licenseClient, storage, auditLogger);

  const deviceToken = secrets.deviceToken || 'dev_token_smartdev_agent_01';

  const wsClient = new AgentWsClient(
    { gatewayUrl, agentId, deviceToken },
    agentService,
    auditLogger
  );

  wsClient.start();
  console.log(`📡 Fiscal Agent connected/connecting to Gateway: ${gatewayUrl}`);

  // Run initial diagnostic check
  agentService.runDiagnostics().then((diag) => {
    console.log(`🔍 Diagnostics: FC Connected=${diag.fcConnected}, SAM Card=${diag.samCardPresent}, PIN Verified=${diag.pinVerified}`);
    if (diag.errors.length > 0) {
      console.warn(`⚠️ Diagnostic warnings:`, diag.errors.join(', '));
    }
  }).catch((err) => {
    console.warn(`⚠️ Diagnostics check note:`, err.message);
  });
}

if (require.main === module) {
  main();
}
