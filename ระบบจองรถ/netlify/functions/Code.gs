const CAR_BOOKING_SPREADSHEET_ID = '1HcJvXJ-Hgrx1EtCXzKk8QBUhE3CP5AX24TS3sIJcZz0';
const SESSION_TTL_SECONDS = 21600; // 6 ชั่วโมง
const TZ = 'Asia/Bangkok';

// ตั้งค่าสำหรับระบบดึงราคาน้ำมัน
const FUEL_PRICE_CACHE_TTL_SECONDS = 21600;
const FUEL_PRICE_CACHE_FRESH_MS = 5 * 60 * 1000;
const FUEL_PRICE_CACHE_KEY = 'live-fuel-prices-v1';

const SHEETS = {
  users: { name: 'Users_DB', headers: ['Email', 'FullName', 'Role', 'Department', 'Pic'] },
  vehicles: { name: 'Vehicles_DB', headers: ['Plate', 'Model', 'Type', 'KmPerLiter', 'DefaultFuel', 'Status', 'Image'] },
  bookings: { name: 'Bookings_DB', headers: ['BookingId', 'UserEmail', 'ApplicantName', 'Department', 'Date', 'EndDate', 'StartTime', 'EndTime', 'Purpose', 'Origin', 'Destination', 'DistanceKm', 'FormulaType', 'Vehicle', 'FuelType', 'FuelRate', 'TotalCost', 'Status', 'ApproverName', 'CreatedTime', 'OriginLat', 'OriginLng', 'DestinationLat', 'DestinationLng', 'PassengerCount', 'RejectionReason', 'Waypoint', 'WaypointLat', 'WaypointLng'] }
};

// ==========================================
// 1. การจัดการ Request เพื่อรองรับ Netlify แบบสมบูรณ์
// ==========================================
function doGet(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  if (parameters.action) return jsonResponse_(runAction_(parameters.action, parameters));
  
  try {
    const template = HtmlService.createTemplateFromFile('index');
    template.urlParams = parameters;
    return template.evaluate()
      .setTitle('Fuel Trip')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
  } catch (error) {
    return ContentService.createTextOutput("ไม่สามารถโหลดหน้าเว็บได้: " + error.message);
  }
}

// ⭐ จุดสำคัญ: ปรับ doPost ให้รับ text/plain จาก Netlify ได้
function doPost(event) {
  let payload = {};
  
  if (event && event.postData && event.postData.contents) {
    try {
      // แปลงข้อมูลที่ Netlify ส่งมาเป็น String กลับเป็น JSON
      payload = JSON.parse(event.postData.contents);
    } catch (error) {
      payload = event.parameter || {};
    }
  } else if (event && event.parameter) {
    payload = event.parameter;
  }
  
  const action = payload.action || (event && event.parameter && event.parameter.action);
  if (!action) {
    return jsonResponse_({ success: false, error: 'ไม่พบ action ในคำขอ' });
  }
  
  return jsonResponse_(runAction_(action, payload));
}

function doPostBackend(action, payload) {
  return runAction_(action, payload || {});
}

// ==========================================
// 2. ตัวประมวลผลคำสั่งหลัก (Router)
// ==========================================
function runAction_(action, payload) {
  try {
    return { success: true, data: dispatchAction_(action, payload) };
  } catch (error) {
    console.error('API ' + (action || 'unknown') + ' failed: ' + error.message);
    return { success: false, error: error.message || 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' };
  }
}

function dispatchAction_(action, payload) {
  const requestedAction = String(action || '').trim();
  if (!requestedAction) throw new Error('ไม่พบ action ในคำขอ');
  
  switch (requestedAction) {
    case 'getVersion': return { version: getVersion_() };
    case 'authenticateRole': return authenticateRole_(payload);
    case 'getAllData': return getAllData_(payload);
    case 'submitBooking': return submitBooking_(payload);
    case 'getLiveFuelPrices': return getLiveFuelPrices(payload.forceRefresh); 
    case 'updateBookingStatus':
      requireRole_(payload, ['user', 'director', 'admin']);
      return updateBookingStatus_(payload);
    case 'adminUpdateBooking':
      requireRole_(payload, ['admin']);
      return adminUpdateBooking_(payload);
    case 'deleteBooking':
      requireRole_(payload, ['admin']);
      return deleteRowByKey_(SHEETS.bookings, 'BookingId', payload.bookingId);
    case 'saveVehicle':
      requireRole_(payload, ['admin']);
      return saveVehicle_(payload);
    case 'deleteVehicle':
      requireRole_(payload, ['admin']);
      return deleteRowByKey_(SHEETS.vehicles, 'Plate', payload.plate);
    case 'saveUserAdmin':
      requireRole_(payload, ['admin']);
      return saveUser_(payload);
    case 'deleteUserAdmin':
      requireRole_(payload, ['admin']);
      return deleteRowByKey_(SHEETS.users, 'Email', payload.email);
    case 'resetAllAppData':
      requireRole_(payload, ['admin']);
      clearAllAppData_();
      return { message: 'ลบข้อมูลผู้ใช้ รถ และรายการจองแล้ว โดยเก็บหัวตารางไว้' };
    default: throw new Error('ไม่รองรับคำสั่ง ' + requestedAction);
  }
}

// ==========================================
// 3. ระบบยืนยันตัวตน (Authentication)
// ==========================================
function authenticateRole_(payload) {
  const role = String(payload.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'director') throw new Error('ระดับสิทธิ์นี้ไม่รองรับการเข้าสู่ระบบ');
  
  const properties = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  
  let adminPwd = properties.getProperty('ADMIN_PASSWORD') || 'admin1234';
  let directorPwd = properties.getProperty('DIRECTOR_PASSWORD') || 'dir1234';
  
  const requiredPassword = role === 'admin' ? adminPwd : directorPwd;
  
  if (!payload.password && payload.adminSessionToken && role === 'admin') {
      const sessionRole = cache.get('session:' + payload.adminSessionToken);
      if (sessionRole !== 'admin') throw new Error('เซสชันผู้ดูแลระบบไม่ถูกต้อง');
  } else if (String(payload.password || '') !== requiredPassword) {
    throw new Error('รหัสผ่านไม่ถูกต้อง');
  }
  
  const users = readObjects_(SHEETS.users);
  const roleNames = { director: 'ผู้อำนวยการ', admin: 'ผู้ดูแลระบบ' };
  const user = users.find(row => String(row.Role || '').toLowerCase() === role) || {
    Email: role + '@local.system',
    FullName: roleNames[role],
    Role: role,
    Department: 'ส่วนกลาง',
    Pic: 'https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=' + role
  };
  
  const sessionToken = Utilities.getUuid();
  cache.put('session:' + sessionToken, role, SESSION_TTL_SECONDS);
  
  return {
    sessionToken: sessionToken,
    user: { email: user.Email, fullName: user.FullName, role: role, department: user.Department, pic: user.Pic }
  };
}

function requireRole_(payload, allowedRoles) {
  const role = String(payload.role || '').toLowerCase();
  const token = String(payload.sessionToken || '');
  const cache = CacheService.getScriptCache();
  
  if (role === 'user' && allowedRoles.indexOf('user') !== -1) {
    return 'user';
  }

  const sessionRole = token ? cache.get('session:' + token) : null;
  
  if (!sessionRole || sessionRole !== role || allowedRoles.indexOf(sessionRole) === -1) {
    throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }
  cache.put('session:' + token, sessionRole, SESSION_TTL_SECONDS);
  return sessionRole;
}

// ==========================================
// 4. ระบบจัดการข้อมูลพื้นฐาน (Database Actions)
// ==========================================
function getAllData_(payload) {
  const spreadsheet = SpreadsheetApp.openById(CAR_BOOKING_SPREADSHEET_ID);
  
  const usersData = readObjects_(SHEETS.users, spreadsheet);
  const vehiclesData = readObjects_(SHEETS.vehicles, spreadsheet);
  const bookingsData = readObjects_(SHEETS.bookings, spreadsheet);
  
  const role = payload.role || 'user';
  if (usersData.length > 0) {
    usersData[0]._sessionRole = role; 
  } else {
    usersData.push({ _sessionRole: role });
  }
  
  return {
    version: getVersion_(),
    users: usersData,
    vehicles: vehiclesData,
    bookings: bookingsData
  };
}

function isValidIsoDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function submitBooking_(payload) {
  const email = String(payload.email || '').trim();
  const applicantName = String(payload.applicantName || '').trim();
  const purpose = String(payload.purpose || '').trim();
  const bookingDate = String(payload.date || '');
  const endDate = String(payload.endDate || bookingDate);
  const passengerCount = payload.passengerCount === '' || payload.passengerCount == null
    ? ''
    : Number(payload.passengerCount);
  
  if (!email || !applicantName || !purpose || !payload.date || !payload.origin || !payload.destination) {
    throw new Error('กรุณากรอกข้อมูลการจองให้ครบถ้วน');
  }
  if (!isValidIsoDate_(bookingDate) || !isValidIsoDate_(endDate) || endDate < bookingDate) {
    throw new Error('วันที่เดินทางหรือวันสิ้นสุดไม่ถูกต้อง');
  }
  if (passengerCount !== '' &&
      (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 100)) {
    throw new Error('จำนวนผู้โดยสารต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง 100 คน');
  }
  assertCoordinates_(payload, 'กรุณาค้นหาสถานที่ใหม่ก่อนจอง');
  assertOptionalWaypointCoordinates_(payload, 'กรุณาเลือกจุดผ่านบนแผนที่ใหม่ก่อนจอง');
  
  const bookingId = 'BK-' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
  const booking = {
    BookingId: bookingId, UserEmail: email, ApplicantName: applicantName,
    Department: String(payload.department || ''), Date: bookingDate,
    EndDate: endDate, StartTime: String(payload.startTime || ''), EndTime: String(payload.endTime || ''),
    Purpose: purpose, Origin: String(payload.origin), Destination: String(payload.destination),
    OriginLat: Number(payload.originLat) || 0, OriginLng: Number(payload.originLng) || 0,
    DestinationLat: Number(payload.destinationLat) || 0, DestinationLng: Number(payload.destinationLng) || 0,
    Waypoint: String(payload.waypoint || ''),
    WaypointLat: payload.waypointLat === '' || payload.waypointLat == null ? '' : Number(payload.waypointLat),
    WaypointLng: payload.waypointLng === '' || payload.waypointLng == null ? '' : Number(payload.waypointLng),
    DistanceKm: Number(payload.distanceKm) || 0, FormulaType: String(payload.formulaType || ''),
    Vehicle: String(payload.vehicle || ''), FuelType: String(payload.fuelType || '-'),
    FuelRate: Number(payload.fuelRate) || 0, TotalCost: Number(payload.totalCost) || 0,
    PassengerCount: passengerCount,
    Status: 'Pending', ApproverName: '', CreatedTime: new Date(), RejectionReason: ''
  };
  
  withScriptLock_(function() {
    if (booking.FormulaType === 'B') {
      const booked = readObjects_(SHEETS.bookings).some(function(existing) {
        if (existing.Status !== 'Pending' && existing.Status !== 'Approved' && existing.Status !== 'InUse') return false;
        if (String(existing.Vehicle) !== booking.Vehicle) return false;
        
        const reqStart = `${booking.Date}T${booking.StartTime || '00:00'}`;
        const reqEnd = `${booking.EndDate}T${booking.EndTime || '23:59'}`;
        
        const exStart = `${existing.Date}T${existing.StartTime || '00:00'}`;
        const exEnd = `${existing.EndDate || existing.Date}T${existing.EndTime || '23:59'}`;

        return (reqStart < exEnd && reqEnd > exStart);
      });
      if (booked) throw new Error('รถคันนี้มีการติดภารกิจในช่วงวันและเวลาดังกล่าวแล้ว กรุณาเลือกรถคันอื่น');
    }
    appendObject_(SHEETS.bookings, booking);
  });
  return { bookingId: bookingId };
}

function updateBookingStatus_(payload) {
  const status = String(payload.status || '');
  if (['Approved', 'Rejected', 'Completed', 'InUse'].indexOf(status) < 0) throw new Error('สถานะคำขอไม่ถูกต้อง');
  const rejectionReason = String(payload.rejectionReason || '').trim();
  if (status === 'Rejected' && !rejectionReason) throw new Error('กรุณาระบุเหตุผลก่อนยืนยันไม่อนุมัติ');
  if (rejectionReason.length > 1000) throw new Error('เหตุผลไม่อนุมัติต้องไม่เกิน 1,000 ตัวอักษร');
  
  let updateData = { Status: status };
  if (status === 'Rejected') updateData.RejectionReason = rejectionReason;
  if (payload.approverName !== undefined && payload.approverName !== '') {
    updateData.ApproverName = String(payload.approverName);
  }
  
  updateObject_(SHEETS.bookings, 'BookingId', payload.bookingId, updateData);
  return { bookingId: payload.bookingId, status: status, approverName: updateData.ApproverName, rejectionReason: updateData.RejectionReason };
}

function adminUpdateBooking_(payload) {
  assertCoordinates_(payload, 'กรุณาค้นหาสถานที่ใหม่ก่อนบันทึก');
  const changes = {
    Status: payload.status, Purpose: payload.purpose, Origin: payload.origin,
    Destination: payload.destination, OriginLat: Number(payload.originLat),
    OriginLng: Number(payload.originLng), DestinationLat: Number(payload.destinationLat),
    DestinationLng: Number(payload.destinationLng), DistanceKm: Number(payload.distanceKm) || 0,
    Vehicle: payload.vehicle, TotalCost: Number(payload.totalCost) || 0
  };
  if (payload.waypoint !== undefined ||
      payload.waypointLat !== undefined || payload.waypointLng !== undefined) {
    assertOptionalWaypointCoordinates_(payload, 'กรุณาเลือกจุดผ่านบนแผนที่ใหม่ก่อนบันทึก');
    changes.Waypoint = String(payload.waypoint || '');
    changes.WaypointLat = payload.waypointLat === '' || payload.waypointLat == null ? '' : Number(payload.waypointLat);
    changes.WaypointLng = payload.waypointLng === '' || payload.waypointLng == null ? '' : Number(payload.waypointLng);
  }
  updateObject_(SHEETS.bookings, 'BookingId', payload.bookingId, changes);
  return { bookingId: payload.bookingId };
}

function assertOptionalWaypointCoordinates_(payload, message) {
  const latitude = payload.waypointLat;
  const longitude = payload.waypointLng;
  const hasLatitude = latitude !== undefined && latitude !== null && latitude !== '';
  const hasLongitude = longitude !== undefined && longitude !== null && longitude !== '';
  if (!hasLatitude && !hasLongitude) {
    if (String(payload.waypoint || '').trim()) {
      throw new Error('กรุณาระบุพิกัดจุดผ่านให้ครบถ้วน ' + message);
    }
    return;
  }
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!hasLatitude || !hasLongitude || isNaN(lat) || isNaN(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('พิกัดจุดผ่านไม่ถูกต้อง ' + message);
  }
}

function assertCoordinates_(payload, message) {
  const coords = [payload.originLat, payload.originLng, payload.destinationLat, payload.destinationLng].map(Number);
  if (coords.some(isNaN) || Math.abs(coords[0]) > 90 || Math.abs(coords[2]) > 90 || Math.abs(coords[1]) > 180 || Math.abs(coords[3]) > 180) {
    throw new Error('พิกัดต้นทางหรือปลายทางไม่ถูกต้อง ' + message);
  }
}

function saveVehicle_(payload) {
  const vehicle = payload.vehicle || {};
  if (!vehicle.Plate || !vehicle.Model) throw new Error('กรุณาระบุทะเบียนและรุ่นรถ');
  upsertObject_(SHEETS.vehicles, 'Plate', payload.oldPlate || vehicle.Plate, {
    Plate: String(vehicle.Plate), Model: String(vehicle.Model), Type: String(vehicle.Type || ''),
    KmPerLiter: Number(vehicle.KmPerLiter) || 0, DefaultFuel: String(vehicle.DefaultFuel || ''),
    Status: String(vehicle.Status || 'available'), Image: String(vehicle.Image || '')
  });
  return { plate: vehicle.Plate };
}

function saveUser_(payload) {
  const user = payload.user || {};
  if (!user.Email || !user.FullName) throw new Error('กรุณาระบุอีเมลและชื่อผู้ใช้งาน');
  upsertObject_(SHEETS.users, 'Email', payload.oldEmail || user.Email, {
    Email: String(user.Email), FullName: String(user.FullName),
    Role: String(user.Role || 'user').toLowerCase(),
    Department: String(user.Department || ''), Pic: String(user.Pic || '')
  });
  return { email: user.Email };
}

function clearAllAppData_() {
  const spreadsheet = SpreadsheetApp.openById(CAR_BOOKING_SPREADSHEET_ID);
  withScriptLock_(function() {
    Object.values(SHEETS).forEach(function(config) {
      const sheet = getSheet_(config, spreadsheet);
      const lastRow = sheet.getLastRow();
      const lastColumn = sheet.getLastColumn();
      if (lastRow > 1 && lastColumn > 0) {
        sheet.getRange(2, 1, lastRow - 1, lastColumn).clearContent();
      }
    });
    SpreadsheetApp.flush(); 
    bumpVersion_();
  });
}

// ==========================================
// 5. ระบบราคาน้ำมัน (Fuel Prices API)
// ==========================================
function authorizeFuelPriceFetch() {
  const result = getLiveFuelPrices(true);
  const summary = { ptt: result.providers.ptt.status, bcp: result.providers.bcp.status };
  return summary;
}

function getLiveFuelPrices(forceRefresh) {
  if (forceRefresh && typeof forceRefresh === 'object') {
    forceRefresh = Boolean(forceRefresh.forceRefresh);
  }

  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cachedResponse = cache.get(FUEL_PRICE_CACHE_KEY);
    if (cachedResponse) {
      const parsed = JSON.parse(cachedResponse);
      if (Date.now() - Number(parsed.checkedAtMs || 0) < FUEL_PRICE_CACHE_FRESH_MS) {
        parsed.cacheHit = true;
        return parsed;
      }
    }
  }

  const providers = {
    ptt: loadFuelProvider_('ptt', fetchPttFuelPrices_),
    bcp: loadFuelProvider_('bcp', fetchBangchakFuelPrices_)
  };
  const response = {
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now(),
    cacheHit: false,
    providers: providers
  };
  cache.put(FUEL_PRICE_CACHE_KEY, JSON.stringify(response), 300);
  return response;
}

function loadFuelProvider_(providerKey, fetchPrices) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'live-fuel-provider-' + providerKey + '-v1';
  try {
    const result = fetchPrices();
    if (!result || !result.fuels || !Object.keys(result.fuels).length) {
      throw new Error('แหล่งข้อมูลไม่พบราคาน้ำมันที่รองรับ');
    }
    const providerData = { status: 'ok', effectiveAt: result.effectiveAt || 'ไม่ระบุเวลา', fetchedAt: new Date().toISOString(), priceBasis: result.priceBasis || '', fuels: result.fuels };
    cache.put(cacheKey, JSON.stringify(providerData), FUEL_PRICE_CACHE_TTL_SECONDS);
    return providerData;
  } catch (error) {
    console.error('Fuel price fetch failed for ' + providerKey + ': ' + error.message);
    const cachedProvider = cache.get(cacheKey);
    if (cachedProvider) {
      const staleData = JSON.parse(cachedProvider);
      staleData.status = 'stale';
      staleData.error = error.message;
      return staleData;
    }
    return { status: 'error', fuels: {}, error: error.message };
  }
}

function fetchPttFuelPrices_() {
  const endpoint = 'https://orapiweb.pttor.com/oilservice/OilPrice.asmx';
  const soapBody = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><CurrentOilPrice xmlns="http://www.pttor.com"><Language>en</Language></CurrentOilPrice></soap:Body></soap:Envelope>';
  const response = fetchFuelUrlWithRetry_('PTT OR', endpoint, { method: 'post', contentType: 'text/xml; charset=utf-8', headers: { SOAPAction: '"https://orapiweb.pttor.com/CurrentOilPrice"' }, payload: soapBody, muteHttpExceptions: true });
  const envelope = XmlService.parse(response.getContentText());
  const resultElement = findFuelXmlElement_(envelope.getRootElement(), 'CurrentOilPriceResult');
  let dataRoot = resultElement;
  if (!findFuelXmlElement_(resultElement, 'FUEL')) dataRoot = XmlService.parse(resultElement.getText().trim()).getRootElement();

  const fuels = {};
  let newestDate = '';
  findFuelXmlElements_(dataRoot, 'FUEL').forEach(function(record) {
    const product = getFuelXmlValue_(record, 'PRODUCT');
    const fuelKey = identifyFuelKey_(product);
    const price = parseFuelPrice_(getFuelXmlValue_(record, 'PRICE'));
    const priceDate = getFuelXmlValue_(record, 'PRICE_DATE');
    if (!fuelKey || !Number.isFinite(price) || price <= 0) return;
    if (!fuels[fuelKey] || priceDate >= fuels[fuelKey].effectiveAt) fuels[fuelKey] = { price: price, effectiveAt: priceDate };
    if (priceDate > newestDate) newestDate = priceDate;
  });

  const normalizedFuels = {}; Object.keys(fuels).forEach(function(key) { normalizedFuels[key] = { price: fuels[key].price }; });
  return { fuels: normalizedFuels, effectiveAt: newestDate || 'ไม่ระบุเวลา', priceBasis: 'ตามข้อมูลจาก PTT OR' };
}

function fetchBangchakFuelPrices_() {
  const endpoint = 'https://oil-price.bangchak.co.th/ApiOilPrice2/th/';
  const response = fetchFuelUrlWithRetry_('บางจาก', endpoint, { method: 'get', headers: { Accept: 'application/json' }, muteHttpExceptions: true });
  const payload = JSON.parse(response.getContentText());
  const feed = Array.isArray(payload) ? payload[0] : payload;
  const oilList = typeof feed.OilList === 'string' ? JSON.parse(feed.OilList) : feed.OilList;

  const fuels = {};
  oilList.forEach(function(item) {
    const fuelKey = identifyFuelKey_(item.OilName);
    const price = parseFuelPrice_(item.PriceToday);
    if (!fuelKey || !Number.isFinite(price) || price <= 0) return;
    fuels[fuelKey] = { price: price };
  });

  const effectiveAt = [feed.OilPriceDate, feed.OilPriceTime].filter(Boolean).join(' ');
  return { fuels: fuels, effectiveAt: effectiveAt || 'ไม่ระบุเวลา', priceBasis: String(feed.OilRemark || 'ตามข้อมูลจากบางจาก') };
}

function fetchFuelUrlWithRetry_(providerName, url, options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) return response;
      throw new Error('HTTP ' + response.getResponseCode());
    } catch (error) { lastError = error; Utilities.sleep(500); }
  }
  throw lastError;
}

function identifyFuelKey_(productName) {
  const name = String(productName || '').toLowerCase().replace(/[\s_\-./()]+/g, '');
  if (!name) return '';
  if (name.indexOf('b20') !== -1) return 'dieselB20';
  if ((name.indexOf('premium') !== -1 || name.indexOf('พรีเมียม') !== -1) && (name.indexOf('diesel') !== -1 || name.indexOf('ดีเซล') !== -1)) return 'premiumDiesel';
  if (name.indexOf('premium') !== -1 || name.indexOf('พรีเมียม') !== -1 || name.indexOf('superpower') !== -1) return 'premiumGasohol';
  if (name.indexOf('e85') !== -1) return 'e85';
  if (name.indexOf('e20') !== -1) return 'e20';
  if (name.indexOf('gasoline95') !== -1 || name.indexOf('เบนซิน95') !== -1) return 'gasoline95';
  if (name.indexOf('91') !== -1) return 'gasohol91';
  if (name.indexOf('95') !== -1) return 'gasohol95';
  if (name.indexOf('diesel') !== -1 || name.indexOf('ดีเซล') !== -1 || name.indexOf('b7') !== -1) return 'diesel';
  return '';
}

function parseFuelPrice_(value) { return Number(String(value == null ? '' : value).replace(/,/g, '').trim()) || NaN; }
function findFuelXmlElement_(element, name) {
  if (element.getName() === name) return element;
  const children = element.getChildren();
  for (let index = 0; index < children.length; index += 1) {
    const match = findFuelXmlElement_(children[index], name);
    if (match) return match;
  }
  return null;
}
function findFuelXmlElements_(element, name) {
  const matches = [];
  if (element.getName() === name) matches.push(element);
  element.getChildren().forEach(function(child) { matches.push.apply(matches, findFuelXmlElements_(child, name)); });
  return matches;
}
function getFuelXmlValue_(element, name) {
  const child = findFuelXmlElement_(element, name);
  return child ? child.getText().trim() : '';
}

// ==========================================
// 6. Utilities (อ่านเขียน Google Sheet)
// ==========================================
function getVersion_() { return PropertiesService.getScriptProperties().getProperty('V') || '0'; }
function bumpVersion_() { PropertiesService.getScriptProperties().setProperty('V', String(Date.now())); }
function markDataUpdated_() { bumpVersion_(); }

function deleteRowByKey_(sheetConfig, key, value) {
  withScriptLock_(function() {
    const sheet = getSheet_(sheetConfig);
    const rows = sheet.getDataRange().getValues();
    const keyIndex = rows[0].indexOf(key);
    const rowIndex = rows.findIndex((row, i) => i > 0 && String(row[keyIndex]) === String(value));
    if (rowIndex < 0) throw new Error('ไม่พบรายการ ' + value);
    sheet.deleteRow(rowIndex + 1);
    SpreadsheetApp.flush(); markDataUpdated_();
  });
  return { deleted: true };
}

function updateObject_(sheetConfig, key, value, changes) {
  withScriptLock_(function() {
    const sheet = getSheet_(sheetConfig);
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const keyIndex = headers.indexOf(key);
    const rowIndex = values.findIndex((row, i) => i > 0 && String(row[keyIndex]) === String(value));
    
    Object.keys(changes).forEach(field => {
      const column = headers.indexOf(field);
      if (column >= 0 && changes[field] !== undefined) {
        let val = changes[field];
        if ((field === 'StartTime' || field === 'EndTime') && typeof val === 'string') val = "'" + val;
        sheet.getRange(rowIndex + 1, column + 1).setValue(val);
      }
    });
    SpreadsheetApp.flush(); markDataUpdated_();
  });
}

function upsertObject_(sheetConfig, key, oldValue, object) {
  withScriptLock_(function() {
    const existing = readObjectsWithRows_(sheetConfig).find(item => String(item.values[key]) === String(oldValue));
    if (existing) updateObject_(sheetConfig, key, oldValue, object);
    else appendObject_(sheetConfig, object);
  });
}

function appendObject_(sheetConfig, object) {
  withScriptLock_(function() {
    const sheet = getSheet_(sheetConfig);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    const rowData = headers.map(header => {
      let val = object[header];
      if (val === undefined) return '';
      if ((header === 'StartTime' || header === 'EndTime') && typeof val === 'string') return "'" + val;
      return val;
    });
    sheet.appendRow(rowData);
    SpreadsheetApp.flush(); markDataUpdated_();
  });
}

function formatCell_(header, value) {
  if (value instanceof Date) {
    if (header === 'Date' || header === 'EndDate') return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
    if (header === 'StartTime' || header === 'EndTime') return Utilities.formatDate(value, TZ, 'HH:mm');
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  return value;
}

function readObjects_(sheetConfig, spreadsheet) {
  const values = getSheet_(sheetConfig, spreadsheet).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(row => row.some(val => val !== '')).map(row => {
    const obj = {};
    headers.forEach((header, i) => { obj[header] = formatCell_(header, row[i]); });
    return obj;
  });
}

function readObjectsWithRows_(sheetConfig) {
  const values = getSheet_(sheetConfig).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((row, index) => {
    const obj = {};
    headers.forEach((header, column) => { obj[header] = row[column]; });
    return { rowNumber: index + 2, values: obj };
  });
}

function getSheet_(sheetConfig, spreadsheet) {
  return withScriptLock_(function() {
    const targetSpreadsheet = spreadsheet || SpreadsheetApp.openById(CAR_BOOKING_SPREADSHEET_ID);
    let sheet = targetSpreadsheet.getSheetByName(sheetConfig.name);
    if (!sheet) sheet = targetSpreadsheet.insertSheet(sheetConfig.name);
    
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, sheetConfig.headers.length).setValues([sheetConfig.headers]);
      sheet.setFrozenRows(1);
    } else {
      const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
      const missing = sheetConfig.headers.filter(header => existing.indexOf(header) === -1);
      if (missing.length) sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    }
    return sheet;
  });
}

let LOCK_DEPTH_ = 0;
function withScriptLock_(callback) {
  if (LOCK_DEPTH_ > 0) return callback();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_DEPTH_++;
  try { return callback(); } finally { LOCK_DEPTH_--; lock.releaseLock(); }
}

function jsonResponse_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 7. Setup พื้นฐานครั้งแรก
// ==========================================
function setupSheets() {
  const spreadsheet = SpreadsheetApp.openById(CAR_BOOKING_SPREADSHEET_ID);
  Object.values(SHEETS).forEach(config => getSheet_(config, spreadsheet));
  
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PASSWORD')) props.setProperty('ADMIN_PASSWORD', 'admin1234');
  if (!props.getProperty('DIRECTOR_PASSWORD')) props.setProperty('DIRECTOR_PASSWORD', 'dir1234');
  
  return 'เตรียมชีตพร้อมรหัสผ่านเริ่มต้น เรียบร้อยแล้ว';
}