import { MoySkladProviderAdapter } from '../../src/providers/moysklad/moySkladProviderAdapter';
import { OperationType, PaymentMethod, VatRate, SalesTaxRate } from '../../src/core/operations/types';

describe('MoySklad Provider Adapter Unit Tests', () => {
  let adapter: MoySkladProviderAdapter;

  beforeEach(() => {
    adapter = new MoySkladProviderAdapter();
  });

  describe('Lifecycle (Vendor API 1.0)', () => {
    it('should return SettingsRequired on initial app install (UC-01)', async () => {
      const res = await adapter.handleVendorLifecycle({
        action: 'INSTALL',
        appId: 'app-fpo-kr',
        accountId: 'acc-ms-01',
        payload: {
          access_token: 'ms_token_123',
          additional: {
            fiscalApi: {
              id: 'fiscal-reg-1',
              token: 'PUBLIC_RSA_KEY_OR_TOKEN'
            }
          }
        }
      });

      expect(res.status).toBe('SettingsRequired');
      expect(adapter.security.getInstallation('acc-ms-01')).toBeDefined();
    });

    it('should transition to Activated after store settings are saved (UC-01)', async () => {
      await adapter.handleVendorLifecycle({
        action: 'INSTALL',
        appId: 'app-fpo-kr',
        accountId: 'acc-ms-02',
        payload: { access_token: 'ms_token_456' }
      });

      const res = await adapter.handleVendorLifecycle({
        action: 'SETTINGS_UPDATE',
        appId: 'app-fpo-kr',
        accountId: 'acc-ms-02',
        payload: {
          storeId: 'store-bishkek-1',
          agentId: 'agent-pc-01',
          rnm: '000123456789',
          paperWidthMm: 80
        }
      });

      expect(res.status).toBe('Activated');
    });
  });

  describe('Mapper (Fiscal API 1.0)', () => {
    it('should map MoySklad retaildemand to NormalizedFiscalOperation (UC-05, UC-06, UC-07)', async () => {
      const rawBody = {
        demand: {
          meta: {
            href: 'https://api.moysklad.ru/api/remap/1.2/entity/retaildemand/demand-999',
            id: 'demand-999'
          }
        },
        retailStore: {
          meta: {
            href: 'https://api.moysklad.ru/api/remap/1.2/entity/retailstore/store-1',
            id: 'store-1'
          }
        },
        cashier: {
          name: 'Асанов Асан'
        },
        positions: [
          {
            name: 'Молоко Домик в деревне 3.2%',
            price: 85.0,
            quantity: 2,
            cost: 170.0,
            vat: 12,
            salesTax: 1,
            calcItemAttributeCode: 1,
            trackingCode: '010460000000000021xyz...'
          }
        ],
        cashSum: 70.0,
        cardSum: 100.0,
        qrSum: 0,
        prepaySum: 0
      };

      const normalized = await adapter.mapToNormalized({
        headers: {
          'x-lognex-fiscal-account-id': 'acc-ms-01'
        },
        body: rawBody,
        url: '/1/retaildemand'
      });

      expect(normalized.providerCode).toBe('MOYSKLAD');
      expect(normalized.providerAccountId).toBe('acc-ms-01');
      expect(normalized.externalOperationId).toBe('demand-999');
      expect(normalized.operationType).toBe(OperationType.SALE);
      expect(normalized.storeId).toBe('store-1');
      expect(normalized.totalSum).toBe(170.0);
      expect(normalized.totalCashSum).toBe(70.0);
      expect(normalized.totalCashlessSum).toBe(100.0);
      expect(normalized.items?.[0].tax?.vatRate).toBe(VatRate.VAT_12);
      expect(normalized.items?.[0].tax?.salesTaxRate).toBe(SalesTaxRate.ST_1);
      expect(normalized.items?.[0].sgtin).toBe('010460000000000021xyz...');
    });
  });

  describe('Receipt Generator (PDF -> ZIP -> Base64)', () => {
    it('should generate PDF packed in ZIP encoded in Base64 (UC-02, UC-05, UC-12)', async () => {
      const op = {
        operationId: 'op-rcpt-1',
        providerCode: 'MOYSKLAD',
        providerAccountId: 'acc-1',
        externalOperationId: 'doc-1',
        operationType: OperationType.SALE,
        storeId: 'store-1',
        totalSum: 100,
        totalCashSum: 100,
        items: [{ name: 'Тестовый товар', price: 100, quantity: 1, totalSum: 100 }],
        createdAt: new Date().toISOString()
      };

      const fiscalResult = {
        fiscalDocNumber: 1234,
        fiscalDocSign: 'FPD-1234-XYZ',
        kktRegNumber: '000123456789',
        fnNumber: 'FM9876543210',
        fiscalDateTime: new Date().toISOString()
      };

      const receipt = await adapter.generateReceiptData(op, fiscalResult, { paperWidthMm: 80 });
      expect(receipt.format).toBe('PDF_ZIP_BASE64');
      expect(receipt.data).toBeDefined();
      expect(typeof receipt.data).toBe('string');
      expect(receipt.data.length).toBeGreaterThan(50);
    });
  });
});
