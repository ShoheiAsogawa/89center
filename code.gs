/* ===== 89CENTER Booking System — Light v4.4 (No LINE push) ===== 
 * 目的: LINEの通知（Messaging APIによるpush）機能を完全に除去し、
 *      LIFF/LINE Loginのid_token検証＋予約管理だけに絞る版。
 */

const STAFF = ['麻生川','岡野','堀江','松田','山口'];
const FEES  = {'麻生川':16500,'岡野':11000,'堀江':11000,'松田':11000,'山口':11000};
const SHEET_BOOK = '予約管理';
const SHEET_BLOCK = 'ブロック';
const SHEET_LOG = 'ログ';
const START_HOUR = 9;
const END_HOUR = 21;
const SLOT_INTERVAL_MINUTES = 30;


// Weekly off mapping (0=Sun..6=Sat)
const WEEKLY_OFF = { '麻生川':1, '松田':2, '堀江':4, '山口':5, '岡野':6 };

/* =========================
 * 管理用ユーティリティ群
 * ========================= */
function tz(){ return Session.getScriptTimeZone() || 'Asia/Tokyo'; }

function normDate(val){
  if (val instanceof Date) return Utilities.formatDate(val, tz(), 'yyyy-MM-dd');
  if (typeof val === 'number'){ // Sheets serial
    const epoch = new Date(1899,11,30);
    const d = new Date(epoch.getTime() + val*24*60*60*1000);
    return Utilities.formatDate(d, tz(), 'yyyy-MM-dd');
  }
  if (typeof val === 'string'){
    const m = val.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m){ return m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2); }
  }
  return '';
}

function normTime(val){
  if (val instanceof Date) return Utilities.formatDate(val, tz(), 'HH:mm');
  if (typeof val === 'number'){
    const minutes = Math.round(val*24*60) % (24*60);
    const h = Math.floor(minutes/60), m = minutes%60;
    return ('0'+h).slice(-2)+':'+('0'+m).slice(-2);
  }
  if (typeof val === 'string'){
    const m = val.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (m) return ('0'+m[1]).slice(-2)+':'+m[2];
  }
  return '';
}

function incrementTime(hhmm, minutes){
  let [h,m]=hhmm.split(':').map(x=>parseInt(x,10));
  m+=minutes; while(m>=60){h++; m-=60;}
  return ('0'+h).slice(-2)+':'+('0'+m).slice(-2);
}

function ensureSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_BOOK)){
    const sh = ss.insertSheet(SHEET_BOOK);
    sh.appendRow(['予約日','開始時刻','終了時刻','スタッフ','患者名','メール','電話','症状','料金','ステータス','予約ID','作成日時','ユーザーID']);
  }
  if (!ss.getSheetByName(SHEET_BLOCK)){
    const sh2 = ss.insertSheet(SHEET_BLOCK);
    sh2.appendRow(['予約日','時刻','スタッフ','理由','作成日時','作成者']);
  }
  if (!ss.getSheetByName(SHEET_LOG)){
    const lg = ss.insertSheet(SHEET_LOG);
    lg.appendRow(['タイムスタンプ','アクション','アクター','ユーザーID','メール','電話','予約ID','スタッフ','日付','時刻','詳細JSON']);
  }
}

function getScheduleWithToken(dateStr, idToken){
  const claims = verifyIdToken_(idToken);
  const uid = claims && claims.sub ? claims.sub : '';
  return getSchedule(dateStr, false, uid);
}

function createBookingWithToken(payload, idToken){
  const claims = verifyIdToken_(idToken);
  if (!claims || !claims.sub) {
    return {success: false, message: 'トークン検証に失敗しました'};
  }
  
  const userId = claims.sub;
  return createBooking(
    payload.date, 
    payload.startTime, 
    payload.staff, 
    payload.patientName, 
    payload.email, 
    payload.phone, 
    payload.symptoms, 
    userId  // ← ここでLINE IDを渡す
  );
}

function getSheet(name){ return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function generateTimeSlots(){
  const out=[]; for (let h=START_HOUR;h<END_HOUR;h++){ for (let m=0;m<60;m+=SLOT_INTERVAL_MINUTES){ out.push(('0'+h).slice(-2)+':'+('0'+m).slice(-2)); } } out.push('21:00'); return out;
}

function logEvent(action, actorType, userId, email, phone, bookingId, staff, dateStr, time, payload){
  try{
    const sh = getSheet(SHEET_LOG); const ts = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
    sh.appendRow([ts, action, actorType, userId||'', email||'', phone||'', bookingId||'', staff||'', dateStr||'', time||'', JSON.stringify(payload||{})]);
  }catch(e){ Logger.log(e); }
}

/* =========================
 * 表示: 既存のHtmlService画面（管理用は必要なら残す）
 * ========================= */
function doGet(e){
  const view = (e && e.parameter && e.parameter.view)||'';
  const file = view === 'admin' ? 'admin' : (view==='tos' ? 'tos' : (view==='privacy' ? 'privacy' : 'index'));
  return HtmlService.createHtmlOutputFromFile(file)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

/* =========================
 * 予約テーブル → スケジュールマップ
 * ========================= */
function getSchedule(dateStr, isAdmin, userId){
  ensureSheets();
  const dateISO = normDate(dateStr);
  const book = getSheet(SHEET_BOOK).getDataRange().getValues();
  const blocks = getSheet(SHEET_BLOCK).getDataRange().getValues();
  const slots = generateTimeSlots();
  const result = {};
  STAFF.forEach(s=>{
    result[s] = {};
    slots.forEach(t=>{ result[s][t] = { booked:false, own:false, blocked:false, reason:'', patientName:'', bookingId:'', symptoms:'', fee: FEES[s] }; });
  });

  // Weekly off
  const dow = (new Date(dateISO)).getDay();
  STAFF.forEach(s=>{
    if (WEEKLY_OFF[s] === dow){
      slots.forEach(t=>{ result[s][t].blocked = true; result[s][t].reason = '定休日'; });
    }
  });

  // Irregular blocks
  for (let i=1;i<blocks.length;i++){
    const row = blocks[i];
    const d = normDate(row[0]); if (!d) continue;
    if (d === dateISO){
      const t = normTime(row[1]), staff = row[2], reason = row[3] || 'ブロック';
      if (result[staff] && result[staff][t]){
        result[staff][t].blocked = true;
        result[staff][t].reason = reason;
      }
    }
  }

  // Bookings
  const canon = s => String(s||'').replace(/[\u200B-\u200D\uFEFF\s　]/g,'').trim();
  for (let r = 1; r < book.length; r++) {
    const row = book[r];
    const d = normDate(row[0]); if (d !== dateISO) continue;
    const start = normTime(row[1]), end = normTime(row[2]); if (!start || !end) continue;

    const rawStaff  = String(row[3]||'').trim();
    const status    = String(row[9]||'').trim();
    const bookingId = String(row[10]||'').trim();
    const uid       = row[12] || '';

    if (!bookingId || /キャンセル|取消|CXL/i.test(status)) continue;

    const keys = Object.keys(result);
    const staffKey = keys.find(k => canon(k) === canon(rawStaff)) || rawStaff;

    let t = start;
    while (t && t < end) {
      const cell = result?.[staffKey]?.[t];
      if (cell) {
        const own = (userId && uid && userId === uid);
        cell.booked = true;
        cell.own = !!own;
        cell.patientName = row[4];
        cell.bookingId   = bookingId;
        cell.symptoms    = row[7];
        cell.fee         = row[8];
        cell.startTime   = start;
        cell.endTime     = end;
      }
      t = incrementTime(t, SLOT_INTERVAL_MINUTES);
      if (t === start) break;
    }
  }
  return result;
}

/* =========================
 * バリデーション/重複/ブロック
 * ========================= */
function validateNewBooking(dateStr, startTime, staff){
  const dateISO = normDate(dateStr);
  const start = normTime(startTime);
  const endTime = incrementTime(start, SLOT_INTERVAL_MINUTES*2);
  if (endTime>'21:00') return '営業時間外のため予約できません。開始時刻を早めてください。';
  const dow = (new Date(dateISO)).getDay();
  if (WEEKLY_OFF[staff] === dow) return staff+'は定休日です。別のスタッフ/日付をご選択ください。';
  if (isBlocked(dateISO, start, staff) || isBlocked(dateISO, incrementTime(start, SLOT_INTERVAL_MINUTES), staff)) return '選択された時間はブロックされています。';
  if (overlapsBooking(dateISO, start, endTime, staff)) return '選択した時間は既に予約があります。別の時間を選んでください。';
  return '';
}

function isBlocked(dateStr, time, staff){
  const dow = (new Date(dateStr)).getDay();
  if (WEEKLY_OFF[staff] === dow) return true;
  const sh = getSheet(SHEET_BLOCK);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++){
    const row=data[i]; if (!row||!row[0]) continue;
    const d = normDate(row[0]);
    if (d===dateStr && normTime(row[1])===time && row[2]===staff) return true;
  }
  return false;
}

function overlapsBooking(dateStr, startTime, endTime, staff){
  const sh = getSheet(SHEET_BOOK);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++){
    const row=data[i]; if (!row||!row[0]) continue;
    if (normDate(row[0])===dateStr && row[3]===staff && row[9]==='予約済み'){
      const s=normTime(row[1]), e=normTime(row[2]);
      if (startTime<e && endTime>s) return true;
    }
  }
  return false;
}

function getTimesForRange(range){
  const times=[];
  for (let h=START_HOUR; h<END_HOUR; h++){
    for (let m=0; m<60; m+=SLOT_INTERVAL_MINUTES){
      const t=('0'+h).slice(-2)+':'+('0'+m).slice(-2);
      if (range==='am' && t<='12:30') times.push(t);
      else if (range==='pm' && t>='13:00' && t<='20:30') times.push(t);
      else if (range==='all' && t<='20:30') times.push(t);
    }
  }
  return times;
}

/* =========================
 * CRUD: 予約
 * ========================= */
function createBooking(dateStr, startTime, staff, patientName, email, phone, symptoms, userId){
  ensureSheets();
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try{
    const msg = validateNewBooking(dateStr, startTime, staff);
    if (msg) return {success:false, message:msg};
    const fee = FEES[staff]||0;
    const id = Utilities.getUuid();
    const now = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
    const start = normTime(startTime);
    const endTime = incrementTime(start, SLOT_INTERVAL_MINUTES*2);
    getSheet(SHEET_BOOK).appendRow([
  normDate(dateStr), start, endTime, staff, patientName, email, phone,
  (symptoms||''), fee, '予約済み', id, now, (userId||'')  // ← 13列目
]);

    SpreadsheetApp.flush();
    logEvent('BOOK_CREATE','user',userId,email,phone,id,staff,normDate(dateStr),start,{symptoms, fee});
    sendConfirmationEmail(normDate(dateStr), start, endTime, staff, patientName, email, phone, symptoms, fee, id);
    return {success:true, message:'予約が完了しました。確認メールを送信しました。', schedule:getSchedule(normDate(dateStr), false, userId)};
  } finally { lock.releaseLock(); }
}

function cancelBooking(bookingId){
  ensureSheets();
  const sheet=getSheet(SHEET_BOOK), data=sheet.getDataRange().getValues();
  const today=Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  for (let r=1;r<data.length;r++){
    const row=data[r];
    if (row[10]===bookingId && row[9]==='予約済み'){
      if (normDate(row[0])===today) return {success:false, message:'当日のキャンセルはできません。お電話でご連絡ください。'};
      sheet.getRange(r+1,10).setValue('キャンセル');
      SpreadsheetApp.flush();
      logEvent('BOOK_CANCEL','user',row[12]||'',row[5],row[6],bookingId,row[3],normDate(row[0]),normTime(row[1]),{});
      if (row[5]){
        const body = row[4]+' 様\n\n下記の予約はキャンセルされました。\n'
          +'日時: '+normDate(row[0])+' '+normTime(row[1])+'〜'+normTime(row[2])+'\nスタッフ: '+row[3]+'\n\n針灸利用センター';
        MailApp.sendEmail(row[5], '【キャンセル通知】針灸予約がキャンセルされました', body);
      }
      return {success:true, message:'キャンセルしました。', schedule:getSchedule(normDate(row[0]), false, row[12]||'')};
    }
  }
  return {success:false, message:'該当する予約が見つかりませんでした。'};
}

function adminCreateBooking(dateStr, startTime, staff, patientName, email, phone, symptoms, adminMemo){
  ensureSheets();
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try{
    const msg = validateNewBooking(dateStr, startTime, staff);
    if (msg) return {success:false, message:msg};

    const fee   = FEES[staff] || 0;
    const id    = Utilities.getUuid();
    const now   = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
    const start = normTime(startTime);
    const end   = incrementTime(start, SLOT_INTERVAL_MINUTES*2);

    const sh = getSheet(SHEET_BOOK);
    sh.appendRow([normDate(dateStr), start, end, staff, patientName, email, phone, (symptoms||''), fee, '予約済み', id, now, '']);
    const last = sh.getLastRow();
    if (adminMemo) sh.getRange(last, 1).setNote(adminMemo);
    SpreadsheetApp.flush();

    logEvent('BOOK_CREATE','admin','', email, phone, id, staff, normDate(dateStr), start, {symptoms, fee, source:'admin'});
    sendConfirmationEmail(normDate(dateStr), start, end, staff, patientName, email, phone, symptoms, fee, id);

    return {success:true, message:'予約を登録しました。', schedule:getSchedule(normDate(dateStr), true)};
  } finally { lock.releaseLock(); }
}

function adminCancelBooking(bookingId){
  ensureSheets();
  const sheet=getSheet(SHEET_BOOK), data=sheet.getDataRange().getValues();
  for (let r=1;r<data.length;r++){
    const row=data[r];
    if (row[10]===bookingId && row[9]==='予約済み'){
      sheet.getRange(r+1,10).setValue('キャンセル');
      SpreadsheetApp.flush();
      logEvent('BOOK_CANCEL','admin',row[12]||'',row[5],row[6],bookingId,row[3],normDate(row[0]),normTime(row[1]),{override:true});
      if (row[5]){
        const body = row[4]+' 様\n\n下記の予約はキャンセルされました。\n'
          +'日時: '+normDate(row[0])+' '+normTime(row[1])+'〜'+normTime(row[2])+'\nスタッフ: '+row[3]+'\n\n針灸利用センター';
        MailApp.sendEmail(row[5], '【キャンセル通知】針灸予約がキャンセルされました', body);
      }
      return {success:true, message:'キャンセルしました（管理者）。', schedule:getSchedule(normDate(row[0]), true)};
    }
  }
  return {success:false, message:'該当する予約が見つかりませんでした。'};
}

/* =========================
 * ブロック設定
 * ========================= */
function setBlock(dateStr, time, staff, reason, enable){
  ensureSheets();
  const sh = getSheet(SHEET_BLOCK);
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try{
    if (enable && hasBooking(normDate(dateStr), normTime(time), staff)) return {success:false, message:'その時間は既に予約があります。ブロックできません。'};
    const values = sh.getDataRange().getValues();
    for (let i=1;i<values.length;i++){
      const row=values[i]; if (!row||!row[0]) continue;
      if (normDate(row[0])===normDate(dateStr) && normTime(row[1])===normTime(time) && row[2]===staff){
        if (enable){ sh.getRange(i+1,4).setValue(reason||'ブロック'); }
        else{ sh.deleteRow(i+1); }
        SpreadsheetApp.flush();
        logEvent(enable?'BLOCK_ON':'BLOCK_OFF','admin','', '', '', '', staff, normDate(dateStr), normTime(time), {reason});
        return {success:true, schedule:getSchedule(normDate(dateStr), true)};
      }
    }
    if (enable){
      const now = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
      sh.appendRow([normDate(dateStr), normTime(time), staff, reason||'ブロック', now, 'admin']);
      SpreadsheetApp.flush();
      logEvent('BLOCK_ON','admin','', '', '', '', staff, normDate(dateStr), normTime(time), {reason});
    }
    return {success:true, schedule:getSchedule(normDate(dateStr), true)};
  } finally { lock.releaseLock(); }
}

function setBlockBulk(dateStr, staff, range, reason, enable){
  ensureSheets();
  const sh = getSheet(SHEET_BLOCK);
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try{
    const values = sh.getDataRange().getValues();
    const times = getTimesForRange(range);
    let added=0, removed=0, skipped=0;
    if (enable){
      const now = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');
      const existing = new Set(values.slice(1).map(r=>normDate(r[0])+'|'+normTime(r[1])+'|'+r[2]));
      const rows = [];
      times.forEach(t=>{
        if (hasBooking(normDate(dateStr),t,staff)) { skipped++; return; }
        const key = normDate(dateStr)+'|'+t+'|'+staff;
        if (!existing.has(key)) { rows.push([normDate(dateStr), t, staff, reason||'ブロック', now, 'admin']); added++; }
      });
      if (rows.length) sh.getRange(sh.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
      SpreadsheetApp.flush();
      logEvent('BLOCK_BULK_ON','admin','', '', '', '', staff, normDate(dateStr), range, {reason, added, skipped});
    }else{
      for (let i=values.length-1;i>=1;i--){
        const row=values[i]; if (!row||!row[0]) continue;
        if (normDate(row[0])===normDate(dateStr) && row[2]===staff && times.indexOf(normTime(row[1]))>-1){
          sh.deleteRow(i+1); removed++;
        }
      }
      SpreadsheetApp.flush();
      logEvent('BLOCK_BULK_OFF','admin','', '', '', '', staff, normDate(dateStr), range, {reason, removed});
    }
    return {success:true, added, removed, skipped, schedule:getSchedule(normDate(dateStr), true)};
  } finally { lock.releaseLock(); }
}

function adminSetBlockRange(dateStr, staff, start, end, reason, enable) {
  ensureSheets();
  const sh   = getSheet(SHEET_BLOCK);
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    const dateISO = normDate(dateStr);
    const now     = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss');

    const times = [];
    (function() {
      let [h,m] = normTime(start).split(':').map(Number);
      const [eh,em] = normTime(end).split(':').map(Number);
      while (h < eh || (h === eh && m < em)) {
        times.push(('0'+h).slice(-2)+':' + ('0'+m).slice(-2));
        m += SLOT_INTERVAL_MINUTES; if (m >= 60) { h++; m -= 60; }
      }
    })();

    if (enable) {
      const values   = sh.getDataRange().getValues();
      const existing = new Set(values.slice(1).map(r => normDate(r[0])+'|'+normTime(r[1])+'|'+r[2]));
      const rows = [];
      times.forEach(t => {
        if (hasBooking(dateISO, t, staff)) return;
        const key = dateISO + '|' + t + '|' + staff;
        if (!existing.has(key)) rows.push([dateISO, t, staff, reason||'ブロック', now, 'admin']);
      });
      if (rows.length) sh.getRange(sh.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);
      SpreadsheetApp.flush();
    } else {
      const values = sh.getDataRange().getValues();
      for (let i = values.length-1; i >= 1; i--) {
        const r = values[i]; if (!r || !r[0]) continue;
        if (normDate(r[0])===dateISO && r[2]===staff && times.indexOf(normTime(r[1]))>-1) {
          sh.deleteRow(i+1);
        }
      }
      SpreadsheetApp.flush();
    }
    return { success:true, schedule:getSchedule(dateISO, true) };
  } finally {
    lock.releaseLock();
  }
}

function hasBooking(dateStr, time, staff){
  const sh = getSheet(SHEET_BOOK);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++){
    const row=data[i]; if (!row||!row[0]) continue;
    if (normDate(row[0])===dateStr && row[3]===staff && row[9]==='予約済み'){
      const start=normTime(row[1]), end=normTime(row[2]);
      if (time>=start && time<end) return true;
    }
  }
  return false;
}

/* =========================
 * 予約詳細/管理補助
 * ========================= */
function getBookingDetails(bookingId){
  ensureSheets();
  const sheet = getSheet(SHEET_BOOK);
  const data  = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++){
    const row = data[r];
    if (row[10] === bookingId){
      const memo = sheet.getRange(r+1, 1).getNote() || '';
      return {
        date:       normDate(row[0]),
        startTime:  normTime(row[1]),
        endTime:    normTime(row[2]),
        staff:      row[3],
        patientName:row[4],
        email:      row[5],
        phone:      row[6],
        symptoms:   row[7],
        fee:        row[8],
        status:     row[9],
        bookingId:  row[10],
        createdAt:  row[11],
        adminMemo:  memo
      };
    }
  }
  return null;
}

function adminUpdateBooking(bookingId, payload){
  ensureSheets();
  const sheet = getSheet(SHEET_BOOK);
  const data  = sheet.getDataRange().getValues();

  for (let r = 1; r < data.length; r++){
    const row = data[r];
    if (row[10] === bookingId && row[9] === '予約済み'){
      const rowIndex = r + 1;

      if (payload.patientName !== undefined) sheet.getRange(rowIndex, 5).setValue(payload.patientName);
      if (payload.email      !== undefined) sheet.getRange(rowIndex, 6).setValue(payload.email);
      if (payload.phone      !== undefined) sheet.getRange(rowIndex, 7).setValue(payload.phone);
      if (payload.symptoms   !== undefined) sheet.getRange(rowIndex, 8).setValue(payload.symptoms);
      if (payload.adminMemo  !== undefined) sheet.getRange(rowIndex, 1).setNote(payload.adminMemo || '');

      SpreadsheetApp.flush();
      logEvent('BOOK_UPDATE','admin', row[12]||'', payload.email||row[5], payload.phone||row[6], bookingId, row[3], normDate(row[0]), normTime(row[1]), payload||{});
      return {success:true, message:'更新しました。', schedule:getSchedule(normDate(row[0]), true)};
    }
  }
  return {success:false, message:'予約が見つかりません。'};
}

/* =========================
 * メール通知（任意・残置）
 * ========================= */
function sendConfirmationEmail(dateStr, startTime, endTime, staff, name, email, phone, symptoms, fee, id){
  if (email){
    let body = name+' 様\n\n下記内容で予約を承りました。\n'
      +'予約日: '+dateStr+'\n時間: '+startTime+'〜'+endTime+'\nスタッフ: '+staff+'\n料金: '+fee+'円\n';
    if (symptoms) body += '症状: '+symptoms+'\n';
    body += '\n当日キャンセルはお電話のみ対応です。/ 針灸利用センター';
    MailApp.sendEmail(email,'【予約確認】針灸予約ありがとうございます', body);
  }
  const admin = getAdminEmail();
  if (admin){
    const body = ['新規予約があります。','予約ID: '+id,'日時: '+dateStr+' '+startTime+'〜'+endTime,'スタッフ: '+staff,'患者名: '+name,'メール: '+(email||'-'),'電話: '+(phone||'-'),'料金: '+fee+'円',symptoms?('症状: '+symptoms):''].join('\n');
    MailApp.sendEmail(admin,'新規予約通知 ('+dateStr+' '+startTime+')', body);
  }
}
function getAdminEmail(){ return 'admin@example.com'; } // ← 適宜変更

/* =========================
 * 管理補助: クリックから予約検索
 * ========================= */
function adminFindFirstByTime(dateISO, timeHHmm){
  ensureSheets();
  const sh = getSheet(SHEET_BOOK);
  const v  = sh.getDataRange().getValues();

  const date = normDate(dateISO);
  const tMin = toMin(normTime(timeHHmm));
  const canceled = s => /キャンセル|取消|CXL/i.test(String(s||''));

  for (let r = 1; r < v.length; r++){
    const row = v[r];
    if (!row || !row[0]) continue;
    if (normDate(row[0]) !== date) continue;
    if (canceled(row[9])) continue;

    const sMin = toMin(normTime(row[1]));
    const eMin = toMin(normTime(row[2]));
    if (!(isFinite(sMin) && isFinite(eMin) && isFinite(tMin))) continue;
    if (tMin >= sMin && tMin < eMin){
      const memo = sh.getRange(r+1,1).getNote() || '';
      return {
        date: normDate(row[0]),
        startTime: normTime(row[1]),
        endTime: normTime(row[2]),
        staff: row[3],
        patientName: row[4],
        email: row[5],
        phone: row[6],
        symptoms: row[7],
        fee: row[8],
        status: String(row[9]||'').trim(),
        bookingId: row[10],
        createdAt: row[11],
        adminMemo: memo
      };
    }
  }
  return null;

  function toMin(hhmm){
    const m = String(hhmm||'').match(/(\d{2}):(\d{2})/);
    return m ? (+m[1])*60 + (+m[2]) : NaN;
  }
}

function adminGetBookingByKey(dateISO, staff, timeHHmm){
  ensureSheets();
  const sh = getSheet(SHEET_BOOK);
  const v  = sh.getDataRange().getValues();

  const date  = normDate(dateISO);
  const tMin  = toMin(normTime(timeHHmm));
  const canon = s => String(s||'').replace(/[\u200B-\u200D\uFEFF\s　]/g,'').trim();
  const want  = canon(staff);
  const isCanceled = s => /キャンセル|取消|CXL/i.test(String(s||''));
  const toDetail = (r,row) => {
    const memo = sh.getRange(r+1,1).getNote() || '';
    return {
      date: normDate(row[0]),
      startTime: normTime(row[1]),
      endTime: normTime(row[2]),
      staff: row[3],
      patientName: row[4],
      email: row[5],
      phone: row[6],
      symptoms: row[7],
      fee: row[8],
      status: String(row[9]||'').trim(),
      bookingId: row[10],
      createdAt: row[11],
      adminMemo: memo
    };
  };
  const hits = [];
  for (let r=1; r<v.length; r++){
    const row = v[r];
    if (!row || !row[0]) continue;
    if (normDate(row[0]) !== date) continue;
    if (isCanceled(row[9])) continue;

    const sMin = toMin(normTime(row[1]));
    const eMin = toMin(normTime(row[2]));
    if (!(isFinite(sMin) && isFinite(eMin) && isFinite(tMin))) continue;

    if (tMin < sMin || tMin >= eMin) continue;

    hits.push({ r, row });
  }
  if (!hits.length) return null;

  const pick = hits.find(h => {
    const rowStaff = canon(h.row[3]);
    return !want || rowStaff === want || rowStaff.startsWith(want) || want.startsWith(rowStaff);
  }) || hits[0];

  return toDetail(pick.r, pick.row);

  function toMin(hhmm){
    const m = String(hhmm||'').match(/(\d{2}):(\d{2})/);
    return m ? (+m[1])*60 + (+m[2]) : NaN;
  }
}

/* =========================
 * REST API（HtmlServiceバナー無し）
 * ========================= */
const LINE_CHANNEL_ID = '2007980232';   // ← LINE Login/ミニアプリのチャネルID
const CORS_ALLOWED_ORIGIN = 'https://89center.net'; // ← STUDIO本番URL

function doOptions(e) { return cors_(ContentService.createTextOutput(''), 204); }

function doPost(e) {
  try {
    ensureSheets();

    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'empty body' }, 400);
    }
    const req = JSON.parse(e.postData.contents || '{}');
    const action = String(req.action || '').trim();
    if (!action) return json_({ ok:false, error:'no action' }, 400);

    // id_token 検証（health/registerPublic 以外は必須）
    let claims = null;
    if (req.id_token) {
      claims = verifyIdToken_(req.id_token);
      if (!claims || !claims.sub) return json_({ ok:false, error:'invalid id_token' }, 401);
    } else if (action !== 'health' && action !== 'registerPublic') {
      return json_({ ok:false, error:'id_token required' }, 401);
    }
    const userId = claims ? claims.sub : (req.userId || '');

    switch (action) {
      case 'health':
        return json_({ ok:true, version:'v4.4-api-nopush', time: Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm:ss') });

      case 'register': {
        logEvent('USER_REGISTER', 'user', userId, '', '', '', '', '', '', { profile: req.profile || null });
        return json_({ ok:true, userId });
      }

      case 'getSchedule': {
        const dateStr = req.date || Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
        const schedule = getSchedule(dateStr, false, userId);
        return json_({ ok:true, date: normDate(dateStr), schedule });
      }

      case 'createBooking': {
        const p = req.payload || req;
        const r = createBooking(p.date, p.startTime, p.staff, p.patientName, p.email, p.phone, p.symptoms, userId);
        return json_({ ok: !!r.success, message: r.message || '', schedule: r.schedule || null });
      }

      case 'cancelBooking': {
        const bookingId = String(req.bookingId || '');
        if (!bookingId) return json_({ ok:false, error:'bookingId required' }, 400);
        const r = cancelBooking(bookingId);
        return json_({ ok: !!r.success, message: r.message || '', schedule: r.schedule || null });
      }

      case 'getBookingDetails': {
        const bookingId = String(req.bookingId || '');
        if (!bookingId) return json_({ ok:false, error:'bookingId required' }, 400);
        const d = getBookingDetails(bookingId);
        if (d) {
          const sheet = getSheet(SHEET_BOOK);
          const data  = sheet.getDataRange().getValues();
          let ownerOk = false;
          for (let r=1; r<data.length; r++) {
            const row = data[r];
            if (row[10] === bookingId) { ownerOk = (String(row[12]||'') === userId); break; }
          }
          if (!ownerOk) return json_({ ok:false, error:'forbidden' }, 403);
        }
        return json_({ ok: !!d, detail: d || null });
      }

      default:
        return json_({ ok:false, error:'unknown action' }, 400);
    }
  } catch (err) {
    return json_({ ok:false, error:String(err) }, 500);
  }
}

function json_(obj, status) {
  const out = ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  return cors_(out, status || 200);
}
function cors_(out, status) {
  const resp = out || ContentService.createTextOutput('');
  const raw = resp.getResponse ? resp.getResponse() : null;
  if (raw) {
    raw.setStatusCode(status || 200);
    raw.setHeader('Access-Control-Allow-Origin', CORS_ALLOWED_ORIGIN);
    raw.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    raw.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return resp;
}

// LINE Login/ミニアプリのid_token検証
function verifyIdToken_(idToken) {
  const url = 'https://api.line.me/oauth2/v2.1/verify';
  const payload = { id_token: idToken, client_id: LINE_CHANNEL_ID };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload,
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) return null;
  const json = JSON.parse(res.getContentText() || '{}');
  if (json && json.sub && json.aud === LINE_CHANNEL_ID) {
    Logger.log('verifyIdToken_ success sub: ' + json.sub);
    return json;
  }
  return null;
}
