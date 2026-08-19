const assert = require('assert');

// Register ts-node so .ts files can be required directly and instantly
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs',
    target: 'es2022',
    skipLibCheck: true,
    esModuleInterop: true
  }
});

const { IntegrationOrchestrator } = require('../src/core/orchestrator');
const { MoySkladProviderAdapter } = require('../src/providers/moysklad/moySkladProviderAdapter');
const { MockProviderAdapter } = require('../src/providers/mock/mockProviderAdapter');
const { MockFiscalConnector } = require('../src/fpo/mock/mockFiscalConnector');
const { LicenseServer } = require('../src/licensing/server/licenseServer');
const { LicenseClient } = require('../src/licensing/client/licenseClient');
const { SecureLocalStorage } = require('../src/agent/secureStorage');
const { AgentService } = require('../src/agent/agentService');
const { OperationType, OperationStatus } = require('../src/core/operations/types');
const { IdempotencyManager } = require('../src/core/idempotency/idempotencyManager');
const { AuditLogger, AuditEventType } = require('../src/core/audit/auditLogger');

let passedCount = 0;
let totalCount = 0;

function test(name, fn) {
  totalCount++;
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => {
        console.log(`  ✅ PASSED: ${name}`);
        passedCount++;
      }).catch((err) => {
        console.error(`  ❌ FAILED: ${name}`);
        console.error(`     Error: ${err.message}`);
        throw err;
      });
    } else {
      console.log(`  ✅ PASSED: ${name}`);
      passedCount++;
      return Promise.resolve();
    }
  } catch (err) {
    console.error(`  ❌ FAILED: ${name}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function runAll() {
  console.log('======================================================================');
  console.log('🚀 RUNNING SMARTDEV FPO INTEGRATION COMPREHENSIVE TEST SUITE');
  console.log('======================================================================\n');

  console.log('📦 SECTION 1: Core Subsystem & Idempotency Tests');
  // 1. Idempotency Key
  await test('IdempotencyManager generates standard composite key', () => {
    const mgr = new IdempotencyManager();
    const key = mgr.buildKey('MOYSKLAD', 'acc-1', 'SALE', 'doc-1');
    assert.strictEqual(key, 'MOYSKLAD:acc-1:SALE:doc-1');
  });

  // 2. Hash & Cache
  await test('IdempotencyManager returns cached result on identical duplicate (UC-18)', async () => {
    const mgr = new IdempotencyManager();
    const op = {
      operationId: 'op-1',
      providerCode: 'MOCK',
      providerAccountId: 'acc-1',
      externalOperationId: 'doc-1',
      operationType: OperationType.SALE,
      storeId: 'store-1',
      totalSum: 100,
      createdAt: new Date().toISOString()
    };
    const c1 = await mgr.checkOrStart(op);
    assert.strictEqual(c1.action, 'PROCEED');

    const result = {
      success: true,
      operationId: 'op-1',
      providerCode: 'MOCK',
      providerAccountId: 'acc-1',
      externalOperationId: 'doc-1',
      operationType: OperationType.SALE,
      status: OperationStatus.SUCCESS,
      fiscalDocNumber: 555,
      fiscalDocSign: 'FPD-555-TEST',
      completedAt: new Date().toISOString()
    };
    await mgr.markSuccess(c1.key, result);

    const c2 = await mgr.checkOrStart(op);
    assert.strictEqual(c2.action, 'RETURN_CACHED');
    assert.strictEqual(c2.result.fiscalDocNumber, 555);
  });

  // 3. Payload conflict
  await test('IdempotencyManager rejects payload conflict with same key', async () => {
    const mgr = new IdempotencyManager();
    const op1 = {
      operationId: 'op-1',
      providerCode: 'MOCK',
      providerAccountId: 'acc-1',
      externalOperationId: 'doc-2',
      operationType: OperationType.SALE,
      storeId: 'store-1',
      totalSum: 100,
      rawExternalPayload: { sum: 100 },
      createdAt: new Date().toISOString()
    };
    await mgr.checkOrStart(op1);

    const op2 = {
      operationId: 'op-2',
      providerCode: 'MOCK',
      providerAccountId: 'acc-1',
      externalOperationId: 'doc-2',
      operationType: OperationType.SALE,
      storeId: 'store-1',
      totalSum: 200,
      rawExternalPayload: { sum: 200 },
      createdAt: new Date().toISOString()
    };
    const c2 = await mgr.checkOrStart(op2);
    assert.strictEqual(c2.action, 'REJECT');
    assert.strictEqual(c2.error.code, 'PAYLOAD_CONFLICT');
  });

  // 4. Audit masking
  await test('AuditLogger masks sensitive PIN and tokens', () => {
    const logger = new AuditLogger();
    const rec = logger.log({
      eventType: AuditEventType.DIAGNOSTIC_RUN,
      message: 'Test audit',
      details: {
        pin: '1234',
        fpoPassword: 'secretPassword',
        rnm: '000123456789'
      }
    });
    assert.strictEqual(rec.details.pin, '***REDACTED***');
    assert.strictEqual(rec.details.fpoPassword, '***REDACTED***');
    assert.strictEqual(rec.details.rnm, '000123456789');
  });

  console.log('\n📦 SECTION 2: Licensing Subsystem Tests (Server & Client)');
  // 5. License Activation (UC-19)
  let licenseServerRef;
  await test('LicenseServer registers seat and issues deviceToken on valid activation code (UC-19)', async () => {
    licenseServerRef = new LicenseServer();
    const res = await licenseServerRef.register({
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      agentId: 'AGENT-TEST-01',
      hardwareId: 'HWID-TEST-01',
      providerCode: 'MOYSKLAD',
      providerAccountId: 'acc-1',
      rnm: '000123456789'
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.licenseKey, 'LIC-SMARTDEV-TEST-001');
    assert.ok(res.deviceToken);
  });

  // 6. License HWID mismatch & rebind (UC-22)
  await test('LicenseServer detects HWID mismatch and handles rebind (UC-22)', async () => {
    const check1 = await licenseServerRef.verify({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'token',
      hardwareId: 'HWID-COPIED-PIRATE',
      agentId: 'AGENT-TEST-01'
    });
    assert.strictEqual(check1.valid, false);
    assert.strictEqual(check1.errorCode, 'HARDWARE_MISMATCH');

    const rebindRes = await licenseServerRef.rebind({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      agentId: 'AGENT-TEST-01',
      newHardwareId: 'HWID-COPIED-PIRATE',
      authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
    });
    assert.strictEqual(rebindRes.success, true);

    const check2 = await licenseServerRef.verify({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: rebindRes.newDeviceToken,
      hardwareId: 'HWID-COPIED-PIRATE',
      agentId: 'AGENT-TEST-01'
    });
    assert.strictEqual(check2.valid, true);
  });

  // 7. License Offline Grace Window (UC-20)
  await test('LicenseClient allows operation within 24h offline grace window (UC-20)', async () => {
    const offlineTransport = {
      async register() { throw new Error('Offline'); },
      async verify() { throw new Error('Offline 503'); },
      async heartbeat() { throw new Error('Offline'); }
    };
    const client = new LicenseClient('AGENT-GRACE-01', offlineTransport, 'HWID-GRACE-01');
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    client.loadCache({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'token-xyz',
      agentId: 'AGENT-GRACE-01',
      hardwareId: 'HWID-GRACE-01',
      entitlements: {
        active: true,
        paid: true,
        blocked: false,
        maxAgents: 5,
        maxRnms: 5,
        allowedProviders: ['MOYSKLAD'],
        expiresAt: new Date(Date.now() + 100000000).toISOString(),
        offlineLimitHours: 24
      },
      lastLicenseOk: sixHoursAgo,
      cachedAt: sixHoursAgo
    });

    const check = await client.checkEntitlement();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.inGrace, true);
  });

  // 8. License Grace Expired (UC-20)
  await test('LicenseClient blocks operation when offline grace window (>24h) has expired (UC-20)', async () => {
    const offlineTransport = {
      async register() { throw new Error('Offline'); },
      async verify() { throw new Error('Offline 503'); },
      async heartbeat() { throw new Error('Offline'); }
    };
    const client = new LicenseClient('AGENT-EXPIRED-01', offlineTransport, 'HWID-EXPIRED-01');
    const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    client.loadCache({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'token-xyz',
      agentId: 'AGENT-EXPIRED-01',
      hardwareId: 'HWID-EXPIRED-01',
      entitlements: {
        active: true,
        paid: true,
        blocked: false,
        maxAgents: 5,
        maxRnms: 5,
        allowedProviders: ['MOYSKLAD'],
        expiresAt: new Date(Date.now() + 100000000).toISOString(),
        offlineLimitHours: 24
      },
      lastLicenseOk: thirtyHoursAgo,
      cachedAt: thirtyHoursAgo
    });

    const check = await client.checkEntitlement();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.errorCode, 'LICENSE_OFFLINE_LIMIT_EXCEEDED');
  });

  console.log('\n📦 SECTION 3: End-to-End Use Cases UC-01 through UC-23');

  // Setup full E2E environment
  const TEST_ACC = 'acc-e2e-001';
  const TEST_STORE = 'store-bishkek-e2e';
  const TEST_AGENT = 'AGENT-E2E-001';
  const TEST_RNM = '000123456789';
  const TEST_PIN = '1234';
  const TEST_HWID = 'HWID-E2E-POS-001';

  const orch = new IntegrationOrchestrator();
  const licSrv = new LicenseServer();
  const fpoMock = new MockFiscalConnector({ rnm: TEST_RNM, correctPin: TEST_PIN });
  const storage = new SecureLocalStorage();

  const licTransport = {
    async register(req) { return licSrv.register(req); },
    async verify(req) { return licSrv.verify(req); },
    async heartbeat(req) { return licSrv.heartbeat(req); }
  };

  const licClient = new LicenseClient(TEST_AGENT, licTransport, TEST_HWID, orch.auditLogger);
  const agent = new AgentService(TEST_AGENT, fpoMock, licClient, storage, orch.auditLogger);

  const msAdapt = new MoySkladProviderAdapter(orch.auditLogger);
  const mockAdapt = new MockProviderAdapter();
  orch.providerRegistry.register(msAdapt);
  orch.providerRegistry.register(mockAdapt);

  orch.setDirectDispatchHandler(async (op) => agent.executeOperation(op));

  storage.saveSecrets({
    agentId: TEST_AGENT,
    rnm: TEST_RNM,
    pin: TEST_PIN,
    fpoLogin: 'user',
    fpoPassword: 'password'
  });

  await licClient.activate('ACT-KR-FPO-8888', 'MOYSKLAD', TEST_ACC, TEST_RNM);

  // UC-01: Установка и настройка решения
  await test('UC-01: App installation, pairing, diagnostics and activation', async () => {
    const inst = await msAdapt.handleVendorLifecycle({
      action: 'INSTALL',
      appId: 'app-fpo-kr',
      accountId: TEST_ACC,
      payload: { access_token: 'token-123' }
    });
    assert.strictEqual(inst.status, 'SettingsRequired');

    const diag = await agent.runDiagnostics();
    assert.strictEqual(diag.healthy, true);

    const set = await msAdapt.handleVendorLifecycle({
      action: 'SETTINGS_UPDATE',
      appId: 'app-fpo-kr',
      accountId: TEST_ACC,
      payload: { storeId: TEST_STORE, agentId: TEST_AGENT, rnm: TEST_RNM, paperWidthMm: 80 }
    });
    assert.strictEqual(set.status, 'Activated');

    orch.routingService.registerStoreBinding({
      providerCode: 'MOYSKLAD',
      providerAccountId: TEST_ACC,
      storeId: TEST_STORE,
      agentId: TEST_AGENT,
      rnm: TEST_RNM,
      paperWidthMm: 80,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });

  // UC-02: Успешное открытие смены
  await test('UC-02: Successful shift opening with PDF/ZIP receipt', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        retailShift: { meta: { id: 'shift-01' } },
        retailStore: { meta: { id: TEST_STORE } }
      },
      url: '/1/openshift'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.ok(res.rawResult.fiscalDocNumber);
    assert.strictEqual(res.rawResult.receipt.format, 'PDF_ZIP_BASE64');
  });

  // UC-03: SAM-карта отсутствует
  await test('UC-03: Missing SAM card returns blocking error', async () => {
    fpoMock.updateConfig({ samCardPresent: false });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        retailShift: { meta: { id: 'shift-02' } },
        retailStore: { meta: { id: TEST_STORE } }
      },
      url: '/1/openshift'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.rawResult.success, false);
    assert.strictEqual(res.rawResult.error.code, 'SAM_CARD_MISSING');
    fpoMock.updateConfig({ samCardPresent: true }); // Restore
  });

  // UC-04: Нет интернета при открытии смены
  await test('UC-04: GNS tax authority connection failure returns network error', async () => {
    fpoMock.updateConfig({ simulateAuthNetworkFailure: true });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        retailShift: { meta: { id: 'shift-03' } },
        retailStore: { meta: { id: TEST_STORE } }
      },
      url: '/1/openshift'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.rawResult.success, false);
    assert.strictEqual(res.rawResult.error.code, 'FPO_40801');
    fpoMock.updateConfig({ simulateAuthNetworkFailure: false }); // Restore
  });

  // Ensure shift is open for sales
  const shiftState = await fpoMock.getStateShift();
  if (shiftState.shiftStatus !== 'OPEN') {
    await fpoMock.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
    await fpoMock.auth({ rnm: TEST_RNM });
    await fpoMock.openShift();
  }

  // UC-05: Продажа за наличные
  await test('UC-05: Cash sale with totalCashSum and PDF receipt', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-cash-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        cashier: { name: 'Кассир 1' },
        positions: [{ name: 'Хлеб', price: 35.0, quantity: 2, cost: 70.0, vat: 12, salesTax: 1 }],
        cashSum: 70.0,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.ok(res.rawResult.fiscalDocNumber);
    assert.ok(res.rawResult.fiscalDocSign);
  });

  // UC-06: Продажа банковской картой
  await test('UC-06: Cashless card sale with totalCashlessSum', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-card-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Кофе', price: 200.0, quantity: 1, cost: 200.0 }],
        cashSum: 0,
        cardSum: 200.0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
  });

  // UC-07: Смешанная оплата
  await test('UC-07: Mixed payment (cash + card + QR)', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-mixed-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Куртка', price: 1000.0, quantity: 1, cost: 1000.0 }],
        cashSum: 300.0,
        cardSum: 500.0,
        qrSum: 200.0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
  });

  // UC-08: Возврат продажи
  await test('UC-08: Return sale with originFdNumber lookup', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        salesReturn: { meta: { id: 'return-1' } },
        demand: { meta: { id: 'demand-cash-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        originFdNumber: 101,
        originFnSerialNumber: 'FM9876543210',
        positions: [{ name: 'Возврат хлеб', price: 35.0, quantity: 2, cost: 70.0 }],
        cashSum: 70.0,
        cardSum: 0
      },
      url: '/1/retaisalesreturn'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.strictEqual(res.rawResult.operationType, OperationType.RETURN);
  });

  // UC-09: Внесение наличных
  await test('UC-09: Cash deposit transaction', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        cashIn: { meta: { id: 'cashin-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        sum: 5000.0
      },
      url: '/1/retaildrawercashin'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.strictEqual(res.rawResult.operationType, OperationType.DEPOSIT);
  });

  // UC-10: Выплата наличных
  await test('UC-10: Cash withdrawal transaction', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        cashOut: { meta: { id: 'cashout-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        sum: 2000.0
      },
      url: '/1/retaildrawercashout'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.strictEqual(res.rawResult.operationType, OperationType.WITHDRAW);
  });

  // UC-11: X-отчёт
  await test('UC-11: Local X-report produced without shift close', async () => {
    const op = {
      operationId: 'x-op-1',
      providerCode: 'SMARTDEV',
      providerAccountId: 'local',
      externalOperationId: 'x-1',
      operationType: OperationType.X_REPORT,
      storeId: 'local',
      createdAt: new Date().toISOString()
    };
    const res = await agent.executeOperation(op);
    assert.strictEqual(res.success, true);
    const state = await fpoMock.getStateShift();
    assert.strictEqual(state.shiftStatus, 'OPEN');
  });

  // UC-13: Закрытие смены при ненулевом остатке (проверяем блокировку перед UC-12)
  await test('UC-13: Shift close with non-zero cash in drawer blocked with DRAWER_NOT_EMPTY', async () => {
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        retailShift: { meta: { id: 'shift-close-attempt' } },
        retailStore: { meta: { id: TEST_STORE } }
      },
      url: '/1/closeshift'
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.rawResult.success, false);
    assert.strictEqual(res.rawResult.error.code, 'DRAWER_NOT_EMPTY');
  });

  // UC-12: Успешное закрытие смены (после обнуления кассы)
  await test('UC-12: Successful shift close with zero balance returns Z-report', async () => {
    const cashState = await fpoMock.getCashTransaction();
    if (cashState.cashSum > 0) {
      await fpoMock.withdraw({ sum: cashState.cashSum });
    }
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        retailShift: { meta: { id: 'shift-close-success' } },
        retailStore: { meta: { id: TEST_STORE } }
      },
      url: '/1/closeshift'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.ok(res.rawResult.chequesTotal !== undefined);
  });

  // Re-open shift for remaining error recovery tests
  await fpoMock.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
  await fpoMock.auth({ rnm: TEST_RNM });
  await fpoMock.openShift();

  // UC-14: Недоступность ФПО до отправки
  await test('UC-14: FPO offline before send fails safely without duplicate document', async () => {
    fpoMock.updateConfig({ simulateFpoOffline: true });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-offline-test' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест', price: 10, quantity: 1, cost: 10 }],
        cashSum: 10,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.rawResult.success, false);
    fpoMock.updateConfig({ simulateFpoOffline: false });
  });

  // UC-15: Таймаут после отправки документа в ФПО
  await test('UC-15: Timeout after send sets status UNKNOWN and blocks blind retry', async () => {
    fpoMock.updateConfig({ simulateTimeoutOnReceipt: true });
    const res1 = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-unknown-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест', price: 50, quantity: 1, cost: 50 }],
        cashSum: 50,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res1.statusCode, 504);
    assert.strictEqual(res1.rawResult.status, OperationStatus.UNKNOWN);

    // Blind retry blocked
    const res2 = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-unknown-1' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест', price: 50, quantity: 1, cost: 50 }],
        cashSum: 50,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res2.statusCode, 504);
    assert.strictEqual(res2.rawResult.error.code, 'OPERATION_STATUS_UNKNOWN');
  });

  // UC-16: Автоматическая обработка 40417 NOT_VERIFY_PIN
  await test('UC-16: Auto-recovery for 40417 NOT_VERIFY_PIN', async () => {
    fpoMock.updateConfig({ simulate40417Once: true });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-40417-rec' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест 40417', price: 20, quantity: 1, cost: 20 }],
        cashSum: 20,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
  });

  // UC-17: Автоматическая повторная авторизация 4011
  await test('UC-17: Auto-recovery for 4011 REAUTHORIZATION_REQUIRED', async () => {
    fpoMock.updateConfig({ simulate4011Once: true });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-4011-rec' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест 4011', price: 30, quantity: 1, cost: 30 }],
        cashSum: 30,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
  });

  // UC-18: Повтор идентичного запроса МоегоСклада
  await test('UC-18: Duplicate request returns cached result without invoking FPO', async () => {
    const reqBody = {
      demand: { meta: { id: 'demand-idemp-18' } },
      retailStore: { meta: { id: TEST_STORE } },
      positions: [{ name: 'Тест 18', price: 40, quantity: 1, cost: 40 }],
      cashSum: 40,
      cardSum: 0
    };
    const res1 = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: reqBody,
      url: '/1/retaildemand'
    });
    assert.strictEqual(res1.statusCode, 200);
    const fd1 = res1.rawResult.fiscalDocNumber;
    const logLen = fpoMock.operationLog.length;

    const res2 = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: reqBody,
      url: '/1/retaildemand'
    });
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.rawResult.fiscalDocNumber, fd1);
    assert.strictEqual(fpoMock.operationLog.length, logLen); // 0 additional calls to FPO
  });

  // UC-19: Активация лицензии модуля
  await test('UC-19: License module activation and seat generation', async () => {
    const reg = await licSrv.register({
      activationCode: 'ACT-KR-FPO-8888',
      moduleCode: 'FPO_INTEGRATION',
      agentId: 'AGENT-TEST-UC19',
      hardwareId: 'HWID-TEST-UC19',
      providerCode: 'MOYSKLAD',
      providerAccountId: 'acc-uc19'
    });
    assert.strictEqual(reg.success, true);
    assert.ok(reg.deviceToken);
  });

  // UC-20: Offline Grace Window
  await test('UC-20: Operation permitted under 24h offline grace window', async () => {
    const offlineLic = new LicenseClient('AGENT-UC20', {
      async register() { throw new Error('503'); },
      async verify() { throw new Error('503'); },
      async heartbeat() { throw new Error('503'); }
    }, 'HWID-UC20');
    offlineLic.loadCache({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'tok',
      agentId: 'AGENT-UC20',
      hardwareId: 'HWID-UC20',
      entitlements: {
        active: true,
        paid: true,
        blocked: false,
        maxAgents: 5,
        maxRnms: 5,
        allowedProviders: ['MOYSKLAD'],
        expiresAt: new Date(Date.now() + 100000000).toISOString(),
        offlineLimitHours: 24
      },
      lastLicenseOk: new Date().toISOString(),
      cachedAt: new Date().toISOString()
    });
    const chk = await offlineLic.checkEntitlement();
    assert.strictEqual(chk.allowed, true);
    assert.strictEqual(chk.inGrace, true);
  });

  // UC-21: Лицензия заблокирована или не оплачена
  await test('UC-21: Blocked license immediately prevents new fiscal operations', async () => {
    licSrv.updateLicense('LIC-SMARTDEV-TEST-001', {
      entitlements: {
        ...licSrv.getLicense('LIC-SMARTDEV-TEST-001').entitlements,
        blocked: true
      }
    });
    const res = await orch.handleFiscalRequest('MOYSKLAD', {
      headers: { 'x-lognex-fiscal-account-id': TEST_ACC },
      body: {
        demand: { meta: { id: 'demand-blocked-e2e' } },
        retailStore: { meta: { id: TEST_STORE } },
        positions: [{ name: 'Тест', price: 10, quantity: 1, cost: 10 }],
        cashSum: 10,
        cardSum: 0
      },
      url: '/1/retaildemand'
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.rawResult.error.code, 'LICENSE_BLOCKED');
    // Unblock for next test
    licSrv.updateLicense('LIC-SMARTDEV-TEST-001', {
      entitlements: {
        ...licSrv.getLicense('LIC-SMARTDEV-TEST-001').entitlements,
        blocked: false
      }
    });
  });

  // UC-22: Изменение оборудования (HWID mismatch & rebind)
  await test('UC-22: Hardware mismatch blocked until admin authorized rebind', async () => {
    const pirated = new LicenseClient(TEST_AGENT, licTransport, 'HWID-COPIED-POS-99');
    pirated.loadCache({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      deviceToken: 'tok',
      agentId: TEST_AGENT,
      hardwareId: TEST_HWID, // Mismatched!
      entitlements: licSrv.getLicense('LIC-SMARTDEV-TEST-001').entitlements,
      lastLicenseOk: new Date().toISOString(),
      cachedAt: new Date().toISOString()
    });
    const chkPirated = await pirated.checkEntitlement();
    assert.strictEqual(chkPirated.allowed, false);
    assert.strictEqual(chkPirated.errorCode, 'HARDWARE_MISMATCH');

    await licSrv.rebind({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      agentId: TEST_AGENT,
      newHardwareId: 'HWID-COPIED-POS-99',
      authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
    });
    pirated.loadCache({
      ...pirated.getCachedData(),
      hardwareId: 'HWID-COPIED-POS-99'
    });
    const chkRebound = await pirated.checkEntitlement();
    assert.strictEqual(chkRebound.allowed, true);

    // Rebind back to original TEST_HWID for subsequent tests
    await licSrv.rebind({
      licenseKey: 'LIC-SMARTDEV-TEST-001',
      agentId: TEST_AGENT,
      newHardwareId: TEST_HWID,
      authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
    });
  });

  // UC-23: Смена внешней системы без переписывания Core
  await test('UC-23: Swapping provider to MOCK / 1C without modifying core/, fpo/, licensing/, agent/', async () => {
    const res = await orch.handleFiscalRequest('MOCK', {
      headers: { 'x-mock-account-id': 'acc-1c-tenant' },
      body: {
        externalId: '1c-sale-001',
        type: 'SALE',
        items: [{ name: 'Товар 1С / Frontol / Paloma', price: 500, quantity: 1, cost: 500 }],
        payments: [{ method: 'CASH', sum: 500 }],
        totalSum: 500
      }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.rawResult.success, true);
    assert.strictEqual(res.rawResult.providerCode, 'MOCK');
    assert.ok(res.rawResult.fiscalDocNumber);
    assert.strictEqual(res.rawResult.receipt.format, 'RAW_TEXT');
  });

  console.log('\n======================================================================');
  console.log(`🎉 ALL TESTS COMPLETED: ${passedCount} / ${totalCount} PASSED!`);
  console.log('======================================================================\n');
}

runAll().catch((err) => {
  console.error('💥 Test Suite execution encountered fatal error:', err);
  process.exit(1);
});
