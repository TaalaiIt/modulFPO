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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testFullRealFlow() {
  const fpoUrl = 'http://127.0.0.1:8080';
  const rnm = process.env.FPO_RNM || '0000000000024294';
  const pin = process.env.FPO_PIN || '71178';
  const login = process.env.FPO_LOGIN || 'goodoo@gamil.com';
  const password = process.env.FPO_PASSWORD || '123456!';

  console.log('================================================================');
  console.log('🚀 ТЕСТИРОВАНИЕ РЕАЛЬНОГО ДРАЙВЕРА ФПО (FiscalConnector + SAM)');
  console.log('================================================================');
  console.log(`🌐 Адрес драйвера : ${fpoUrl}`);
  console.log(`🔢 РНМ ККМ        : ${rnm}`);
  console.log(`👤 Логин в ГНС    : ${login}`);
  console.log('----------------------------------------------------------------\n');

  const client = new HttpFiscalConnectorClient(fpoUrl, 15000);
  client.configure({ registrationNumber: rnm, receiptWidthMm: 80 });

  const recoveryEngine = new FpoRecoveryEngine(client, async () => ({
    rnm,
    pin,
    login,
    password
  }));

  // ШАГ 1: ПИН SAM-карты
  console.log('1️⃣ Ввод ПИН-кода SAM-карты (POST /driver/verify-pin)...');
  const pinRes = await client.verifyPin({ registrationNumber: rnm, pin });
  console.log('   ✅ SAM-карта готова:', {
    РНМ: pinRes.registrationNumber,
    НомерФМ: pinRes.fiscalModuleNumber,
    СрокДействия: pinRes.fmExpirationDate,
    Очередь: pinRes.queueSize
  });

  // ШАГ 2: Авторизация в ГНС
  console.log('\n2️⃣ Авторизация пользователя в серверах ГНС (POST /driver/auth)...');
  const auth = await client.auth({ registrationNumber: rnm, login, password });
  console.log('   ✅ Авторизация успешна:', {
    Кассир: auth.cashierName,
    ИНН: auth.tin,
    Организация: auth.fullName,
    Адрес: auth.locationOriginalAddress
  });

  // ШАГ 3: Проверка статуса смены
  console.log('\n3️⃣ Проверка статуса смены (GET /driver/state-shift)...');
  const stateRes = await client.getStateShift();
  console.log('   ✅ Статус смены:', {
    СменаОткрыта: stateRes.shiftOpened,
    ВремяОткрытия: stateRes.openShiftDateTime,
    Очередь: stateRes.queueSize
  });

  // Если смена закрыта - открываем
  if (!stateRes.shiftOpened) {
    console.log('\n   Открытие новой смены (POST /driver/open-shift)...');
    const openRes = await recoveryEngine.executeWithRecovery('OPEN_SHIFT', async () => {
      return await client.openShift({ cashier: { name: auth.cashierName || 'Кассир' } });
    });
    console.log('   ✅ Смена открыта:', {
      Смена: openRes.shiftNumber,
      НомерФД: openRes.fdNumber,
      ФискальныйПризнак: openRes.fiscalMark
    });
  }

  // Ожидание синхронизации очереди отправки в ГНС (если queueSize > 0)
  console.log('\n⏳ Ожидание синхронизации документов с сервером ГНС...');
  for (let i = 0; i < 15; i++) {
    const checkState = await client.getStateShift();
    if ((checkState.queueSize ?? 0) === 0) {
      console.log('   ✅ Очередь отправки пуста (0 документов), сервер ГНС подтвердил открытие!');
      break;
    }
    console.log(`   ⏳ Документов в очереди: ${checkState.queueSize}. Ждем отправку... (${i + 1}/15)`);
    await sleep(2000);
  }

  // ШАГ 4: Фискализация чека продажи
  console.log('\n4️⃣ Пробитие фискального чека продажи на 1.00 KGS (POST /driver/cash-register/receipt)...');
  const receiptRes = await recoveryEngine.executeWithRecovery('SALE', async () => {
    return await client.createReceipt({
      operationType: 'INCOME',
      positions: [
        {
          calcItemAttributeCode: 0,
          name: 'Тестовый кофе (SmartDev ФПО)',
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

  console.log('\n🎉 ================================================================');
  console.log('🎉 ЧЕК УСПЕШНО ФИСКАЛИЗИРОВАН В ГОСУДАРСТВЕННОЙ НАЛОГОВОЙ СЛУЖБЕ!');
  console.log('🎉 ================================================================');
  console.log('   📄 Тип документа        :', receiptRes.receiptName || receiptRes.receiptType);
  console.log('   🔢 Номер смены          :', receiptRes.shiftNumber);
  console.log('   📜 Номер ФД             :', receiptRes.fdNumber);
  console.log('   🔐 Фискальный признак   :', receiptRes.fiscalMark);
  console.log('   💰 Сумма оплаты         :', `${receiptRes.totalSum} KGS (Наличные: ${receiptRes.totalCashSum} KGS)`);
  console.log('   🕒 Время фискализации   :', receiptRes.date);
  console.log('   🔗 QR-код проверки ГНС  :', `https://tax.gov.kg/check?kkt=${rnm}&fn=${pinRes.fiscalModuleNumber}&fd=${receiptRes.fdNumber}&fpd=${receiptRes.fiscalMark}`);

  // ШАГ 5: Промежуточный X-отчет
  console.log('\n5️⃣ Получение промежуточного X-отчета (GET /driver/x-report)...');
  const xRes = await client.getXReport();
  console.log('   ✅ Итоги смены (X-отчет):', {
    Смена: xRes.shiftNumber,
    ВыручкаНаличными: xRes.totalCashSum,
    ВыручкаБезналичными: xRes.totalCashlessSum,
    ВсегоСумма: xRes.totalSum,
    ОстатокВКассе: xRes.cashTotal
  });

  console.log('\n================================================================');
  console.log('🏁 ПОЛНЫЙ РЕАЛЬНЫЙ ЦИКЛ ФИСКАЛИЗАЦИИ ПРОЙДЕН НА 100%!');
  console.log('================================================================\n');
}

testFullRealFlow().catch((err) => {
  console.error('\n❌ Ошибка при выполнении теста:', err.message, err.details || '');
});
