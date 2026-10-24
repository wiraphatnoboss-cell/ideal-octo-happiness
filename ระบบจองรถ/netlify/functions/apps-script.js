const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyIMAH2fWZBVlRzV_DK3dU-eqbgozmt1tukgeFLcvot-z1BOP0tqUTrvEOsEcc6EbB1/exec';
const MAX_REQUEST_BODY_LENGTH = 100000;
const UPSTREAM_TIMEOUT_MS = 24000;

exports.handler = async event => {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  };
  const respond = (statusCode, body) => ({
    statusCode,
    headers,
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, error: 'รองรับเฉพาะคำขอ POST' });
  }

  const fetchSite = event.headers && (
    event.headers['sec-fetch-site'] ||
    event.headers['Sec-Fetch-Site']
  );
  if (String(fetchSite || '').toLowerCase() === 'cross-site') {
    return respond(403, { success: false, error: 'ปฏิเสธคำขอแชตที่ส่งมาจากเว็บไซต์อื่น' });
  }

  let requestBody;
  try {
    requestBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';
    if (!requestBody || requestBody.length > MAX_REQUEST_BODY_LENGTH) {
      return respond(413, { success: false, error: 'ข้อมูลคำขอว่างหรือมีขนาดใหญ่เกินกำหนด' });
    }
    const payload = JSON.parse(requestBody);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof payload.action !== 'string' || !payload.action.trim()) {
      return respond(400, { success: false, error: 'ข้อมูลคำขอไม่ถูกต้องหรือไม่มี action' });
    }
  } catch (error) {
    return respond(400, { success: false, error: 'ข้อมูลคำขอไม่ใช่ JSON ที่ถูกต้อง' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamUrl = new URL(APPS_SCRIPT_URL);
    const payload = JSON.parse(requestBody);
    upstreamUrl.searchParams.set('action', payload.action.trim());

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: requestBody,
      signal: controller.signal
    });
    const responseBody = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      console.error('Apps Script returned HTTP ' + upstreamResponse.status);
      return respond(502, { success: false, error: 'Apps Script ตอบกลับผิดพลาด กรุณาตรวจสอบการ Deploy Web App' });
    }
    try {
      JSON.parse(responseBody);
    } catch (error) {
      console.error('Apps Script returned a non-JSON response');
      return respond(502, { success: false, error: 'Apps Script ไม่ได้ส่ง JSON กลับมา กรุณาตรวจสอบ URL และสิทธิ์ Web App' });
    }
    return {
      statusCode: 200,
      headers,
      body: responseBody
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return respond(504, { success: false, error: 'Apps Script ใช้เวลาตอบนานเกินไป กรุณาลองใหม่' });
    }
    console.error('Apps Script proxy request failed before receiving a response');
    return respond(502, { success: false, error: 'เชื่อมต่อ Apps Script ไม่สำเร็จ กรุณาลองใหม่ภายหลัง' });
  } finally {
    clearTimeout(timeoutId);
  }
};
