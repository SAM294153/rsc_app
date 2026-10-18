/* app.js — інтерфейс застосунку «Облік ТСЦ». Дані зберігаються лише зашифрованими. */
(() => {
  'use strict';
  const T = window.TSC, F = T.F;
  const AUTOLOCK_MS = 2 * 60 * 1000;      // автоблокування після 2 хв у фоні
  const MAX_RESULTS = 300;

  let S = null, KEY = null, SALT = null;           // стан у пам'яті (null, коли заблоковано)
  let view = { sheet: null, q: '', filter: 'all' };
  let hiddenAt = 0, saveTimer = null, savePromise = Promise.resolve();
  const app = document.getElementById('app');

  // ---------- допоміжні ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  function toast(msg) {
    const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 3000);
  }
  function modal(title, body, buttons) {      // buttons: [{label, value, cls}] -> Promise(value)
    return new Promise(res => {
      const close = v => { m.remove(); res(v); };
      const m = h('div', { class: 'modal' }, h('div', { class: 'box' },
        h('h3', { style: 'margin:0 0 8px' }, title), body,
        h('div', { class: 'acts' }, buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => close(b.value) }, b.label)))));
      document.body.append(m);
    });
  }
  const confirmBox = (title, text, yes = 'Так', cls = 'pri') =>
    modal(title, h('p', {}, text), [{ label: 'Скасувати', value: false }, { label: yes, value: true, cls }]);

  // ---------- IndexedDB ----------
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open('tsc-phone', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  async function idbOp(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); res(req && req.result); }; tx.onerror = () => rej(tx.error);
    });
  }
  const idbGet = k => idbOp('readonly', s => s.get(k));
  const idbSet = (k, v) => idbOp('readwrite', s => s.put(v, k));
  const idbDel = k => idbOp('readwrite', s => s.delete(k));

  function persist(now) {                     // збереження зашифрованого стану (з відкладенням)
    clearTimeout(saveTimer);
    const run = () => { savePromise = savePromise.then(async () => {
      if (!S || !KEY) return;
      await idbSet('state', await T.encryptObj(S, KEY, SALT, T.MAGIC_LOCAL));
    }).catch(e => toast('Помилка збереження: ' + e.message)); return savePromise; };
    if (now) return run();
    saveTimer = setTimeout(run, 300); return savePromise;
  }

  // ---------- екран блокування / відкриття пакета ----------
  async function showStart(note) {
    clear(app);
    const has = !!(await idbGet('state').catch(() => null));
    const pw = h('input', { type: 'password', placeholder: 'Пароль шифрування', autocomplete: 'off' });
    const err = h('div');
    const fileIn = h('input', { type: 'file', accept: '.enc,application/octet-stream', style: 'display:none' });
    const box = h('div', { class: 'center' }, h('h1', {}, 'Облік ТСЦ'));
    if (note) box.append(h('div', { class: 'msg w' }, note));
    if (has) {
      const go = async () => {
        clear(err);
        try {
          const raw = await idbGet('state');
          const r = await T.decryptBlob(raw, pw.value, T.MAGIC_LOCAL);
          S = r.obj; KEY = r.key; SALT = r.salt; showMain();
        } catch (e) { err.append(h('div', { class: 'msg e' }, e.message)); }
      };
      pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      box.append(h('p', { class: 'muted' }, 'Дані на телефоні зашифровані. Введіть пароль, щоб розблокувати.'), pw, err,
        h('div', { style: 'height:12px' }), h('button', { class: 'btn pri', style: 'width:100%', onclick: go }, 'Розблокувати'),
        h('div', { style: 'height:24px' }),
        h('button', { class: 'btn bad', style: 'width:100%', onclick: async () => {
          if (await confirmBox('Стерти дані з телефона?', 'Усі дані й НЕекспортовані зміни буде видалено. Це незворотно.', 'Стерти', 'bad')) {
            await idbDel('state'); showStart();
          } } }, 'Забув пароль / стерти дані'));
    } else {
      box.append(h('p', { class: 'muted' }, 'Даних ще немає. Відкрийте зашифрований пакет (tsc_для_телефона.enc), збережений із хмари.'),
        fileIn, h('button', { class: 'btn pri', style: 'width:100%', onclick: () => fileIn.click() }, 'Відкрити пакет (.enc)'), err);
      fileIn.addEventListener('change', () => { if (fileIn.files[0]) openPack(fileIn.files[0], err); });
    }
    app.append(box);
  }

  async function openPack(file, errBox) {
    const pw = h('input', { type: 'password', placeholder: 'Пароль шифрування', autocomplete: 'off' });
    const ok = await modal('Пароль пакета', h('div', {}, h('p', { class: 'muted' }, file.name), pw),
      [{ label: 'Скасувати', value: false }, { label: 'Відкрити', value: true, cls: 'pri' }]);
    if (!ok) return;
    try {
      const r = await T.decryptBlob(await file.arrayBuffer(), pw.value, T.MAGIC_PACK);
      if (r.obj.format !== 'tsc-pack' || r.obj.version !== 1) throw new Error('Це не пакет даних (очікується tsc-pack, версія 1).');
      const pending = S ? Object.values(S.edits).filter(T.isPending).length : 0;
      if (pending && !(await confirmBox('Є неекспортовані зміни', `Неекспортованих змін: ${pending}. Якщо відкрити новий пакет, вони будуть втрачені. Продовжити?`, 'Замінити', 'bad'))) return;
      if (S && Object.keys(S.edits).length && !pending &&
          !(await confirmBox('Новий пакет', 'Зміни, які ви вже експортували, вважаються внесеними на ПК. Переконайтеся, що вони імпортовані. Замінити дані?', 'Замінити'))) return;
      S = { pack: r.obj, edits: {}, opened_at: new Date().toISOString() }; KEY = r.key; SALT = r.salt;
      view = { sheet: Object.keys(S.pack.sheets)[0], q: '', filter: 'all' };
      await persist(true);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      showMain(); toast('Пакет відкрито');
    } catch (e) { if (errBox) { clear(errBox); errBox.append(h('div', { class: 'msg e' }, e.message)); } else toast(e.message); }
  }

  async function lock(note) {
    clearTimeout(saveTimer); await persist(true);
    S = null; KEY = null; SALT = null; document.querySelectorAll('.modal,.screen').forEach(x => x.remove());
    showStart(note);
  }

  // ---------- головний екран ----------
  let listEl, countEl, badgeBtn;
  function showMain() {
    if (!view.sheet || !S.pack.sheets[view.sheet]) view.sheet = Object.keys(S.pack.sheets)[0];
    clear(app);
    badgeBtn = h('button', { class: 'btn', onclick: showChanges }, '');
    const menu = h('button', { class: 'btn', onclick: showMenu }, '⋮');
    const sheetSel = h('select', { onchange: e => { view.sheet = e.target.value; renderList(); } },
      Object.keys(S.pack.sheets).map(n => h('option', { value: n, selected: n === view.sheet }, n)));
    const q = h('input', { type: 'search', placeholder: 'Пошук: ІР, ім\'я, МАС, користувач… (по всіх ТСЦ)', value: view.q,
      oninput: e => { view.q = e.target.value; renderList(); } });
    const flt = h('select', { onchange: e => { view.filter = e.target.value; renderList(); } },
      [['all', 'Усі'], ['used', 'Зайняті'], ['free', 'Вільні'], ['off', 'Вимкнені'], ['edited', 'Змінені мною']]
        .map(([v, t]) => h('option', { value: v, selected: v === view.filter }, t)));
    countEl = h('div', { class: 'count' }); listEl = h('div', { id: 'list' });
    app.append(h('div', { class: 'top' }, h('h1', {}, 'Облік ТСЦ'), badgeBtn, menu),
      h('div', { class: 'ctrls' }, sheetSel, q, h('div', { class: 'row' }, flt)), countEl, listEl);
    renderList();
  }
  const pendingCount = () => Object.keys(S.edits).length;
  function updateBadge() { if (badgeBtn) badgeBtn.textContent = 'Зміни: ' + pendingCount(); }

  function renderList() {
    updateBadge();
    const q = view.q.trim().toLowerCase(), sheets = q ? Object.keys(S.pack.sheets) : [view.sheet];
    const out = []; let total = 0;
    for (const sh of sheets) for (const row of S.pack.sheets[sh]) {
      const v = T.effective(S, sh, row), u = T.userInfo(S.pack, v[F.USER]);
      const free = S.pack.fields.every(f => !v[f]), edited = !!S.edits[sh + '|' + row.ip];
      if (view.filter === 'used' && free) continue;
      if (view.filter === 'free' && !free) continue;
      if (view.filter === 'off' && v[F.STATUS] !== 'Вимк.') continue;
      if (view.filter === 'edited' && !edited) continue;
      if (q) {
        const hay = (row.ip + ' ' + S.pack.fields.map(f => f === F.PASS ? '' : v[f]).join(' ') + ' ' + u.dept + ' ' + u.phone + ' ' + u.tsc).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      total++; if (out.length < MAX_RESULTS) out.push({ sh, row, v, u, free, edited });
    }
    countEl.textContent = `Знайдено: ${total}` + (total > MAX_RESULTS ? ` (показано ${MAX_RESULTS}, уточніть пошук)` : '');
    clear(listEl);
    for (const it of out) {
      const { sh, row, v, free, edited } = it;
      const st = v[F.STATUS] ? h('span', { class: 'tag ' + (v[F.STATUS] === 'Вимк.' ? 'off' : 'on') }, v[F.STATUS]) : null;
      listEl.append(h('div', { class: 'card' + (free ? ' free' : ''), onclick: () => openEdit(sh, row) },
        h('div', { class: 'l1' }, h('span', { class: 'ip' }, row.ip), h('span', { class: 'nm' }, free ? 'вільно' : (v[F.NAME] || '—'))),
        h('div', { class: 'l2' }, st, edited ? h('span', { class: 'tag chg' }, 'змінено') : null,
          q ? h('span', { class: 'tag' }, sh) : null, [v[F.TYPE], v[F.USER]].filter(Boolean).join(' · '))));
    }
  }

  // ---------- форма запису ----------
  function openEdit(sheet, row) {
    const pack = S.pack, cur = T.effective(S, sheet, row), inputs = {};
    const mk = (f, el) => { inputs[f] = el; return h('div', {}, h('label', {}, f), el); };
    const sel = (f, list) => h('select', {}, h('option', { value: '' }, '—'),
      list.map(x => h('option', { value: x, selected: x === cur[f] }, x)));
    const users = pack.users.map(u => u['ПІБ']);
    const dl = h('datalist', { id: 'dl-users' }, users.map(u => h('option', { value: u })));
    const ro = h('div', { class: 'ro' });
    const upd = () => {
      const u = T.userInfo(pack, inputs[F.USER].value.trim());
      clear(ro).append(h('div', {}, 'Відділ: ', u.dept || '—'), h('div', {}, 'Телефон: ', u.phone || '—'), h('div', {}, 'ТСЦ(РСЦ): ', u.tsc || '—'));
    };
    const fields = pack.fields;
    const parts = [
      mk(F.NUM, h('input', { inputmode: 'numeric', value: cur[F.NUM] })),
      mk(F.NAME, h('input', { value: cur[F.NAME], autocapitalize: 'off' })),
      mk(F.MAC, h('input', { value: cur[F.MAC], autocapitalize: 'characters', placeholder: 'AA:BB:CC:DD:EE:FF' })),
      mk(F.STATUS, sel(F.STATUS, pack.statuses)),
      mk(F.TYPE, sel(F.TYPE, pack.lists.equipment)),
      mk(F.USER, h('input', { value: cur[F.USER], list: 'dl-users', placeholder: 'Почніть вводити ПІБ', oninput: upd })),
      h('label', {}, 'З довідника користувачів (лише перегляд)'), ro,
      mk(F.OS, sel(F.OS, pack.lists.os)),
      mk(F.MFR, sel(F.MFR, pack.lists.manufacturers)),
      mk(F.NOTES, h('textarea', {}, cur[F.NOTES])),
      mk(F.LOGIN, h('input', { value: cur[F.LOGIN], autocapitalize: 'off' })),
    ];
    if (fields.includes(F.PASS)) parts.push(mk(F.PASS, h('input', { value: cur[F.PASS], autocapitalize: 'off' })));
    const msgs = h('div');
    const collect = () => { const v = {}; fields.forEach(f => { v[f] = inputs[f] ? inputs[f].value.trim() : cur[f]; }); return v; };
    const close = () => scr.remove();
    const save = async () => {
      clear(msgs);
      const res = T.validate(S, sheet, row, collect());
      if (res.errors.length) { res.errors.forEach(e => msgs.append(h('div', { class: 'msg e' }, e))); return; }
      if (res.warnings.length && !(await confirmBox('Перевірте дані', res.warnings.join('\n'), 'Все одно зберегти'))) return;
      T.applyEdit(S, sheet, row, res.values); persist(); close(); renderList(); toast('Збережено на телефоні');
    };
    const clearRec = async () => {
      if (await confirmBox('Очистити запис?', `Усі поля запису ${row.ip} буде очищено (адреса стане вільною).`, 'Очистити', 'bad')) {
        const v = {}; fields.forEach(f => { v[f] = ''; }); T.applyEdit(S, sheet, row, v); persist(); close(); renderList();
      }
    };
    const scr = h('div', { class: 'screen' },
      h('div', { class: 'top' }, h('button', { class: 'btn', onclick: close }, '←'), h('h1', {}, `${sheet} · ${row.ip}`)),
      h('div', { class: 'body' }, dl, parts, msgs, h('div', { style: 'height:16px' }),
        h('button', { class: 'btn bad', style: 'width:100%', onclick: clearRec }, 'Очистити запис')),
      h('div', { class: 'bar' }, h('button', { class: 'btn', onclick: close }, 'Скасувати'), h('button', { class: 'btn pri', onclick: save }, 'Зберегти')));
    document.body.append(scr); upd();
  }

  // ---------- зміни й експорт ----------
  function showChanges() {
    const edits = Object.values(S.edits).sort((a, b) => (a.sheet + a.ip).localeCompare(b.sheet + b.ip, 'uk', { numeric: true }));
    const close = () => scr.remove();
    const list = edits.length ? edits.map(e => h('div', { class: 'chrow' },
      h('b', {}, `${e.sheet} · ${e.ip}`), ' ', h('span', { class: 'tag ' + (T.isPending(e) ? 'chg' : 'on') }, T.isPending(e) ? 'не експортовано' : 'експортовано'),
      h('div', { class: 'muted' }, Object.entries(e.values).filter(([f]) => f !== F.PASS).map(([f, v]) => `${f}: ${v || '∅'}`).join('; ')))) :
      [h('p', { class: 'muted' }, 'Змін немає.')];
    const scr = h('div', { class: 'screen' },
      h('div', { class: 'top' }, h('button', { class: 'btn', onclick: close }, '←'), h('h1', {}, 'Зміни для ПК')),
      h('div', { class: 'body' }, h('p', { class: 'muted' }, 'Файл змін зашифрований тим самим паролем. Збережіть його в хмару й імпортуйте на ПК.'), list,
        edits.length ? h('button', { class: 'btn bad', style: 'width:100%;margin-top:16px', onclick: async () => {
          if (await confirmBox('Скасувати всі зміни?', 'Усі зміни на телефоні буде видалено (дані з ПК залишаться).', 'Скасувати зміни', 'bad')) {
            S.edits = {}; persist(true); close(); renderList(); } } }, 'Скасувати всі зміни') : null),
      h('div', { class: 'bar' },
        h('button', { class: 'btn', disabled: !edits.length, onclick: () => doExport('save') }, 'Зберегти файл'),
        h('button', { class: 'btn pri', disabled: !edits.length, onclick: () => doExport('share') }, 'Поділитися…')));
    document.body.append(scr);
  }
  async function doExport(mode) {
    const obj = await T.buildChanges(S);
    if (!obj.changes.length) { toast('Немає змін'); return; }
    const bytes = await T.encryptObj(obj, KEY, SALT, T.MAGIC_PACK); await persist(true);
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `зміни_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.enc`;
    const file = new File([bytes], name, { type: 'application/octet-stream' });
    const download = () => { const a = h('a', { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); toast('Файл змін збережено: ' + name); };
    if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); toast('Файл змін створено'); }
      catch (e) { if (e.name !== 'AbortError') download(); }
    } else download();
    renderList();
  }

  // ---------- меню ----------
  function showMenu() {
    const p = S.pack, fileIn = h('input', { type: 'file', accept: '.enc,application/octet-stream', style: 'display:none',
      onchange: () => { if (fileIn.files[0]) { m.remove(); openPack(fileIn.files[0]); } } });
    const info = h('div', { class: 'muted' },
      h('div', {}, 'Пакет з ПК: ', (p.exported_at || '').replace('T', ' ')), h('div', {}, 'Записів-слотів: ', Object.values(p.sheets).reduce((n, a) => n + a.length, 0)),
      h('div', {}, 'Пароль обладнання на телефоні: ', p.fields.includes(F.PASS) ? 'передається' : 'не передається'));
    const m = h('div', { class: 'modal', onclick: e => { if (e.target === m) m.remove(); } }, h('div', { class: 'box' },
      h('h3', { style: 'margin:0 0 8px' }, 'Меню'), info, fileIn,
      h('div', { class: 'acts', style: 'flex-direction:column' },
        h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Відкрити новий пакет з ПК'),
        h('button', { class: 'btn', onclick: () => { m.remove(); lock(); } }, 'Заблокувати'),
        h('button', { class: 'btn', onclick: () => m.remove() }, 'Закрити'))));
    document.body.append(m);
  }

  // ---------- автоблокування, запуск ----------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); if (S) persist(true); }
    else if (S && hiddenAt && Date.now() - hiddenAt > AUTOLOCK_MS) lock('Застосунок заблоковано через неактивність.');
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  showStart();
})();
