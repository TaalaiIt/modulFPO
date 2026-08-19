import { MockFiscalConnector } from '../../src/fpo/mock/mockFiscalConnector';
import { FpoRecoveryEngine } from '../../src/fpo/recovery/fpoRecoveryEngine';
import { FpoError } from '../../src/fpo/models/fpoTypes';

describe('FPO Subsystem Unit Tests', () => {
  let mockFpo: MockFiscalConnector;

  beforeEach(() => {
    mockFpo = new MockFiscalConnector();
  });

  describe('MockFiscalConnector Operations', () => {
    it('should check SAM cards and verify PIN', async () => {
      const samRes = await mockFpo.getSamCards();
      expect(samRes.samCards.length).toBeGreaterThan(0);
      expect(samRes.samCards[0].cardPresent).toBe(true);

      const pinRes = await mockFpo.verifyPin({ rnm: '000123456789', pin: '1234' });
      expect(pinRes.success).toBe(true);
    });

    it('should open shift, process income receipt, and close shift', async () => {
      await mockFpo.verifyPin({ rnm: '000123456789', pin: '1234' });
      await mockFpo.auth({ rnm: '000123456789' });

      // Open shift
      const openRes = await mockFpo.openShift({ cashier: { name: 'Иванов' } });
      expect(openRes.success).toBe(true);
      expect(openRes.fiscalDocNumber).toBeDefined();

      // Create income receipt
      const receiptRes = await mockFpo.createReceipt({
        operationType: 'INCOME',
        items: [
          {
            name: 'Хлеб Сары-Ой',
            price: 35.5,
            quantity: 2,
            cost: 71.0,
            vatRate: 'VAT_12',
            salesTaxRate: 'ST_1'
          }
        ],
        totalCashSum: 71.0,
        totalCashlessSum: 0
      });
      expect(receiptRes.success).toBe(true);
      expect(receiptRes.fiscalDocNumber).toBeDefined();
      expect(receiptRes.fiscalDocSign).toBeDefined();

      // Attempt close shift with non-zero cash -> should fail with error 40919 (UC-13)
      await expect(mockFpo.closeShift()).rejects.toThrow('Cannot close shift with non-zero cash');

      // Withdraw cash
      await mockFpo.withdraw({ sum: 71.0 });

      // Now close shift -> success (UC-12)
      const closeRes = await mockFpo.closeShift();
      expect(closeRes.success).toBe(true);
      expect(closeRes.chequesTotal).toBe(1);
    });
  });

  describe('FpoRecoveryEngine (UC-16, UC-17)', () => {
    it('should automatically recover from error 40417 NOT_VERIFY_PIN (UC-16)', async () => {
      mockFpo.updateConfig({ simulate40417Once: true });

      const credsProvider = async () => ({
        rnm: '000123456789',
        pin: '1234'
      });

      const recovery = new FpoRecoveryEngine(mockFpo, credsProvider);

      // Call createReceipt which throws 40417 on first call
      const res = await recovery.executeWithRecovery('TEST_RECEIPT', async () => {
        return mockFpo.createReceipt({
          operationType: 'INCOME',
          items: [{ name: 'Тест', price: 100, quantity: 1, cost: 100 }],
          totalCashSum: 100,
          totalCashlessSum: 0
        });
      });

      expect(res.success).toBe(true);
      expect(res.fiscalDocNumber).toBeDefined();
    });

    it('should automatically recover from error 4011 REAUTHORIZATION_REQUIRED (UC-17)', async () => {
      mockFpo.updateConfig({ simulate4011Once: true });

      const credsProvider = async () => ({
        rnm: '000123456789',
        pin: '1234'
      });

      const recovery = new FpoRecoveryEngine(mockFpo, credsProvider);

      const res = await recovery.executeWithRecovery('TEST_RECEIPT_AUTH', async () => {
        return mockFpo.createReceipt({
          operationType: 'INCOME',
          items: [{ name: 'Тест', price: 50, quantity: 1, cost: 50 }],
          totalCashSum: 50,
          totalCashlessSum: 0
        });
      });

      expect(res.success).toBe(true);
      expect(res.fiscalDocNumber).toBeDefined();
    });
  });
});
