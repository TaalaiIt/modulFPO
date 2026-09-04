async function probeEndpoints() {
  const baseUrl = 'http://localhost:8080';
  const rnm = '0000000000024294';
  const pin = '71178';

  const endpoints = [
    { method: 'GET', path: '/driver/sam-cards' },
    { method: 'GET', path: '/driver/sam-card' },
    { method: 'GET', path: '/driver/samcards' },
    { method: 'GET', path: '/driver/status' },
    { method: 'GET', path: '/driver/readers' },
    { method: 'GET', path: '/driver/slots' },
    { method: 'GET', path: '/driver/card' },
    { method: 'POST', path: '/driver/select-card', body: { registrationNumber: rnm, slot: 0 } },
    { method: 'POST', path: '/driver/select-card', body: { registrationNumber: rnm } },
    { method: 'POST', path: '/driver/sam-card', body: { registrationNumber: rnm } },
    { method: 'POST', path: '/driver/verify-pin', body: { registrationNumber: rnm, pin } }
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'Registration-Number': rnm,
          'Accept': 'application/json'
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined
      });
      const data = await res.json().catch(() => ({ statusText: res.statusText }));
      console.log(`[${ep.method}] ${ep.path} -> HTTP ${res.status}:`, JSON.stringify(data));
    } catch (err: any) {
      console.log(`[${ep.method}] ${ep.path} -> FETCH ERROR:`, err.message);
    }
  }
}

probeEndpoints().catch(console.error);
