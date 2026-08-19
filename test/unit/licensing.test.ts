import { LicenseServer } from '../../src/licensing/server/licenseServer';
import { LicenseClient } from '../../src/licensing/client/licenseClient';

describe('Licensing Subsystem Unit Tests', () => {
  let server: LicenseServer;

  beforeEach(() => {
    server = new LicenseServer();
  });

  it('should register and issue device_token on valid activation code (UC-19)', async () => {
    const res = await server.register({
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      agentId: 'AGENT-TEST-01',
      hardwareId: 'HWID-TEST-A1B2C3D4',
      providerCode: 'MOYSKLAD',
      providerAccountId: 'acc-demo-1',
      rnm: '000123456789'
    });

    expect(res.success).toBe(true);
    expect(res.licenseKey).toBe('LIC-SMARTDEV-TEST-001');
    expect(res.deviceToken).toBeDefined();
    expect(res.entitlements.active).toBe(true);
  });

  it('should reject registration if provider is not in allowedProviders list', async () => {
    await expect(
      server.register({
        activationCode: 'ACT-KR-FPO-8888',
        moduleCode: 'FPO_INTEGRATION',
        agentId: 'AGENT-TEST-02',
        hardwareId: 'HWID-TEST-02',
        providerCode: 'UNAUTHORIZED_POS'
      })
    ).rejects.toThrow('not permitted by license entitlements');
  });

  it('should detect HARDWARE_MISMATCH if agent runs with different HWID (UC-22)', async () => {
    // 1. Initial register with HWID-1
    await server.register({
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      agentId: 'AGENT-TEST-03',
      hardwareId: 'HWID-ORIGINAL-PC',
      providerCode: 'MOYSKLAD'
    });

    // 2. Verify with matching HWID -> Valid
    const validCheck = await server.verify({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'dummy',
      hardwareId: 'HWID-ORIGINAL-PC',
      agentId: 'AGENT-TEST-03'
    });
    expect(validCheck.valid).toBe(true);

    // 3. Verify from copied PC with different HWID -> HARDWARE_MISMATCH
    const copiedCheck = await server.verify({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'dummy',
      hardwareId: 'HWID-COPIED-PIRATE-PC',
      agentId: 'AGENT-TEST-03'
    });
    expect(copiedCheck.valid).toBe(false);
    expect(copiedCheck.errorCode).toBe('HARDWARE_MISMATCH');
  });

  it('should allow authorized rebind to new hardware (UC-22)', async () => {
    await server.register({
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      agentId: 'AGENT-TEST-04',
      hardwareId: 'HWID-OLD',
      providerCode: 'MOYSKLAD'
    });

    const rebindRes = await server.rebind({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      agentId: 'AGENT-TEST-04',
      newHardwareId: 'HWID-NEW',
      authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
    });

    expect(rebindRes.success).toBe(true);
    expect(rebindRes.newDeviceToken).toBeDefined();

    // Verify with new HWID
    const checkNew = await server.verify({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: rebindRes.newDeviceToken,
      hardwareId: 'HWID-NEW',
      agentId: 'AGENT-TEST-04'
    });
    expect(checkNew.valid).toBe(true);
  });

  describe('LicenseClient with Offline Grace Window (UC-20)', () => {
    it('should allow operation within 24h offline grace window when server is down (UC-20)', async () => {
      const offlineTransport = {
        async register() { throw new Error('Network error'); },
        async verify() { throw new Error('License Server Down 503'); },
        async heartbeat() { throw new Error('Network error'); }
      };

      const client = new LicenseClient('AGENT-OFFLINE-TEST', offlineTransport, 'HWID-FIXED-01');

      // Pre-seed cache as if verified 5 hours ago
      const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      client.loadCache({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        deviceToken: 'token-xyz',
        agentId: 'AGENT-OFFLINE-TEST',
        hardwareId: 'HWID-FIXED-01',
        entitlements: {
          active: true,
          paid: true,
          blocked: false,
          maxAgents: 5,
          maxRnms: 5,
          allowedProviders: ['MOYSKLAD', 'MOCK'],
          expiresAt: new Date(Date.now() + 100000000).toISOString(),
          offlineLimitHours: 24
        },
        lastLicenseOk: fiveHoursAgo,
        cachedAt: fiveHoursAgo
      });

      const check = await client.checkEntitlement();
      expect(check.allowed).toBe(true);
      expect(check.inGrace).toBe(true);
    });

    it('should block operation if offline grace window (>24h) has expired (UC-20)', async () => {
      const offlineTransport = {
        async register() { throw new Error('Network error'); },
        async verify() { throw new Error('License Server Down 503'); },
        async heartbeat() { throw new Error('Network error'); }
      };

      const client = new LicenseClient('AGENT-EXPIRED-TEST', offlineTransport, 'HWID-FIXED-02');

      // Pre-seed cache as if verified 30 hours ago (>24h limit)
      const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
      client.loadCache({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        deviceToken: 'token-xyz',
        agentId: 'AGENT-EXPIRED-TEST',
        hardwareId: 'HWID-FIXED-02',
        entitlements: {
          active: true,
          paid: true,
          blocked: false,
          maxAgents: 5,
          maxRnms: 5,
          allowedProviders: ['MOYSKLAD', 'MOCK'],
          expiresAt: new Date(Date.now() + 100000000).toISOString(),
          offlineLimitHours: 24
        },
        lastLicenseOk: thirtyHoursAgo,
        cachedAt: thirtyHoursAgo
      });

      const check = await client.checkEntitlement();
      expect(check.allowed).toBe(false);
      expect(check.errorCode).toBe('LICENSE_OFFLINE_LIMIT_EXCEEDED');
    });

    it('should block operation if license is marked blocked or unpaid (UC-21)', async () => {
      const serverRef = new LicenseServer();
      const serverTransport = {
        async register(req: any) { return serverRef.register(req); },
        async verify(req: any) { return serverRef.verify(req); },
        async heartbeat(req: any) { return serverRef.heartbeat(req); }
      };

      const client = new LicenseClient('AGENT-BLOCKED-TEST', serverTransport, 'HWID-BLOCKED-01');
      await client.activate('ACT-KR-FPO-8888', 'MOYSKLAD');

      // Now block license in server
      serverRef.updateLicense('LIC-SMARTDEV-TEST-001', {
        entitlements: {
          ...serverRef.getLicense('LIC-SMARTDEV-TEST-001')!.entitlements,
          blocked: true
        }
      });

      const check = await client.checkEntitlement();
      expect(check.allowed).toBe(false);
      expect(check.errorCode).toBe('LICENSE_BLOCKED');
    });
  });
});
