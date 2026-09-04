import { HttpFiscalConnectorClient } from '../src/fpo/client/fiscalConnectorClient';
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

async function runRealFpoTest() {
  const fpoUrl = 'http://127.0.0.1:8080';
  const rnm = process.env.FPO_RNM || '0000000000024294';
  const pin = process.env.FPO_PIN || '71178';
  const login = process.env.FPO_LOGIN || 'goodoo@gamil.com';
  const password = process.env.FPO_PASSWORD || '123456!';

  console.log('====================================================');
  console.log('🧪 REAL FPO DRIVER CONNECTION TEST (v1.3.0)');
  console.log('====================================================');
  console.log(`📡 URL: ${fpoUrl}`);
  console.log(`🔢 RNM: ${rnm}`);
  console.log(`🔑 PIN: ${pin}`);
  console.log(`👤 Login: ${login}`);
  console.log('----------------------------------------------------');

  const client = new HttpFiscalConnectorClient(fpoUrl, 10000);
  client.configure({ registrationNumber: rnm, receiptWidthMm: 80 });

  // 1. POST /driver/verify-pin
  try {
    console.log('\n1️⃣ [POST /driver/verify-pin] Аутентификация SAM-карты...');
    const pinRes = await client.verifyPin({ registrationNumber: rnm, pin });
    console.log('✅ Verify PIN Response:', JSON.stringify(pinRes, null, 2));
  } catch (err: any) {
    console.error('❌ Verify PIN Error:', err.message, err.details || '');
  }

  // 2. POST /driver/auth
  try {
    console.log('\n2️⃣ [POST /driver/auth] Авторизация пользователя в ГНС...');
    const authRes = await client.auth({ registrationNumber: rnm, login, password });
    console.log('✅ Auth Response:', JSON.stringify(authRes, null, 2));
  } catch (err: any) {
    console.error('❌ Auth Error:', err.message, err.details || '');
  }

  // 3. GET /driver/state-shift
  try {
    console.log('\n3️⃣ [GET /driver/state-shift] Состояние смены...');
    const stateRes = await client.getStateShift();
    console.log('✅ State Shift Response:', JSON.stringify(stateRes, null, 2));
  } catch (err: any) {
    console.error('❌ State Shift Error:', err.message, err.details || '');
  }

  // 4. GET /driver/cash-register/available-tax-rates
  try {
    console.log('\n4️⃣ [GET /driver/cash-register/available-tax-rates] Доступные налоговые ставки...');
    const taxRates = await client.getAvailableTaxRates();
    console.log('✅ Tax Rates Response:', JSON.stringify(taxRates, null, 2));
  } catch (err: any) {
    console.error('❌ Tax Rates Error:', err.message, err.details || '');
  }

  // 5. GET /driver/cash-transaction
  try {
    console.log('\n5️⃣ [GET /driver/cash-transaction] Состояние наличных в кассе...');
    const cashRes = await client.getCashTransaction();
    console.log('✅ Cash Drawer Response:', JSON.stringify(cashRes, null, 2));
  } catch (err: any) {
    console.error('❌ Cash Drawer Error:', err.message, err.details || '');
  }

  console.log('\n====================================================');
  console.log('🏁 Тестирование завершено');
  console.log('====================================================');
}

runRealFpoTest().catch(console.error);
