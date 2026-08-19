import { IntegrationOrchestrator } from '../../src/core/orchestrator';
import { MoySkladProviderAdapter } from '../../src/providers/moysklad/moySkladProviderAdapter';
import { MockProviderAdapter } from '../../src/providers/mock/mockProviderAdapter';
import { MockFiscalConnector } from '../../src/fpo/mock/mockFiscalConnector';
import { LicenseServer } from '../../src/licensing/server/licenseServer';
import { LicenseClient } from '../../src/licensing/client/licenseClient';
import { SecureLocalStorage } from '../../src/agent/secureStorage';
import { AgentService } from '../../src/agent/agentService';
import { OperationType, OperationStatus } from '../../src/core/operations/types';

describe('SmartDev FPO Integration — End-to-End Use Cases Suite (UC-01 .. UC-23)', () => {
  let orchestrator: IntegrationOrchestrator;
  let licenseServer: LicenseServer;
  let mockFpo: MockFiscalConnector;
  let msAdapter: MoySkladProviderAdapter;
  let mockAdapter: MockProviderAdapter;
  let agentStorage: SecureLocalStorage;
  let licenseClient: LicenseClient;
  let agentService: AgentService;

  const TEST_ACCOUNT_ID = 'acc-ms-test-001';
  const TEST_STORE_ID = 'store-bishkek-main';
  const TEST_AGENT_ID = 'AGENT-BISHKEK-01';
  const TEST_RNM = '000123456789';
  const TEST_PIN = '1234';
  const TEST_HWID = 'HWID-BISHKEK-POS-01';

  beforeEach(async () => {
    orchestrator = new IntegrationOrchestrator();
    licenseServer = new LicenseServer();
    mockFpo = new MockFiscalConnector({ rnm: TEST_RNM, correctPin: TEST_PIN });
    agentStorage = new SecureLocalStorage();

    // License transport connecting Client to in-memory Server
    const licenseTransport = {
      async register(req: any) { return licenseServer.register(req); },
      async verify(req: any) { return licenseServer.verify(req); },
      async heartbeat(req: any) { return licenseServer.heartbeat(req); }
    };

    licenseClient = new LicenseClient(TEST_AGENT_ID, licenseTransport, TEST_HWID, orchestrator.auditLogger);
    agentService = new AgentService(TEST_AGENT_ID, mockFpo, licenseClient, agentStorage, orchestrator.auditLogger);

    // Register provider adapters
    msAdapter = new MoySkladProviderAdapter(orchestrator.auditLogger);
    mockAdapter = new MockProviderAdapter();
    orchestrator.providerRegistry.register(msAdapter);
    orchestrator.providerRegistry.register(mockAdapter);

    // Direct dispatch handler for tests
    orchestrator.setDirectDispatchHandler(async (op: any) => {
      return agentService.executeOperation(op);
    });

    // Seed agent local credentials
    agentStorage.saveSecrets({
      agentId: TEST_AGENT_ID,
      rnm: TEST_RNM,
      pin: TEST_PIN,
      fpoLogin: 'smartdev_user',
      fpoPassword: 'smartdev_password'
    });

    // Activate License (UC-19)
    await licenseClient.activate('ACT-KR-FPO-8888', 'MOYSKLAD', TEST_ACCOUNT_ID, TEST_RNM);
  });

  // =========================================================================
  // UC-01: Установка и настройка решения
  // =========================================================================
  describe('UC-01: Installation and Configuration Lifecycle', () => {
    it('should complete full app installation, pairing, diagnostics, and activation', async () => {
      // 1. Vendor API Install
      const installRes = await msAdapter.handleVendorLifecycle({
        action: 'INSTALL',
        appId: 'app-smartdev-fpo',
        accountId: TEST_ACCOUNT_ID,
        payload: {
          access_token: 'ms_access_token_val',
          additional: {
            fiscalApi: {
              id: 'fiscal-api-inst-01',
              token: 'PUBLIC_RSA_KEY_MOCK'
            }
          }
        }
      });
      expect(installRes.status).toBe('SettingsRequired');

      // 2. Local Agent Diagnostics
      const diag = await agentService.runDiagnostics();
      expect(diag.healthy).toBe(true);
      expect(diag.samCardPresent).toBe(true);
      expect(diag.pinVerified).toBe(true);

      // 3. Settings update in MoySklad -> link store to Agent
      const settingsRes = await msAdapter.handleVendorLifecycle({
        action: 'SETTINGS_UPDATE',
        appId: 'app-smartdev-fpo',
        accountId: TEST_ACCOUNT_ID,
        payload: {
          storeId: TEST_STORE_ID,
          agentId: TEST_AGENT_ID,
          rnm: TEST_RNM,
          paperWidthMm: 80
        }
      });
      expect(settingsRes.status).toBe('Activated');

      // Register store binding in Gateway routing
      orchestrator.routingService.registerStoreBinding({
        providerCode: 'MOYSKLAD',
        providerAccountId: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        agentId: TEST_AGENT_ID,
        rnm: TEST_RNM,
        paperWidthMm: 80,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
  });

  // =========================================================================
  // UC-02: Успешное открытие смены
  // =========================================================================
  describe('UC-02: Successful Open Shift', () => {
    it('should open shift and return fiscal document + PDF receipt', async () => {
      orchestrator.routingService.registerStoreBinding({
        providerCode: 'MOYSKLAD',
        providerAccountId: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        agentId: TEST_AGENT_ID,
        rnm: TEST_RNM,
        paperWidthMm: 80,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          retailShift: { meta: { id: 'shift-001' } },
          retailStore: { meta: { id: TEST_STORE_ID } }
        },
        url: '/1/openshift'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.shiftNumber).toBeDefined();
      expect(res.rawResult.fiscalDocNumber).toBeDefined();
      expect(res.rawResult.receipt?.format).toBe('PDF_ZIP_BASE64');
    });
  });

  // =========================================================================
  // UC-03: SAM-карта отсутствует
  // =========================================================================
  describe('UC-03: SAM Card Missing', () => {
    it('should return blocking error when SAM card is missing', async () => {
      mockFpo.updateConfig({ samCardPresent: false });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          retailShift: { meta: { id: 'shift-002' } },
          retailStore: { meta: { id: TEST_STORE_ID } }
        },
        url: '/1/openshift'
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResult.success).toBe(false);
      expect(res.rawResult.error?.code).toBe('SAM_CARD_MISSING');
    });
  });

  // =========================================================================
  // UC-04: Нет интернета при открытии смены
  // =========================================================================
  describe('UC-04: Internet Unavailable on Open Shift', () => {
    it('should return network connection error when GNS auth fails', async () => {
      mockFpo.updateConfig({ simulateAuthNetworkFailure: true });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          retailShift: { meta: { id: 'shift-003' } },
          retailStore: { meta: { id: TEST_STORE_ID } }
        },
        url: '/1/openshift'
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResult.success).toBe(false);
      expect(res.rawResult.error?.code).toBe('FPO_40801');
    });
  });

  // =========================================================================
  // UC-05: Продажа за наличные
  // =========================================================================
  describe('UC-05: Cash Sale', () => {
    it('should fiscalize cash sale with totalCashSum and return receipt', async () => {
      // Ensure shift is open
      const shiftState = await mockFpo.getStateShift();
      if (shiftState.shiftStatus !== 'OPEN') {
        await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
        await mockFpo.auth({ rnm: TEST_RNM });
        await mockFpo.openShift();
      }

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-cash-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          cashier: { name: 'Кассир 1' },
          positions: [
            {
              name: 'Товар Наличные',
              price: 150.0,
              quantity: 1,
              cost: 150.0,
              vat: 12,
              salesTax: 1
            }
          ],
          cashSum: 150.0,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.fiscalDocNumber).toBeDefined();
      expect(res.rawResult.receipt?.data).toBeDefined();
    });
  });

  // =========================================================================
  // UC-06: Продажа банковской картой
  // =========================================================================
  describe('UC-06: Card Sale', () => {
    it('should fiscalize cashless card sale with totalCashlessSum', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-card-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Товар Карта', price: 300.0, quantity: 1, cost: 300.0 }],
          cashSum: 0,
          cardSum: 300.0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.fiscalDocNumber).toBeDefined();
    });
  });

  // =========================================================================
  // UC-07: Смешанная оплата наличными, картой или QR
  // =========================================================================
  describe('UC-07: Mixed Payment Sale', () => {
    it('should handle cash + card + QR payments correctly', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-mixed-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Смешанный Товар', price: 500.0, quantity: 1, cost: 500.0 }],
          cashSum: 200.0,
          cardSum: 200.0,
          qrSum: 100.0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
    });
  });

  // =========================================================================
  // UC-08: Возврат продажи
  // =========================================================================
  describe('UC-08: Return Sale', () => {
    it('should fiscalize return referencing original sale fiscal doc', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          salesReturn: { meta: { id: 'return-01' } },
          demand: { meta: { id: 'demand-cash-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          originFdNumber: 101,
          originFnSerialNumber: 'FM9876543210',
          positions: [{ name: 'Возврат товара', price: 150.0, quantity: 1, cost: 150.0 }],
          cashSum: 150.0,
          cardSum: 0
        },
        url: '/1/retaisalesreturn'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.operationType).toBe(OperationType.RETURN);
    });
  });

  // =========================================================================
  // UC-09: Внесение наличных
  // =========================================================================
  describe('UC-09: Cash Deposit', () => {
    it('should record cash deposit transaction', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          cashIn: { meta: { id: 'cashin-001' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          sum: 5000.0
        },
        url: '/1/retaildrawercashin'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.operationType).toBe(OperationType.DEPOSIT);
    });
  });

  // =========================================================================
  // UC-10: Выплата наличных
  // =========================================================================
  describe('UC-10: Cash Withdrawal', () => {
    it('should record cash withdrawal transaction', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      // First deposit cash so drawer has balance
      await mockFpo.deposit({ sum: 3000 });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          cashOut: { meta: { id: 'cashout-001' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          sum: 2000.0
        },
        url: '/1/retaildrawercashout'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.operationType).toBe(OperationType.WITHDRAW);
    });
  });

  // =========================================================================
  // UC-11: X-отчёт
  // =========================================================================
  describe('UC-11: Local X-Report', () => {
    it('should produce local X-report without closing shift', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const op = {
        operationId: 'op-x-01',
        providerCode: 'SMARTDEV_LOCAL',
        providerAccountId: 'local',
        externalOperationId: 'x-01',
        operationType: OperationType.X_REPORT,
        storeId: 'local',
        createdAt: new Date().toISOString()
      };

      const result = await agentService.executeOperation(op);
      expect(result.success).toBe(true);
      expect(result.shiftNumber).toBeDefined();

      // Verify shift is still OPEN
      const state = await mockFpo.getStateShift();
      expect(state.shiftStatus).toBe('OPEN');
    });
  });

  // =========================================================================
  // UC-12: Успешное закрытие смены (нулевой остаток)
  // =========================================================================
  describe('UC-12: Successful Shift Close', () => {
    it('should close shift and return Z-report with chequesTotal and fiscalDocsTotal', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          retailShift: { meta: { id: 'shift-close-001' } },
          retailStore: { meta: { id: TEST_STORE_ID } }
        },
        url: '/1/closeshift'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.chequesTotal).toBeDefined();
      expect(res.rawResult.fiscalDocsTotal).toBeDefined();
    });
  });

  // =========================================================================
  // UC-13: Закрытие смены при ненулевом остатке
  // =========================================================================
  describe('UC-13: Shift Close with Non-Zero Cash Drawer Balance', () => {
    it('should block shift closure with error DRAWER_NOT_EMPTY if cash remains in drawer', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      // Make cash sale leaving cash in drawer
      await mockFpo.createReceipt({
        operationType: 'INCOME',
        items: [{ name: 'Тест', price: 500, quantity: 1, cost: 500 }],
        totalCashSum: 500,
        totalCashlessSum: 0
      });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          retailShift: { meta: { id: 'shift-close-non-zero' } },
          retailStore: { meta: { id: TEST_STORE_ID } }
        },
        url: '/1/closeshift'
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResult.success).toBe(false);
      expect(res.rawResult.error?.code).toBe('DRAWER_NOT_EMPTY');
    });
  });

  // =========================================================================
  // UC-14: Недоступность ФПО до отправки документа
  // =========================================================================
  describe('UC-14: FPO Unavailable Before Send', () => {
    it('should safely return connection error without creating phantom document', async () => {
      mockFpo.updateConfig({ simulateFpoOffline: true });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-offline-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест', price: 100, quantity: 1, cost: 100 }],
          cashSum: 100,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(503);
      expect(res.rawResult.success).toBe(false);
    });
  });

  // =========================================================================
  // UC-15: Таймаут после отправки документа в ФПО
  // =========================================================================
  describe('UC-15: Timeout After Send to FPO (UNKNOWN status)', () => {
    it('should set status UNKNOWN and prevent duplicate blind resend', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      mockFpo.updateConfig({ simulateTimeoutOnReceipt: true });

      // 1. First attempt times out after send
      const res1 = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-timeout-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест', price: 250, quantity: 1, cost: 250 }],
          cashSum: 250,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res1.statusCode).toBe(504);
      expect(res1.rawResult.status).toBe(OperationStatus.UNKNOWN);

      // 2. MoySklad retries blindly -> must be REJECTED to prevent duplicate document!
      const res2 = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-timeout-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест', price: 250, quantity: 1, cost: 250 }],
          cashSum: 250,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res2.statusCode).toBe(504);
      expect(res2.rawResult.error?.code).toBe('OPERATION_STATUS_UNKNOWN');
    });
  });

  // =========================================================================
  // UC-16: Автоматическая обработка 40417 NOT_VERIFY_PIN
  // =========================================================================
  describe('UC-16: Automatic Recovery for 40417 NOT_VERIFY_PIN', () => {
    it('should auto-verify PIN and successfully complete operation on retry', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      mockFpo.updateConfig({ simulate40417Once: true });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-40417-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест 40417', price: 100, quantity: 1, cost: 100 }],
          cashSum: 100,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.fiscalDocNumber).toBeDefined();
    });
  });

  // =========================================================================
  // UC-17: Автоматическая повторная авторизация 4011
  // =========================================================================
  describe('UC-17: Automatic Recovery for 4011 REAUTHORIZATION_REQUIRED', () => {
    it('should auto-reauth and successfully complete operation on retry', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      mockFpo.updateConfig({ simulate4011Once: true });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-4011-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест 4011', price: 120, quantity: 1, cost: 120 }],
          cashSum: 120,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
    });
  });

  // =========================================================================
  // UC-18: Повтор идентичного запроса МоегоСклада
  // =========================================================================
  describe('UC-18: Idempotent Duplicate Request', () => {
    it('should return cached result and receipt without calling FPO twice', async () => {
      await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
      await mockFpo.auth({ rnm: TEST_RNM });
      await mockFpo.openShift();

      const reqBody = {
        demand: { meta: { id: 'demand-dup-01' } },
        retailStore: { meta: { id: TEST_STORE_ID } },
        positions: [{ name: 'Дубликат', price: 80, quantity: 1, cost: 80 }],
        cashSum: 80,
        cardSum: 0
      };

      // First call
      const res1 = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: reqBody,
        url: '/1/retaildemand'
      });

      expect(res1.statusCode).toBe(200);
      const fd1 = res1.rawResult.fiscalDocNumber;
      const receipt1 = res1.rawResult.receipt?.data;

      // Log length before second call
      const logLenBefore = mockFpo.operationLog.length;

      // Duplicate call with exact same body
      const res2 = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: reqBody,
        url: '/1/retaildemand'
      });

      expect(res2.statusCode).toBe(200);
      expect(res2.rawResult.fiscalDocNumber).toBe(fd1);
      expect(res2.rawResult.receipt?.data).toBe(receipt1);

      // Verify FPO was NOT called second time!
      expect(mockFpo.operationLog.length).toBe(logLenBefore);
    });
  });

  // =========================================================================
  // UC-19: Активация лицензии модуля
  // =========================================================================
  describe('UC-19: License Registration & Seat Allocation', () => {
    it('should register agent seat and return device_token with entitlements', async () => {
      const regRes = await licenseServer.register({
        activationCode: 'ACT-KR-FPO-8888',
        moduleCode: 'FPO_INTEGRATION',
        agentId: 'AGENT-NEW-SEAT-01',
        hardwareId: 'HWID-NEW-SEAT-01',
        providerCode: 'MOYSKLAD',
        providerAccountId: 'acc-new-01'
      });

      expect(regRes.success).toBe(true);
      expect(regRes.licenseKey).toBe('LIC-SMARTDEV-TEST-001');
      expect(regRes.deviceToken).toBeDefined();
    });
  });

  // =========================================================================
  // UC-20: License Service временно недоступен
  // =========================================================================
  describe('UC-20: Offline Grace Window', () => {
    it('should continue operation within 24h offline grace window', async () => {
      // Setup offline transport
      const offlineClient = new LicenseClient('AGENT-GRACE-01', {
        async register() { throw new Error('Offline'); },
        async verify() { throw new Error('Server 503'); },
        async heartbeat() { throw new Error('Offline'); }
      }, 'HWID-GRACE-01');

      offlineClient.loadCache({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        deviceToken: 'token',
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
        lastLicenseOk: new Date().toISOString(),
        cachedAt: new Date().toISOString()
      });

      const check = await offlineClient.checkEntitlement();
      expect(check.allowed).toBe(true);
      expect(check.inGrace).toBe(true);
    });
  });

  // =========================================================================
  // UC-21: Лицензия заблокирована или не оплачена
  // =========================================================================
  describe('UC-21: Blocked or Unpaid License', () => {
    it('should block new fiscal operations when license is blocked', async () => {
      licenseServer.updateLicense('LIC-SMARTDEV-TEST-001', {
        entitlements: {
          ...licenseServer.getLicense('LIC-SMARTDEV-TEST-001')!.entitlements,
          blocked: true
        }
      });

      const res = await orchestrator.handleFiscalRequest('MOYSKLAD', {
        headers: { 'x-lognex-fiscal-account-id': TEST_ACCOUNT_ID },
        body: {
          demand: { meta: { id: 'demand-blocked-01' } },
          retailStore: { meta: { id: TEST_STORE_ID } },
          positions: [{ name: 'Тест', price: 100, quantity: 1, cost: 100 }],
          cashSum: 100,
          cardSum: 0
        },
        url: '/1/retaildemand'
      });

      expect(res.statusCode).toBe(403);
      expect(res.rawResult.success).toBe(false);
      expect(res.rawResult.error?.code).toBe('LICENSE_BLOCKED');
    });
  });

  // =========================================================================
  // UC-22: Изменение оборудования (HWID mismatch & rebind)
  // =========================================================================
  describe('UC-22: Hardware Mismatch Detection & Rebind', () => {
    it('should reject copied agent on different HWID until rebind', async () => {
      // Create agent with pirated/copied HWID
      const piratedClient = new LicenseClient(TEST_AGENT_ID, {
        async register(req) { return licenseServer.register(req); },
        async verify(req) { return licenseServer.verify(req); },
        async heartbeat(req) { return licenseServer.heartbeat(req); }
      }, 'HWID-COPIED-MACHINE-99');

      piratedClient.loadCache({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        deviceToken: 'token',
        agentId: TEST_AGENT_ID,
        hardwareId: TEST_HWID, // Original HWID in cache, but current is HWID-COPIED
        entitlements: licenseServer.getLicense('LIC-SMARTDEV-TEST-001')!.entitlements,
        lastLicenseOk: new Date().toISOString(),
        cachedAt: new Date().toISOString()
      });

      const checkPirated = await piratedClient.checkEntitlement();
      expect(checkPirated.allowed).toBe(false);
      expect(checkPirated.errorCode).toBe('HARDWARE_MISMATCH');

      // Rebind to new machine authorized by admin
      await licenseServer.rebind({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        agentId: TEST_AGENT_ID,
        newHardwareId: 'HWID-COPIED-MACHINE-99',
        authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
      });

      // Now update client cache HWID
      piratedClient.loadCache({
        ...piratedClient.getCachedData()!,
        hardwareId: 'HWID-COPIED-MACHINE-99'
      });

      const checkAfterRebind = await piratedClient.checkEntitlement();
      expect(checkAfterRebind.allowed).toBe(true);

      // Rebind back to original TEST_HWID
      await licenseServer.rebind({
        licenseKey: 'LIC-SMARTDEV-TEST-001',
        agentId: TEST_AGENT_ID,
        newHardwareId: TEST_HWID,
        authSecret: 'SMARTDEV_SUPER_ADMIN_AUTH'
      });
    });
  });

  // =========================================================================
  // UC-23: Смена внешней системы без переписывания Core
  // =========================================================================
  describe('UC-23: Provider Switch Without Touching Core/FPO/Licensing/Agent', () => {
    it('should process SALE via MockProviderAdapter identically without any MoySklad dependencies', async () => {
      const shiftState = await mockFpo.getStateShift();
      if (shiftState.shiftStatus !== 'OPEN') {
        await mockFpo.verifyPin({ rnm: TEST_RNM, pin: TEST_PIN });
        await mockFpo.auth({ rnm: TEST_RNM });
        await mockFpo.openShift();
      }

      const res = await orchestrator.handleFiscalRequest('MOCK', {
        headers: {
          'x-mock-account-id': 'mock-tenant-01'
        },
        body: {
          externalId: 'mock-sale-999',
          type: 'SALE',
          items: [
            { name: 'Универсальный товар 1С / Frontol / Paloma', price: 99.0, quantity: 1, cost: 99.0 }
          ],
          payments: [{ method: 'CASH', sum: 99.0 }],
          totalSum: 99.0
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.rawResult.success).toBe(true);
      expect(res.rawResult.providerCode).toBe('MOCK');
      expect(res.rawResult.fiscalDocNumber).toBeDefined();
      expect(res.rawResult.receipt?.format).toBe('RAW_TEXT');
    });
  });
});
