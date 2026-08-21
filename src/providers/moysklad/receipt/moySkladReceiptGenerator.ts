import PDFDocument from 'pdfkit';
import AdmZip from 'adm-zip';
import QRCode from 'qrcode';
import { NormalizedFiscalOperation, FiscalResult, ReceiptData } from '../../../core/operations/types';

export interface ReceiptGenerationOptions {
  paperWidthMm?: number; // 56, 80, or 210 (A4)
  companyName?: string;
  companyAddress?: string;
  companyInn?: string;
}

export class MoySkladReceiptGenerator {
  /**
   * Generates PDF -> ZIP -> Base64 receipt payload for MoySklad Fiscal API 1.0
   */
  public async generateReceipt(
    operation: NormalizedFiscalOperation,
    fiscalResult: Partial<FiscalResult>,
    options?: ReceiptGenerationOptions
  ): Promise<ReceiptData> {
    const paperWidth = options?.paperWidthMm || 80;
    const pdfBuffer = await this.renderPdf(operation, fiscalResult, options, paperWidth);

    // Compress PDF into ZIP
    const zip = new AdmZip();
    zip.addFile('receipt.pdf', pdfBuffer);
    const zipBuffer = zip.toBuffer();

    // Encode as Base64
    const base64Data = zipBuffer.toString('base64');

    return {
      format: 'PDF_ZIP_BASE64',
      data: base64Data,
      metadata: {
        paperWidthMm: paperWidth,
        pdfSizeBytes: pdfBuffer.length,
        zipSizeBytes: zipBuffer.length
      }
    };
  }

  private async renderPdf(
    operation: NormalizedFiscalOperation,
    fiscalResult: Partial<FiscalResult>,
    options?: ReceiptGenerationOptions,
    paperWidthMm = 80
  ): Promise<Buffer> {
    const qrCodeBuffer = fiscalResult.qrCodeUrl
      ? await QRCode.toBuffer(fiscalResult.qrCodeUrl, { errorCorrectionLevel: 'M', margin: 1, width: 160 })
      : undefined;

    return new Promise((resolve, reject) => {
        // 1 mm ~= 2.83465 points in PDF
        const widthPoints = paperWidthMm * 2.83465;
        const heightPoints = paperWidthMm >= 200 ? 842 : 400; // A4 height or thermal roll default

        const doc = new PDFDocument({
          size: [widthPoints, heightPoints],
          margins: { top: 10, bottom: 10, left: 10, right: 10 }
        });

        const chunks: Buffer[] = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const titleFontSize = paperWidthMm === 56 ? 8 : 10;
        const bodyFontSize = paperWidthMm === 56 ? 6 : 8;

        // Header
        doc.fontSize(titleFontSize).text(options?.companyName || 'ОсОО «Смартдев»', { align: 'center' });
        if (options?.companyInn) {
        doc.fontSize(bodyFontSize).text(`ИНН: ${options.companyInn}`, { align: 'center' });
        }
        if (options?.companyAddress) {
        doc.fontSize(bodyFontSize).text(options.companyAddress, { align: 'center' });
        }

        doc.moveDown(0.5);
        doc.fontSize(bodyFontSize).text('------------------------------------------------', { align: 'center' });

        // Document type
        let docTitle = 'КАССОВЫЙ ЧЕК (ПРОДАЖА)';
        if (operation.operationType === 'RETURN') docTitle = 'КАССОВЫЙ ЧЕК (ВОЗВРАТ)';
        else if (operation.operationType === 'OPEN_SHIFT') docTitle = 'ОТКРЫТИЕ СМЕНЫ';
        else if (operation.operationType === 'CLOSE_SHIFT') docTitle = 'ЗАКРЫТИЕ СМЕНЫ (Z-ОТЧЕТ)';
        else if (operation.operationType === 'DEPOSIT') docTitle = 'ВНЕСЕНИЕ НАЛИЧНЫХ';
        else if (operation.operationType === 'WITHDRAW') docTitle = 'ВЫПЛАТА НАЛИЧНЫХ';

        doc.fontSize(titleFontSize).text(docTitle, { align: 'center' });
      doc.fontSize(bodyFontSize).text(`Дата/время: ${fiscalResult.fiscalDateTime || new Date().toISOString()}`);
      if (fiscalResult.shiftNumber) {
        doc.text(`Смена: №${fiscalResult.shiftNumber}`);
      }
      if (operation.cashier?.name) {
        doc.text(`Кассир: ${operation.cashier.name}`);
      }

      doc.moveDown(0.5);
      doc.text('------------------------------------------------', { align: 'center' });

      // Items
      if (operation.items && operation.items.length > 0) {
        for (const it of operation.items) {
          doc.text(`${it.name}`);
          const taxInfo = it.tax?.vatRate ? ` [${it.tax.vatRate}]` : '';
          doc.text(`  ${it.quantity} x ${it.price.toFixed(2)} = ${it.totalSum.toFixed(2)} KGS${taxInfo}`);
          if (it.sgtin) {
            doc.text(`  [Маркировка: ${it.sgtin.substring(0, 20)}...]`);
          }
        }
        doc.moveDown(0.5);
        doc.text('------------------------------------------------', { align: 'center' });
      }

      // Totals
      if (operation.totalSum !== undefined) {
        doc.fontSize(titleFontSize).text(`ИТОГ: ${operation.totalSum.toFixed(2)} KGS`, { align: 'right' });
      }
      if (operation.totalCashSum) {
        doc.fontSize(bodyFontSize).text(`Наличными: ${operation.totalCashSum.toFixed(2)} KGS`, { align: 'right' });
      }
      if (operation.totalCashlessSum) {
        doc.fontSize(bodyFontSize).text(`Безналичными: ${operation.totalCashlessSum.toFixed(2)} KGS`, { align: 'right' });
      }

      // Shift close totals
      if (fiscalResult.chequesTotal !== undefined) {
        doc.text(`Чеков за смену: ${fiscalResult.chequesTotal}`);
      }
      if (fiscalResult.fiscalDocsTotal !== undefined) {
        doc.text(`ФД за смену: ${fiscalResult.fiscalDocsTotal}`);
      }

      doc.moveDown(0.5);
      doc.text('------------------------------------------------', { align: 'center' });

      // Fiscal credentials (ФПО)
      doc.fontSize(bodyFontSize);
      if (fiscalResult.kktRegNumber) doc.text(`РНМ ККМ: ${fiscalResult.kktRegNumber}`);
      if (fiscalResult.fnNumber) doc.text(`ЗН ФН: ${fiscalResult.fnNumber}`);
      if (fiscalResult.fiscalDocNumber) doc.text(`ФД: №${fiscalResult.fiscalDocNumber}`);
      if (fiscalResult.fiscalDocSign) doc.text(`ФПД: ${fiscalResult.fiscalDocSign}`);
      
      if (qrCodeBuffer) {
        doc.moveDown(0.5);
        doc.image(qrCodeBuffer, { fit: [56.7, 56.7], align: 'center' });
      }

      doc.text('ФИСКАЛЬНЫЙ ДОКУМЕНТ ГНС КР', { align: 'center' });
      doc.end();
    });
  }
}
