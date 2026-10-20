/* core.js (v2) — шифрування, хеші, правила редагування пристроїв і довідників, формування файлу змін.
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
  const REQUIRED = [F.NAME, F.TYPE, F.STATUS];     // обов'язкові поля пристрою, якщо запис не порожній
  const COLLS = ['users', 'equipment', 'os', 'manufacturers', 'departments'];   // довідники, які можна редагувати
  const TITLES = { users: 'Співробітники', equipment: 'Типи обладнання', os: 'Типи ОС', manufacturers: 'Виробники',
    departments: 'Відділи', tsc: 'ТСЦ (лише перегляд)' };
  const USER_DEPT = 'Відділ', USER_KEY = 'ПІБ';
  const DEVICE_FIELD = { equipment: F.TYPE, os: F.OS, manufacturers: F.MFR };   // у якому полі пристрою застосовується довідник
  const DATE_FIELDS = ['Працює з', 'Дата народження', 'Дата закінчення дії ключа'];
  const REQUIRED_USER = [USER_KEY];

  const norm = v => String(v == null ? '' : v).trim();
  const now = () => new Date().toISOString();
  const uid = () => cr.randomUUID();

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

  // ---------- хеш запису (збігається з row_hash у tsc_sync.py) ----------
  async function pyHash(values, fields) {
    const s = '[' + fields.map(f => JSON.stringify(norm(values[f]))).join(', ') + ']';
    const d = new Uint8Array(await subtle.digest('SHA-256', te.encode(s)));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  // ---------- стан ----------
  function newState(pack) {
    const refEdits = {}; COLLS.forEach(c => { refEdits[c] = {}; });
    return { pack, edits: {}, refEdits, opened_at: now() };
  }
  const cache = new WeakMap();                 // обчислювані індекси (не зберігаються на диску)
  const inv = state => cache.delete(state);

  // ---------- довідники ----------
  const recObj = (def, rec) => { const o = {}; def.fields.forEach((f, i) => { o[f] = norm(rec.v[i]); }); return o; };
  function refRecords(state, coll) {
    const def = state.pack.refs[coll], E = (state.refEdits || {})[coll] || {}, out = [];
    for (const rec of def.records) {
      const values = recObj(def, rec), lid = 'p:' + values[def.key], e = E[lid];
      if (e) { if (e.op === 'delete') continue; out.push({ lid, values: { ...e.values }, edited: true, isNew: false }); }
      else out.push({ lid, values, edited: false, isNew: false });
    }
    for (const e of Object.values(E)) if (e.op === 'add') out.push({ lid: e.lid, values: { ...e.values }, edited: true, isNew: true });
    return out;
  }
  function getCache(state) {
    let c = cache.get(state);
    if (!c) {
      c = { users: new Map(), lists: {}, devCount: null };
      for (const r of refRecords(state, 'users')) c.users.set(r.values[USER_KEY], r.values);
      for (const k of ['equipment', 'os', 'manufacturers', 'departments'])
        c.lists[k] = refRecords(state, k).map(r => r.values[state.pack.refs[k].key]);
      c.lists.users = [...c.users.keys()];
      const tdef = state.pack.refs.tsc, ti = tdef.fields.indexOf(tdef.key);
      c.lists.tsc = tdef.records.map(r => norm(r.v[ti]));
      cache.set(state, c);
    }
    return c;
  }
  const lists = state => getCache(state).lists;
  function userInfo(state, name) {
    const u = getCache(state).users.get(norm(name));
    return u ? { tsc: u['ТСЦ'] || '', dept: u[USER_DEPT] || '', phone: u['Телефон'] || '', post: u['Посада'] || '' }
             : { tsc: '', dept: '', phone: '', post: '' };
  }

  // ---------- пристрої ----------
  function baseValues(pack, row) {
    const o = {}; pack.fields.forEach((f, i) => { o[f] = norm(row.v[i]); }); return o;
  }
  const key = (sheet, ip) => sheet + '|' + ip;
  function effective(state, sheet, row) {
    const b = baseValues(state.pack, row), e = state.edits[key(sheet, row.ip)];
    if (e) Object.assign(b, e.values);
    return b;
  }
  // Усі пристрої, у яких поле field має значення value
  function devicesWith(state, field, value) {
    const out = [];
    for (const sheet of Object.keys(state.pack.sheets)) for (const row of state.pack.sheets[sheet]) {
      const v = effective(state, sheet, row);
      if (v[field] === value) out.push({ sheet, row, values: v });
    }
    return out;
  }
  function deviceCounts(state) {
    const c = getCache(state);
    if (!c.devCount) {
      c.devCount = new Map();
      for (const sheet of Object.keys(state.pack.sheets)) for (const row of state.pack.sheets[sheet]) {
        const u = effective(state, sheet, row)[F.USER];
        if (u) c.devCount.set(u, (c.devCount.get(u) || 0) + 1);
      }
    }
    return c.devCount;
  }

  // Зберігає зміни пристрою. full — повні нові значення всіх полів.
  function applyEdit(state, sheet, row, full) {
    inv(state);
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
      change_id: same ? old.change_id : uid(),
      exported_hashes: old ? old.exported_hashes || [] : [],
      updated_at: same ? old.updated_at : now(),
      exported_at: same ? old.exported_at || null : null,
    };
    return true;
  }
  const isPending = e => !e.exported_at || e.exported_at < e.updated_at;

  // ---------- збереження записів довідників ----------
  function refSave(state, coll, lid, values) {
    const def = state.pack.refs[coll], kf = def.key, vals = {};
    def.fields.forEach(f => { vals[f] = norm(values[f]); });
    if (!vals[kf]) return { error: `Поле «${kf}» обов'язкове.` };
    const dup = refRecords(state, coll).find(r => r.lid !== lid && r.values[kf].toLowerCase() === vals[kf].toLowerCase());
    if (dup) return { error: `«${vals[kf]}» уже є в довіднику.` };
    inv(state);
    const E = state.refEdits[coll], old = lid ? E[lid] : null;
    if (!lid) {
      lid = 'n:' + uid();
      E[lid] = { lid, op: 'add', orig: null, base_hash: null, values: vals, exported_hashes: [], exported_keys: [],
        change_id: uid(), updated_at: now(), exported_at: null };
      return { lid };
    }
    const hist = !!(old && old.exported_hashes.length);
    let baseHash = null, op = 'add', unchanged = false;
    if (lid.startsWith('p:')) {
      const idx = def.records.findIndex(r => 'p:' + norm(r.v[def.fields.indexOf(kf)]) === lid);
      const rec = def.records[idx], b = recObj(def, rec);
      baseHash = rec.h; op = 'update'; unchanged = def.fields.every(f => b[f] === vals[f]);
    }
    if (unchanged && !hist) { delete E[lid]; return { lid }; }
    const same = old && old.op === op && JSON.stringify(old.values) === JSON.stringify(vals);
    E[lid] = { lid, op, orig: lid.startsWith('p:') ? lid.slice(2) : null, base_hash: baseHash, values: vals,
      exported_hashes: old ? old.exported_hashes : [], exported_keys: old ? old.exported_keys : [],
      change_id: same ? old.change_id : uid(), updated_at: same ? old.updated_at : now(), exported_at: same ? old.exported_at : null };
    return { lid };
  }
  function refDelete(state, coll, lid) {
    inv(state);
    const def = state.pack.refs[coll], E = state.refEdits[coll], old = E[lid];
    if (lid.startsWith('n:')) {
      if (!old || !old.exported_hashes.length) { delete E[lid]; return; }
      E[lid] = { ...old, op: 'delete', values: null, change_id: uid(), updated_at: now(), exported_at: null };
      return;
    }
    const idx = def.records.findIndex(r => 'p:' + norm(r.v[def.fields.indexOf(def.key)]) === lid);
    E[lid] = { lid, op: 'delete', orig: lid.slice(2), base_hash: def.records[idx].h, values: null,
      exported_hashes: old ? old.exported_hashes : [], exported_keys: old ? old.exported_keys : [],
      change_id: uid(), updated_at: now(), exported_at: null };
  }
  // Де використовується значення довідника: { devices: [...], users: [...] }
  function usage(state, coll, value) {
    value = norm(value);
    if (coll === 'users') return { devices: devicesWith(state, F.USER, value), users: [] };
    if (DEVICE_FIELD[coll]) return { devices: devicesWith(state, DEVICE_FIELD[coll], value), users: [] };
    if (coll === 'departments') return { devices: [], users: refRecords(state, 'users').filter(r => r.values[USER_DEPT] === value) };
    return { devices: [], users: [] };
  }
  // Каскадне перейменування: оновлює всі записи, які посилаються на старе значення. Повертає кількість.
  function cascadeRename(state, coll, oldKey, newKey) {
    const use = usage(state, coll, oldKey); let n = 0;
    const field = coll === 'users' ? F.USER : DEVICE_FIELD[coll];
    for (const d of use.devices) { const v = { ...d.values, [field]: newKey }; applyEdit(state, d.sheet, d.row, v); n++; }
    for (const u of use.users) { refSave(state, 'users', u.lid, { ...u.values, [USER_DEPT]: newKey }); n++; }
    return n;
  }

  function clearEdits(state) { state.edits = {}; COLLS.forEach(k => { state.refEdits[k] = {}; }); inv(state); }

  // ---------- кількість змін ----------
  const refEditList = state => COLLS.flatMap(c => Object.values(state.refEdits[c] || {}).map(e => ({ ...e, coll: c })));
  const allPending = state => [...Object.values(state.edits), ...refEditList(state)];
  const countChanges = state => allPending(state).length;
  const countUnexported = state => allPending(state).filter(isPending).length;

  // ---------- файл змін ----------
  async function buildChanges(state) {
    const pack = state.pack, changes = [], ref_changes = [], stamp = now();
    for (const e of Object.values(state.edits)) {
      const row = pack.sheets[e.sheet].find(r => r.ip === e.ip);
      changes.push({ change_id: e.change_id, sheet: e.sheet, ip: e.ip, base_hash: e.base_hash,
        also_ok: [...e.exported_hashes], values: e.values });
      const h = await pyHash(effective(state, e.sheet, row), pack.fields);
      if (!e.exported_hashes.includes(h)) e.exported_hashes.push(h);
      e.exported_at = stamp; if (e.updated_at > stamp) e.updated_at = stamp;
    }
    for (const coll of COLLS) {
      const def = pack.refs[coll];
      for (const e of Object.values(state.refEdits[coll])) {
        const keys = [...new Set([e.orig, ...e.exported_keys, e.values && e.values[def.key]].filter(Boolean))];
        ref_changes.push({ change_id: e.change_id, coll, op: e.op, base_hash: e.base_hash,
          also_ok: [...e.exported_hashes], match_keys: keys, values: e.values });
        if (e.values) {
          const h = await pyHash(e.values, def.fields);
          if (!e.exported_hashes.includes(h)) e.exported_hashes.push(h);
          if (!e.exported_keys.includes(e.values[def.key])) e.exported_keys.push(e.values[def.key]);
        }
        e.exported_at = stamp; if (e.updated_at > stamp) e.updated_at = stamp;
      }
    }
    return { format: 'tsc-changes', version: 2, based_on_export_id: pack.export_id, device: 'android',
      created_at: stamp, fields: pack.fields, changes, ref_changes };
  }

  // ---------- перевірки ----------
  function normMac(s) {
    const t = norm(s).replace(/[\s:.\-]/g, '').toUpperCase();
    return /^[0-9A-F]{12}$/.test(t) ? t.match(/../g).join(':') : null;
  }
  function validDate(s) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s); if (!m) return false;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return d.getFullYear() === +m[3] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[1];
  }
  function validate(state, sheet, row, v) {
    const pack = state.pack, errors = [], warnings = [], L = lists(state);
    const empty = pack.fields.every(f => !norm(v[f]));
    if (empty) return { errors, warnings, empty: true, values: v };
    for (const f of REQUIRED) if (pack.fields.includes(f) && !norm(v[f])) errors.push(`Заповніть поле «${f}».`);
    if (norm(v[F.NUM]) && !/^\d+$/.test(norm(v[F.NUM]))) errors.push('Поле «№» має бути цілим числом.');
    const inList = (f, list) => { if (norm(v[f]) && !list.includes(norm(v[f]))) errors.push(`«${f}»: значення немає в довіднику.`); };
    inList(F.TYPE, L.equipment); inList(F.OS, L.os); inList(F.MFR, L.manufacturers);
    inList(F.STATUS, pack.statuses); inList(F.USER, L.users);
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
  function validateUser(state, v) {
    const errors = [], warnings = [], L = lists(state);
    if (!norm(v[USER_KEY])) errors.push('Заповніть поле «ПІБ».');
    for (const f of DATE_FIELDS) if (norm(v[f]) && !validDate(norm(v[f]))) errors.push(`«${f}»: дата має бути у форматі ДД.ММ.РРРР.`);
    for (const f of ['Офіційна поштова скринька', 'Особиста поштова скринька'])
      if (norm(v[f]) && !norm(v[f]).includes('@')) warnings.push(`«${f}»: немає символу @.`);
    if (norm(v['ТСЦ']) && !L.tsc.includes(norm(v['ТСЦ']))) errors.push('«ТСЦ»: значення немає в довіднику ТСЦ.');
    if (norm(v[USER_DEPT]) && !L.departments.includes(norm(v[USER_DEPT]))) errors.push('«Відділ»: значення немає в довіднику відділів.');
    return { errors, warnings };
  }

  root.TSC = { MAGIC_PACK, MAGIC_LOCAL, F, REQUIRED, COLLS, TITLES, DEVICE_FIELD, DATE_FIELDS, USER_KEY, USER_DEPT,
    norm, deriveKey, encryptObj, decryptBlob, pyHash, newState, baseValues, effective, userInfo, lists,
    refRecords, refSave, refDelete, usage, cascadeRename, devicesWith, deviceCounts, applyEdit, isPending,
    refEditList, allPending, clearEdits, countChanges, countUnexported, buildChanges, validate, validateUser, normMac, validDate };
  if (typeof module !== 'undefined') module.exports = root.TSC;
})(typeof window !== 'undefined' ? window : globalThis);
