export const MOYSKLAD_FISCAL_DESCRIPTOR = {
  apiVersion: '1.0',
  operationTypes: [
    'retailDemand',
    'openShift',
    'closeShift',
    'retailSalesReturn',
    'retailDrawerCashIn',
    'retailDrawerCashOut'
  ],
  paymentTypes: ['cash', 'card', 'cashCard', 'qr'],
  endpointBase: '/fiscal/1.0'
} as const;
