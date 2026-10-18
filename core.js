/* core.js — шифрування, хеші, правила редагування й формування файлу змін.
   Працює і в браузері (глобальний об'єкт TSC), і в Node.js (для тестів). */
(function (root) {
  'use strict';
  const ITER = 600000;                       // має збігатися з tsc_sync.py
  const te = new TextEncoder(), td = new TextDecoder();
  const MAGIC_PACK = te.encode('TSCPK1');    // пакети з ПК і файли змін
  const MAGIC_LOCAL = te.encode('TSCLC1');   // локальне сховище на телефоні
  const cr = globalThis.crypto, subtle = cr.subtle;

  const F = {
    NUM: '№', NAME: "Ім'я обладнання", MAC: 'МАС адреса', STATUS: 'Статус', TYPE: 'Тип обладнання',
    USER: 'Користувач (ПІБ)', OS: 'Тип ОС', MFR: 'Виробник обладнання', NOTES: 'Примітки',
    LOGIN: "Ім'я користувача", PASS: 'Пароль',
  };
  // обов'язкові поля, якщо запис не порожній (змінюється тут)
  const REQUIRED = [F.NAME, F.TYPE, F.STATUS];

  const norm = v => String(v == null ? '' : v).trim();

  // ---------- шифрування (AES-256-GCM, ключ PBKDF2-SHA256) ----------
  async function deriveKey(password, salt) {
    const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function concat(...arrs) {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; } return out;
  }
  async function encryptObj(obj, key, salt, magic) {
    const iv = cr.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: magic }, key,
      te.encode(JSON.stringify(obj))));
    return concat(magic, salt, iv, ct);
  }
  async function decryptBlob(bytes, password, magic) {
    bytes = new Uint8Array(bytes);
    if (bytes.length < 6 + 16 + 12 + 16 || !magic.every((b, i) => bytes[i] === b))
      throw new Error('Це не пакет tsc_sync або файл пошкоджено.');
    const salt = bytes.slice(6, 22), iv = bytes.slice(22, 34), ct = bytes.slice(34);
    const key = await deriveKey(password, salt);
    let plain;
    try { plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: magic }, key, ct); }
    catch (e) { throw new Error('Невірний пароль або файл змінено/пошкоджено.'); }
    return { obj: JSON.parse(td.decode(plain)), key, salt };
  }

  // ---------- хеш рядка (збігається з row_hash у tsc_sync.py) ----------
  async function pyHash(values, fields) {
    const s = '[' + fields.map(f => JSON.stringify(norm(values[f]))).join(', ') + ']';
    const d = new Uint8Array(await subtle.digest('SHA-256', te.encode(s)));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  // ---------- дані ----------
  function baseValues(pack, row) {
    const o = {}; pack.fields.forEach((f, i) => { o[f] = norm(row.v[i]); }); return o;
  }
  const key = (sheet, ip) => sheet + '|' + ip;
  function effective(state, sheet, row) {
    const b = baseValues(state.pack, row), e = state.edits[key(sheet, row.ip)];
    if (e) Object.assign(b, e.values);
    return b;
  }
  function userInfo(pack, name) {
    const u = pack.users.find(x => x['ПІБ'] === name);
    return u ? { tsc: u['ТСЦ'] || '', dept: u['Відділ'] || '', phone: u['Телефон'] || '', post: u['Посада'] || '' }
             : { tsc: '', dept: '', phone: '', post: '' };
  }

  // Зберігає зміни запису. full — повні нові значення всіх полів.
  function applyEdit(state, sheet, row, full) {
    const pack = state.pack, base = baseValues(pack, row), k = key(sheet, row.ip), old = state.edits[k];
    const next = {}; pack.fields.forEach(f => { next[f] = norm(full[f]); });
    const diff = {}; pack.fields.forEach(f => { if (next[f] !== base[f]) diff[f] = next[f]; });
    const wasExported = !!(old && old.exported_hashes && old.exported_hashes.length);
    // якщо запис уже експортувався, на ПК могла застосуватися попередня версія: передаємо весь рядок
    if (!Object.keys(diff).length && !wasExported) { delete state.edits[k]; return false; }
    const values = wasExported ? next : diff;
    const same = old && JSON.stringify(old.values) === JSON.stringify(values);
    state.edits[k] = {
      sheet, ip: row.ip, base_hash: row.h, values,
      change_id: same ? old.change_id : cr.randomUUID(),
      exported_hashes: old ? old.exported_hashes || [] : [],
      updated_at: same ? old.updated_at : new Date().toISOString(),
      exported_at: same ? old.exported_at || null : null,
    };
    return true;
  }
  const isPending = e => !e.exported_at || e.exported_at < e.updated_at;

  async function buildChanges(state) {
    const pack = state.pack, changes = [], now = new Date().toISOString();
    for (const e of Object.values(state.edits)) {
      const row = pack.sheets[e.sheet].find(r => r.ip === e.ip);
      changes.push({ change_id: e.change_id, sheet: e.sheet, ip: e.ip, base_hash: e.base_hash,
        also_ok: [...e.exported_hashes], values: e.values });
      const h = await pyHash(effective(state, e.sheet, row), pack.fields);
      if (!e.exported_hashes.includes(h)) e.exported_hashes.push(h);
      e.exported_at = now; if (e.updated_at > now) e.updated_at = now;
    }
    return { format: 'tsc-changes', version: 1, based_on_export_id: pack.export_id, device: 'android',
      created_at: now, fields: pack.fields, changes };
  }

  // ---------- перевірка запису ----------
  function normMac(s) {
    const t = norm(s).replace(/[\s:.\-]/g, '').toUpperCase();
    return /^[0-9A-F]{12}$/.test(t) ? t.match(/../g).join(':') : null;
  }
  function validate(state, sheet, row, v) {
    const pack = state.pack, errors = [], warnings = [];
    const empty = pack.fields.every(f => !norm(v[f]));
    if (empty) return { errors, warnings, empty: true, values: v };
    for (const f of REQUIRED) if (pack.fields.includes(f) && !norm(v[f])) errors.push(`Заповніть поле «${f}».`);
    if (norm(v[F.NUM]) && !/^\d+$/.test(norm(v[F.NUM]))) errors.push('Поле «№» має бути цілим числом.');
    const L = pack.lists;
    const inList = (f, list) => { if (norm(v[f]) && !list.includes(norm(v[f]))) errors.push(`«${f}»: значення немає в довіднику.`); };
    inList(F.TYPE, L.equipment); inList(F.OS, L.os); inList(F.MFR, L.manufacturers);
    inList(F.STATUS, pack.statuses); inList(F.USER, pack.users.map(u => u['ПІБ']));
    if (norm(v[F.MAC])) {
      const m = normMac(v[F.MAC]);
      if (m) v[F.MAC] = m; else warnings.push('МАС-адреса має вигляд, відмінний від AA:BB:CC:DD:EE:FF.');
      const mac = norm(v[F.MAC]).toUpperCase();
      for (const r of pack.sheets[sheet]) {
        if (r.ip === row.ip) continue;
        if (norm(effective(state, sheet, r)[F.MAC]).toUpperCase() === mac) { warnings.push(`Така МАС-адреса вже є в записі ${r.ip}.`); break; }
      }
    }
    return { errors, warnings, empty: false, values: v };
  }

  root.TSC = { MAGIC_PACK, MAGIC_LOCAL, F, REQUIRED, norm, deriveKey, encryptObj, decryptBlob, pyHash,
    baseValues, effective, userInfo, applyEdit, isPending, buildChanges, validate, normMac };
  if (typeof module !== 'undefined') module.exports = root.TSC;
})(typeof window !== 'undefined' ? window : globalThis);
