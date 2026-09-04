import { HttpFiscalConnectorClient } from '../src/fpo/client/fiscalConnectorClient';
import { FpoRecoveryEngine } from '../src/fpo/recovery/fpoRecoveryEngine';
import fs from 'fs';
import path from 'path';

function loadEnv(filePath: string) {
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        process.env[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
}

loadEnv(path.resolve(process.cwd(), '.env.agent'));

async function runShiftAndReceiptCycle() {
  const fpoUrl = 'http://127.0.0.1:8080';
  const rnm = process.env.FPO_RNM || '0000000000024294';
  const pin = process.env.FPO_PIN || '71178';
  const login = process.env.FPO_LOGIN || 'goodoo@gamil.com';
  const password = process.env.FPO_PASSWORD || '123456!';

  console.log('====================================================');
  console.log('🧾 REAL FPO: CLOSE SHIFT -> OPEN SHIFT -> SALE RECEIPT');
  console.log('====================================================');

  const client = new HttpFiscalConnectorClient(fpoUrl, 15000);
  client.configure({ registrationNumber: rnm, receiptWidthMm: 80 });

  const recoveryEngine = new FpoRecoveryEngine(client, async () => ({
    rnm,
    pin,
    login,
    password
  }));

  // 1. Initial PIN & Auth
  console.log('1️⃣ Верификация ПИН и Авторизация...');
  await client.verifyPin({ registrationNumber: rnm, pin });
  const auth = await client.auth({ registrationNumber: rnm, login, password });
  console.log(`✅ Авторизован кассир: ${auth.cashierName} (ИНН: ${auth.tin})`);

  // 2. Открытие смены через Recovery Engine (авто-реавторизация при 4011)
  console.log('\n2️⃣ [POST /driver/open-shift] Открытие смены через FpoRecoveryEngine...');
  const openRes = await recoveryEngine.executeWithRecovery('OPEN_SHIFT', async () => {
    return await client.openShift();
  });
  console.log('✅ Новая смена успешно открыта:', JSON.stringify(openRes, null, 2));

  // 3. Проверка состояния смены
  console.log('\n3️⃣ [GET /driver/state-shift] Проверка статуса смены...');
  const stateRes = await client.getStateShift();
  console.log('✅ Статус смены:', JSON.stringify(stateRes, null, 2));

  // 4. Пробитие реального чека (приход 1.00 сом)
  console.log('\n4️⃣ [POST /driver/cash-register/receipt] Пробитие чека через RecoveryEngine...');
  const receiptRes = await recoveryEngine.executeWithRecovery('SALE', async () => {
    return await client.createReceipt({
      operationType: 'INCOME',
      positions: [
        {
          calcItemAttributeCode: 0,
          name: 'Тестовый товар (SmartDev ФПО)',
          price: 1.00,
          quantity: 1.0000,
          cost: 1.00,
          measure: 'PIECE',
          vat: 0,
          st: 0
        }
      ],
      totalSum: 1.00,
      paySum: 1.00,
      totalCashSum: 1.00,
      totalCashlessSum: 0.00
    });
  });

  console.log('\n🎉 ЧЕК УСПЕШНО ФИСКАЛИЗИРОВАН В ГНС ЧЕРЕЗ SAM-КАРТУ!');
  console.log('✅ Результат фискализации чека:', JSON.stringify(receiptRes, null, 2));

  // 5. X-отчет
  console.log('\n5️⃣ [GET /driver/x-report] Получение промежуточного X-отчета...');
  const xRes = await client.getXReport();
  console.log('✅ X-отчет:', JSON.stringify(xRes, null, 2));

  console.log('\n====================================================');
  console.log('🏁 ВСЕ РЕАЛЬНЫЕ ОПЕРАЦИИ УСПЕШНО ВЫПОЛНЕНЫ!');
  console.log('====================================================');
}

runShiftAndReceiptCycle().catch(console.error);
