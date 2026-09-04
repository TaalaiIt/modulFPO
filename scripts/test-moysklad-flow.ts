/**
 * Симуляция запроса от МойСклада для тестирования mapper
 * Запуск: npx ts-node scripts/test-moysklad-flow.ts
 */
import { MoySkladMapper } from '../src/providers/moysklad/mapper/moySkladMapper';
import { FiscalResult, OperationType, OperationStatus } from '../src/core/operations/types';

const mapper = new MoySkladMapper();

// ТЕСТ 1: Открытие смены
console.log('\n====== Тест 1: Открытие смены ======');
const openShiftBody = {
  retailShift: { meta: { id: 'shift-123', type: 'RetailShift', idType: 'native', href: 'x' } },
  name: '0001',
  retailstore: { meta: { id: 'store-001', type: 'RetailStore', idType: 'native', href: 'x' } },
  cashier: { meta: { id: 'emp-001', type: 'Employee', idType: 'native', href: 'x' }, firstName: 'Иван', lastName: 'Иванов' },
  openMoment: '2024-11-18 21:41:46'
};
const headers = { 'x-lognex-fiscal-account-id': 'test-account' };
try {
  const op = mapper.mapToNormalized('/1/openshift', headers, openShiftBody);
  console.log('OK operationType=' + op.operationType + ' externalId=' + op.externalOperationId);
} catch (e) { console.error('FAIL:', e); }

// ТЕСТ 2: Продажа
console.log('\n====== Тест 2: Продажа ======');
const saleBody = {
  meta: { id: 'sale-abc', type: 'RetailDemand', idType: 'native', href: 'x' },
  name: '12345',
  retailstore: { meta: { id: 'store-001', type: 'RetailStore', idType: 'native', href: 'x' } },
  retailShift: { meta: { id: 'shift-123', type: 'RetailShift', idType: 'native', href: 'x' } },
  moment: '2024-11-20 14:30:00',
  payments: { cashSum: '500', cardSum: '0', qrSum: '0' },
  cashier: { meta: { id: 'emp-001', type: 'Employee', idType: 'native', href: 'x' }, firstName: 'Иван', lastName: 'Иванов' },
  positions: [
    { assortment: { meta: { id: 'prod-001', type: 'Product', idType: 'native', href: 'x' }, name: 'Тест Товар' }, uom: { name: 'шт' }, quantity: 1, price: '500', discount: '0', vat: 0, vatEnabled: false }
  ]
};
try {
  const op = mapper.mapToNormalized('/1/retaildemand', headers, saleBody);
  console.log('OK operationType=' + op.operationType + ' totalSum=' + op.totalSum + ' items=' + op.items?.length);
} catch (e) { console.error('FAIL:', e); }

// ТЕСТ 3: Проверка response формата
console.log('\n====== Тест 3: Response формат ======');
const mockResult: FiscalResult = {
  success: true, operationId: 'op-001', providerCode: 'MOYSKLAD', providerAccountId: 'test',
  externalOperationId: 'sale-abc', operationType: OperationType.SALE, status: OperationStatus.SUCCESS,
  fiscalDocNumber: 12345, fiscalDocSign: '9876543210', fnNumber: 'FN123456789', kktRegNumber: '0000000000024294',
  fiscalDateTime: new Date().toISOString(), completedAt: new Date().toISOString()
};
const resp = mapper.mapToProviderResponse(mockResult);
console.log('statusCode:', resp.statusCode);
console.log('body:', JSON.stringify(resp.body));
const body = resp.body as Record<string, unknown>;
console.log('time format OK?', typeof body.time === 'string' && !body.time.includes('T') ? 'YES' : 'NO - time=' + body.time);

// ТЕСТ 4: Ошибочный ответ
console.log('\n====== Тест 4: Error response ======');
const errResult: FiscalResult = {
  success: false, operationId: 'op-002', providerCode: 'MOYSKLAD', providerAccountId: 'test',
  externalOperationId: 'sale-xyz', operationType: OperationType.SALE, status: OperationStatus.FAILED,
  error: { code: 'SAM_CARD_MISSING', message: 'SAM card not present', isRetryable: true, httpStatusCode: 400 },
  completedAt: new Date().toISOString()
};
const errResp = mapper.mapToProviderResponse(errResult);
const errBody = errResp.body as Record<string, unknown>;
const errors = errBody.errors as Array<Record<string,unknown>>;
console.log('statusCode:', errResp.statusCode);
console.log('errors[0]:', JSON.stringify(errors[0]));
console.log('code is number?', typeof errors[0].code === 'number' ? 'YES' : 'NO - type=' + typeof errors[0].code);

console.log('\n=== Все тесты завершены ===');
