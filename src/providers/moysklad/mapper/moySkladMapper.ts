import {
  NormalizedFiscalOperation,
  FiscalResult,
  OperationType,
  PaymentMethod,
  VatRate,
  SalesTaxRate,
  FiscalItem
} from '../../../core/operations/types';

export class MoySkladMapper {
  /**
   * Translates incoming Fiscal API 1.0 request into NormalizedFiscalOperation
   */
  public mapToNormalized(
    endpoint: string,
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown>
  ): NormalizedFiscalOperation {
    const accountId = (headers['x-lognex-fiscal-account-id'] as string) || (body.accountId as string) || 'unknown-account';
    const cleanEndpoint = endpoint.toLowerCase().split('?')[0];

    // Determine operation type
    if (cleanEndpoint.includes('/openshift')) {
      return this.mapOpenShift(accountId, body);
    }
    if (cleanEndpoint.includes('/retaildemand')) {
      return this.mapSale(accountId, body);
    }
    if (cleanEndpoint.includes('/retaisalesreturn') || cleanEndpoint.includes('/retailsalesreturn')) {
      return this.mapReturn(accountId, body);
    }
    if (cleanEndpoint.includes('/retaildrawercashin')) {
      return this.mapDeposit(accountId, body);
    }
    if (cleanEndpoint.includes('/retaildrawercashout')) {
      return this.mapWithdraw(accountId, body);
    }
    if (cleanEndpoint.includes('/closeshift')) {
      return this.mapCloseShift(accountId, body);
    }

    throw new Error(`Unsupported MoySklad Fiscal API endpoint: ${endpoint}`);
  }

  private mapOpenShift(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const shift = (body.retailShift as Record<string, unknown>) || {};
    const meta = (shift.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || `shift-${Date.now()}`;
    const storeMeta = (body.retailStore as Record<string, unknown>)?.meta as Record<string, unknown>;
    const storeId = (storeMeta?.id as string) || (body.retailStoreId as string) || 'default-store';

    return {
      operationId: `ms-open-${externalId}`,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      externalOperationId: externalId,
      operationType: OperationType.OPEN_SHIFT,
      storeId,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  private mapSale(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const demand = (body.demand as Record<string, unknown>) || {};
    const meta = (demand.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || (body.id as string) || `demand-${Date.now()}`;

    const store = (body.retailStore as Record<string, unknown>) || {};
    const storeMeta = (store.meta as Record<string, unknown>) || {};
    const storeId = (storeMeta.id as string) || (body.retailStoreId as string) || 'default-store';

    const cashierObj = (body.cashier as Record<string, unknown>) || {};
    const cashier = {
      name: (cashierObj.name as string) || (cashierObj.description as string) || 'Кассир',
      inn: (cashierObj.inn as string) || undefined
    };

    const rawPositions = (body.positions as Array<Record<string, unknown>>) || [];
    const items: FiscalItem[] = rawPositions.map((pos) => {
      const assortment = (pos.assortment as Record<string, unknown>) || {};
      const name = (assortment.name as string) || (pos.name as string) || 'Товар';
      
      // Handle prices in cents/kopecks (divide by 100 if integer >= 1000 and priceUnit indicates cents)
      const rawPrice = Number(pos.price || 0);
      const rawCost = Number(pos.cost || (rawPrice * Number(pos.quantity || 1)));
      const quantity = Number(pos.quantity || 1);

      // Taxes
      const vatNum = Number(pos.vat);
      let vatRate: VatRate = VatRate.VAT_0;
      if (vatNum === 12) vatRate = VatRate.VAT_12;
      else if (isNaN(vatNum) || vatNum === 0) vatRate = VatRate.VAT_0;

      // Custom attributes for ST & CalcItemAttribute
      const stNum = Number(pos.salesTax || pos.st || 0);
      let salesTaxRate: SalesTaxRate = SalesTaxRate.ST_0;
      if (stNum === 1) salesTaxRate = SalesTaxRate.ST_1;
      else if (stNum === 2) salesTaxRate = SalesTaxRate.ST_2;
      else if (stNum === 3) salesTaxRate = SalesTaxRate.ST_3;
      else if (stNum === 5) salesTaxRate = SalesTaxRate.ST_5;

      const calcItemAttributeCode = pos.calcItemAttributeCode ? Number(pos.calcItemAttributeCode) : 1;
      const sgtin = (pos.trackingCode as string) || (pos.sgtin as string) || (pos.gln as string);

      return {
        name,
        price: rawPrice,
        quantity,
        totalSum: rawCost,
        tax: {
          vatRate,
          salesTaxRate
        },
        calcItemAttributeCode,
        sgtin,
        measureUnit: (pos.measureUnit as string) || 'шт'
      };
    });

    const cashSum = Number(body.cashSum || 0);
    const cardSum = Number(body.cardSum || 0);
    const qrSum = Number(body.qrSum || 0);
    const prepaySum = Number(body.prepaySum || 0);

    const payments = [];
    if (cashSum > 0) payments.push({ method: PaymentMethod.CASH, sum: cashSum });
    if (cardSum > 0) payments.push({ method: PaymentMethod.CARD, sum: cardSum });
    if (qrSum > 0) payments.push({ method: PaymentMethod.QR, sum: qrSum });
    if (prepaySum > 0) payments.push({ method: PaymentMethod.PREPAYMENT, sum: prepaySum });

    const totalSum = items.reduce((acc, it) => acc + it.totalSum, 0);
    const totalCashSum = cashSum;
    const totalCashlessSum = cardSum + qrSum + prepaySum;

    return {
      operationId: `ms-demand-${externalId}`,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      externalOperationId: externalId,
      operationType: OperationType.SALE,
      storeId,
      cashier,
      items,
      payments,
      totalSum: totalSum > 0 ? totalSum : (totalCashSum + totalCashlessSum),
      totalCashSum,
      totalCashlessSum,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  private mapReturn(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const salesReturn = (body.salesReturn as Record<string, unknown>) || {};
    const meta = (salesReturn.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || (body.id as string) || `return-${Date.now()}`;

    const demand = (body.demand as Record<string, unknown>) || {};
    const originDemandId = (demand.meta as Record<string, unknown>)?.id as string;

    const store = (body.retailStore as Record<string, unknown>) || {};
    const storeMeta = (store.meta as Record<string, unknown>) || {};
    const storeId = (storeMeta.id as string) || (body.retailStoreId as string) || 'default-store';

    const saleOp = this.mapSale(accountId, body);

    return {
      ...saleOp,
      operationId: `ms-return-${externalId}`,
      externalOperationId: externalId,
      operationType: OperationType.RETURN,
      storeId,
      originFiscalDoc: body.originFdNumber
        ? {
            originFdNumber: Number(body.originFdNumber),
            originFnSerialNumber: (body.originFnSerialNumber as string) || 'FM9876543210'
          }
        : undefined,
      metadata: {
        originDemandId
      }
    };
  }

  private mapDeposit(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const cashIn = (body.cashIn as Record<string, unknown>) || {};
    const meta = (cashIn.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || `cashin-${Date.now()}`;
    const storeMeta = (body.retailStore as Record<string, unknown>)?.meta as Record<string, unknown>;
    const storeId = (storeMeta?.id as string) || 'default-store';
    const sum = Number(body.sum || 0);

    return {
      operationId: `ms-cashin-${externalId}`,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      externalOperationId: externalId,
      operationType: OperationType.DEPOSIT,
      storeId,
      totalSum: sum,
      totalCashSum: sum,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  private mapWithdraw(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const cashOut = (body.cashOut as Record<string, unknown>) || {};
    const meta = (cashOut.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || `cashout-${Date.now()}`;
    const storeMeta = (body.retailStore as Record<string, unknown>)?.meta as Record<string, unknown>;
    const storeId = (storeMeta?.id as string) || 'default-store';
    const sum = Number(body.sum || 0);

    return {
      operationId: `ms-cashout-${externalId}`,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      externalOperationId: externalId,
      operationType: OperationType.WITHDRAW,
      storeId,
      totalSum: sum,
      totalCashSum: sum,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  private mapCloseShift(accountId: string, body: Record<string, unknown>): NormalizedFiscalOperation {
    const shift = (body.retailShift as Record<string, unknown>) || {};
    const meta = (shift.meta as Record<string, unknown>) || {};
    const externalId = (meta.id as string) || `shift-${Date.now()}`;
    const storeMeta = (body.retailStore as Record<string, unknown>)?.meta as Record<string, unknown>;
    const storeId = (storeMeta?.id as string) || 'default-store';

    return {
      operationId: `ms-close-${externalId}`,
      providerCode: 'MOYSKLAD',
      providerAccountId: accountId,
      externalOperationId: externalId,
      operationType: OperationType.CLOSE_SHIFT,
      storeId,
      rawExternalPayload: body,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Translates Core FiscalResult to MoySklad Fiscal API 1.0 JSON response
   */
  public mapToProviderResponse(result: FiscalResult): {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  } {
    if (!result.success) {
      return {
        statusCode: result.error?.httpStatusCode || 400,
        headers: { 'Content-Type': 'application/json' },
        body: {
          errors: [
            {
              code: result.error?.code || 'FISCAL_ERROR',
              error: result.error?.message || 'Fiscal operation failed',
              details: result.error?.details
            }
          ]
        }
      };
    }

    const responseBody: Record<string, unknown> = {
      fnNumber: result.fnNumber,
      kktRegNumber: result.kktRegNumber,
      fiscalDocNumber: result.fiscalDocNumber,
      fiscalDocSign: result.fiscalDocSign,
      time: result.fiscalDateTime || new Date().toISOString()
    };

    if (result.shiftNumber !== undefined) {
      responseBody.shiftNumber = result.shiftNumber;
    }

    if (result.chequesTotal !== undefined) {
      responseBody.chequesTotal = result.chequesTotal;
    }

    if (result.fiscalDocsTotal !== undefined) {
      responseBody.fiscalDocsTotal = result.fiscalDocsTotal;
    }

    if (result.receipt?.format === 'PDF_ZIP_BASE64') {
      responseBody.receipt = result.receipt.data;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: responseBody
    };
  }
}
