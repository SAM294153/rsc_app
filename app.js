/* app.js (v2) — інтерфейс застосунку «Облік ТСЦ»: пристрої, співробітники, довідники.
   Дані зберігаються лише зашифрованими. */
(() => {
  'use strict';
  const T = window.TSC, F = T.F;
  const AUTOLOCK_MS = 2 * 60 * 1000;      // автоблокування після 2 хв у фоні
  const MAX_RESULTS = 300;
  const OPS = { add: 'додано', update: 'змінено', delete: 'видалено' };

  let S = null, KEY = null, SALT = null;           // стан у пам'яті (null, коли заблоковано)
  let view = { tab: 'dev', sheet: null, q: '', filter: 'all', uq: '' };
  let hiddenAt = 0, saveTimer = null, savePromise = Promise.resolve();
  const app = document.getElementById('app');
  const ukSort = (a, b) => a.localeCompare(b, 'uk');

  // ---------- допоміжні ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
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
  const info = (title, text, ok = 'Зрозуміло') => modal(title, h('p', {}, text), [{ label: ok, value: true, cls: 'pri' }]);

  // ---------- стек екранів ----------
  const stack = [];
  function openScreen(build) {
    const s = { build, el: null, static: false };
    s.el = build(s); document.body.append(s.el); stack.push(s); return s;
  }
  function closeScreen(s) { s.el.remove(); const i = stack.indexOf(s); if (i >= 0) stack.splice(i, 1); }
  function closeAllScreens() { while (stack.length) closeScreen(stack[stack.length - 1]); document.querySelectorAll('.modal').forEach(x => x.remove()); }
  function refreshAll() {
    renderCurrentList(); updateBadge();
    for (const s of [...stack]) {
      if (s.static) continue;
      const n = s.build(s);
      if (n) { s.el.replaceWith(n); s.el = n; } else closeScreen(s);
    }
  }
  const topbar = (title, onBack, extra) => h('div', { class: 'top' },
    h('button', { class: 'btn', onclick: onBack }, '←'), h('h1', {}, title), extra);

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
          S = r.obj; KEY = r.key; SALT = r.salt;
          if (!S.refEdits) { S = T.newState(S.pack); }
          showMain();
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
      if (r.obj.format !== 'tsc-pack') throw new Error('Це не пакет даних (очікується tsc-pack).');
      if (r.obj.version !== 3) throw new Error('Пакет застарілого формату. Оновіть tsc_sync.py на ПК до останньої версії і зробіть новий експорт.');
      const pending = S ? T.countUnexported(S) : 0;
      if (pending && !(await confirmBox('Є неекспортовані зміни', `Неекспортованих змін: ${pending}. Якщо відкрити новий пакет, вони будуть втрачені. Продовжити?`, 'Замінити', 'bad'))) return;
      if (S && T.countChanges(S) && !pending &&
          !(await confirmBox('Новий пакет', 'Зміни, які ви вже експортували, вважаються внесеними на ПК. Переконайтеся, що вони імпортовані. Замінити дані?', 'Замінити'))) return;
      closeAllScreens();
      S = T.newState(r.obj); KEY = r.key; SALT = r.salt;
      view = { tab: 'dev', sheet: Object.keys(S.pack.sheets)[0], q: '', filter: 'all', uq: '' };
      await persist(true);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      showMain(); toast('Пакет відкрито');
    } catch (e) { if (errBox) { clear(errBox); errBox.append(h('div', { class: 'msg e' }, e.message)); } else toast(e.message); }
  }

  async function lock(note) {
    clearTimeout(saveTimer); await persist(true);
    S = null; KEY = null; SALT = null; closeAllScreens();
    showStart(note);
  }

  // ---------- головний екран з вкладками ----------
  let content, badgeBtn, tabBtns = {}, renderCurrentList = () => {};
  function showMain() {
    if (!view.sheet || !S.pack.sheets[view.sheet]) view.sheet = Object.keys(S.pack.sheets)[0];
    clear(app);
    badgeBtn = h('button', { class: 'btn', onclick: showChanges }, '');
    const menu = h('button', { class: 'btn', onclick: showMenu }, '⋮');
    const tabs = h('div', { class: 'tabs' }, [['dev', 'Пристрої'], ['users', 'Співробітники'], ['refs', 'Довідники']].map(([k, t]) =>
      (tabBtns[k] = h('button', { class: 'tab' + (view.tab === k ? ' on' : ''), onclick: () => { view.tab = k; mountTab(); } }, t))));
    content = h('div', { class: 'content' });
    app.append(h('div', { class: 'top' }, h('h1', {}, 'Облік ТСЦ'), badgeBtn, menu), tabs, content);
    mountTab();
  }
  function mountTab() {
    Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle('on', k === view.tab));
    clear(content);
    if (view.tab === 'dev') mountDevices(); else if (view.tab === 'users') mountUsers(); else mountRefs();
    updateBadge();
  }
  function updateBadge() { if (badgeBtn && S) badgeBtn.textContent = 'Зміни: ' + T.countChanges(S); }

  // ----- картки -----
  function devCard(sheet, row, v, showSheet) {
    const free = S.pack.fields.every(f => !v[f]), edited = !!S.edits[sheet + '|' + row.ip];
    const st = v[F.STATUS] ? h('span', { class: 'tag ' + (v[F.STATUS] === 'Вимк.' ? 'off' : 'on') }, v[F.STATUS]) : null;
    return h('div', { class: 'card' + (free ? ' free' : ''), onclick: () => openEdit(sheet, row) },
      h('div', { class: 'l1' }, h('span', { class: 'ip' }, row.ip), h('span', { class: 'nm' }, free ? 'вільно' : (v[F.NAME] || '—'))),
      h('div', { class: 'l2' }, st, edited ? h('span', { class: 'tag chg' }, 'змінено') : null,
        showSheet ? h('span', { class: 'tag' }, sheet) : null, [v[F.TYPE], v[F.USER]].filter(Boolean).join(' · ')));
  }
  function userCard(r) {
    const v = r.values, n = T.deviceCounts(S).get(v[T.USER_KEY]) || 0;
    return h('div', { class: 'card', onclick: () => showUser(r.lid) },
      h('div', { class: 'l1' }, h('span', { class: 'ip' }, v[T.USER_KEY]), h('span', { class: 'nm' }, n ? `пристроїв: ${n}` : '')),
      h('div', { class: 'l2' }, r.isNew ? h('span', { class: 'tag chg' }, 'новий') : (r.edited ? h('span', { class: 'tag chg' }, 'змінено') : null),
        [v['ТСЦ'], v[T.USER_DEPT], v['Посада']].filter(Boolean).join(' · ')));
  }
  const userHay = v => Object.values(v).join(' ').toLowerCase();

  // ----- вкладка «Пристрої» -----
  let devList, devCount;
  function mountDevices() {
    const sheetSel = h('select', { onchange: e => { view.sheet = e.target.value; renderDevices(); } },
      Object.keys(S.pack.sheets).map(n => h('option', { value: n, selected: n === view.sheet }, n)));
    const q = h('input', { type: 'search', placeholder: "Пошук: ІР, ім'я, МАС, користувач… (по всіх ТСЦ)", value: view.q,
      oninput: e => { view.q = e.target.value; renderDevices(); } });
    const flt = h('select', { onchange: e => { view.filter = e.target.value; renderDevices(); } },
      [['all', 'Усі'], ['used', 'Зайняті'], ['free', 'Вільні'], ['off', 'Вимкнені'], ['edited', 'Змінені мною']]
        .map(([v, t]) => h('option', { value: v, selected: v === view.filter }, t)));
    devCount = h('div', { class: 'count' }); devList = h('div', { id: 'list' });
    content.append(h('div', { class: 'ctrls' }, sheetSel, q, h('div', { class: 'row' }, flt)), devCount, devList);
    renderCurrentList = renderDevices; renderDevices();
  }
  function renderDevices() {
    updateBadge();
    const q = view.q.trim().toLowerCase(), sheets = q ? Object.keys(S.pack.sheets) : [view.sheet];
    const out = []; let total = 0;
    for (const sh of sheets) for (const row of S.pack.sheets[sh]) {
      const v = T.effective(S, sh, row), u = T.userInfo(S, v[F.USER]);
      const free = S.pack.fields.every(f => !v[f]), edited = !!S.edits[sh + '|' + row.ip];
      if (view.filter === 'used' && free) continue;
      if (view.filter === 'free' && !free) continue;
      if (view.filter === 'off' && v[F.STATUS] !== 'Вимк.') continue;
      if (view.filter === 'edited' && !edited) continue;
      if (q) {
        const hay = (row.ip + ' ' + S.pack.fields.map(f => f === F.PASS ? '' : v[f]).join(' ') + ' ' + u.dept + ' ' + u.phone + ' ' + u.tsc).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      total++; if (out.length < MAX_RESULTS) out.push({ sh, row, v });
    }
    devCount.textContent = `Знайдено пристроїв: ${total}` + (total > MAX_RESULTS ? ` (показано ${MAX_RESULTS}, уточніть пошук)` : '');
    clear(devList);
    if (q) {                                           // збіги серед співробітників — вгорі
      const us = T.refRecords(S, 'users').filter(r => userHay(r.values).includes(q)).sort((a, b) => ukSort(a.values.ПІБ, b.values.ПІБ));
      if (us.length) {
        devList.append(h('div', { class: 'sec' }, `Співробітники (${us.length})`));
        us.slice(0, 5).forEach(r => devList.append(userCard(r)));
        if (us.length > 5) devList.append(h('div', { class: 'muted', style: 'margin:0 0 8px' }, `…ще ${us.length - 5}. Повний список — вкладка «Співробітники».`));
        devList.append(h('div', { class: 'sec' }, 'Пристрої'));
      }
    }
    for (const it of out) devList.append(devCard(it.sh, it.row, it.v, !!q));
  }

  // ----- вкладка «Співробітники» -----
  let usersList, usersCount;
  function mountUsers() {
    const q = h('input', { type: 'search', placeholder: 'Пошук співробітника: ПІБ, телефон, відділ, пошта…', value: view.uq,
      oninput: e => { view.uq = e.target.value; renderUsers(); } });
    usersCount = h('div', { class: 'count' }); usersList = h('div', { id: 'list' });
    content.append(h('div', { class: 'ctrls' }, q), usersCount, usersList,
      h('div', { class: 'bar' }, h('button', { class: 'btn pri', onclick: () => openUserForm(null) }, '+ Додати співробітника')));
    renderCurrentList = renderUsers; renderUsers();
  }
  function renderUsers() {
    updateBadge();
    const q = view.uq.trim().toLowerCase();
    const all = T.refRecords(S, 'users').filter(r => !q || userHay(r.values).includes(q))
      .sort((a, b) => ukSort(a.values.ПІБ, b.values.ПІБ));
    usersCount.textContent = `Співробітників: ${all.length}`;
    clear(usersList);
    all.slice(0, MAX_RESULTS).forEach(r => usersList.append(userCard(r)));
    if (!all.length) usersList.append(h('p', { class: 'muted' }, q ? 'Нікого не знайдено.' : 'Довідник порожній. Додайте співробітника кнопкою внизу.'));
  }

  // ----- картка співробітника з його пристроями -----
  function showUser(lid) {
    openScreen(s => {
      const rec = T.refRecords(S, 'users').find(r => r.lid === lid);
      if (!rec) return null;
      const v = rec.values, def = S.pack.refs.users;
      const rows = def.fields.filter(f => f !== T.USER_KEY && v[f]).map(f => {
        let val = v[f];
        if (f === 'Телефон') val = h('a', { href: 'tel:' + v[f].replace(/[^\d+]/g, '') }, v[f]);
        else if (f.includes('поштова')) val = h('a', { href: 'mailto:' + v[f] }, v[f]);
        return h('div', { class: 'kv' }, h('span', { class: 'k' }, f), h('span', {}, val));
      });
      const devs = T.devicesWith(S, F.USER, v[T.USER_KEY]);
      const del = async () => {
        const use = T.usage(S, 'users', v[T.USER_KEY]);
        if (use.devices.length) {
          await info('Видалення неможливе', `За співробітником закріплено пристроїв: ${use.devices.length}. Спочатку змініть користувача в цих пристроях (вони показані нижче).`);
          return;
        }
        if (await confirmBox('Видалити співробітника?', `«${v[T.USER_KEY]}» буде видалено з довідника (після імпорту — і з Excel).`, 'Видалити', 'bad')) {
          T.refDelete(S, 'users', lid); persist(); closeScreen(s); refreshAll(); toast('Видалено');
        }
      };
      return h('div', { class: 'screen' },
        topbar(v[T.USER_KEY], () => closeScreen(s)),
        h('div', { class: 'body' },
          rec.isNew ? h('div', { class: 'msg w' }, 'Новий запис (ще не на ПК)') : null, rows,
          h('div', { class: 'sec' }, `Пристрої співробітника (${devs.length})`),
          devs.length ? devs.map(d => devCard(d.sheet, d.row, d.values, true)) : h('p', { class: 'muted' }, 'За цим співробітником пристроїв не закріплено.')),
        h('div', { class: 'bar' },
          h('button', { class: 'btn bad', onclick: del }, 'Видалити'),
          h('button', { class: 'btn pri', onclick: () => openUserForm(lid) }, 'Редагувати')));
    });
  }

  // ----- форма співробітника (додати / змінити) -----
  function openUserForm(lid) {
    openScreen(s => {
      s.static = true;
      const def = S.pack.refs.users, L = T.lists(S);
      const rec = lid ? T.refRecords(S, 'users').find(r => r.lid === lid) : null;
      const cur = rec ? rec.values : {}; const inputs = {};
      const parts = def.fields.map(f => {
        let el;
        if (f === 'ТСЦ' || f === T.USER_DEPT) {
          const list = f === 'ТСЦ' ? L.tsc : L.departments;
          el = h('select', {}, h('option', { value: '' }, '—'), list.map(x => h('option', { value: x, selected: x === cur[f] }, x)));
        } else {
          el = h('input', { value: cur[f] || '', autocapitalize: 'off',
            inputmode: f === 'Телефон' ? 'tel' : (T.DATE_FIELDS.includes(f) ? 'numeric' : 'text'),
            placeholder: T.DATE_FIELDS.includes(f) ? 'ДД.ММ.РРРР' : null });
        }
        inputs[f] = el; return h('div', {}, h('label', {}, f + (f === T.USER_KEY ? ' *' : '')), el);
      });
      const msgs = h('div');
      const collect = () => { const v = {}; def.fields.forEach(f => { v[f] = inputs[f].value.trim(); }); return v; };
      const save = async () => {
        clear(msgs);
        const v = collect(), chk = T.validateUser(S, v);
        if (chk.errors.length) { chk.errors.forEach(e => msgs.append(h('div', { class: 'msg e' }, e))); return; }
        if (chk.warnings.length && !(await confirmBox('Перевірте дані', chk.warnings.join('\n'), 'Все одно зберегти'))) return;
        const oldKey = rec ? rec.values[T.USER_KEY] : null, renamed = rec && v[T.USER_KEY] !== oldKey;
        const use = renamed ? T.usage(S, 'users', oldKey).devices.length : 0;
        if (use && !(await confirmBox('Змінити ПІБ усюди?', `«${oldKey}» закріплено за пристроями: ${use}. Їхнього користувача буде змінено на «${v[T.USER_KEY]}».`, 'Змінити всюди'))) return;
        const r = T.refSave(S, 'users', lid, v);
        if (r.error) { msgs.append(h('div', { class: 'msg e' }, r.error)); return; }
        if (use) T.cascadeRename(S, 'users', oldKey, v[T.USER_KEY]);
        persist(); closeScreen(s); refreshAll(); toast('Збережено на телефоні');
      };
      return h('div', { class: 'screen' }, topbar(rec ? 'Редагувати співробітника' : 'Новий співробітник', () => closeScreen(s)),
        h('div', { class: 'body' }, parts, msgs),
        h('div', { class: 'bar' }, h('button', { class: 'btn', onclick: () => closeScreen(s) }, 'Скасувати'),
          h('button', { class: 'btn pri', onclick: save }, 'Зберегти')));
    });
  }

  // ----- вкладка «Довідники» -----
  function mountRefs() {
    renderCurrentList = () => {};
    const items = [...T.COLLS, 'tsc'].map(c => {
      const n = c === 'tsc' ? S.pack.refs.tsc.records.length : T.refRecords(S, c).length;
      return h('div', { class: 'card', onclick: () => c === 'users' ? (view.tab = 'users', mountTab()) : showRefList(c) },
        h('div', { class: 'l1' }, h('span', { class: 'ip' }, T.TITLES[c]), h('span', { class: 'nm' }, String(n))));
    });
    content.append(h('div', { id: 'list', style: 'padding-top:12px' }, items,
      h('p', { class: 'muted' }, 'Довідник ТСЦ можна лише переглядати: його назви пов\'язані з аркушами, підмережами та шлюзами, тому змінюйте його на ПК.')));
  }
  function showRefList(coll) {
    const readonly = coll === 'tsc';
    openScreen(s => {
      const def = S.pack.refs[coll];
      const recs = readonly ? def.records.map(r => ({ lid: null, values: Object.fromEntries(def.fields.map((f, i) => [f, r.v[i]])) }))
                            : T.refRecords(S, coll);
      const kf = def.key, listBox = h('div'), cnt = h('div', { class: 'count' });
      s.q = s.q || '';
      const render = () => {
        const q = s.q.trim().toLowerCase();
        const rs = recs.filter(r => !q || userHay(r.values).includes(q)).sort((a, b) => ukSort(a.values[kf], b.values[kf]));
        cnt.textContent = `Записів: ${rs.length}`; clear(listBox);
        for (const r of rs) {
          const use = readonly ? null : T.usage(S, coll, r.values[kf]);
          const n = use ? use.devices.length + use.users.length : 0;
          listBox.append(h('div', { class: 'card', onclick: () => openRefItem(coll, r) },
            h('div', { class: 'l1' }, h('span', { class: 'ip' }, r.values[kf]), h('span', { class: 'nm' }, n ? `використовується: ${n}` : '')),
            r.isNew || r.edited ? h('div', { class: 'l2' }, h('span', { class: 'tag chg' }, r.isNew ? 'новий' : 'змінено')) : null));
        }
      };
      render();
      const q = h('input', { type: 'search', placeholder: 'Пошук…', value: s.q, oninput: e => { s.q = e.target.value; render(); } });
      return h('div', { class: 'screen' }, topbar(T.TITLES[coll], () => closeScreen(s)),
        h('div', { class: 'ctrls' }, q), cnt, h('div', { class: 'body', style: 'padding-top:0' }, listBox),
        readonly ? null : h('div', { class: 'bar' }, h('button', { class: 'btn pri', onclick: () => openRefItem(coll, null) }, '+ Додати')));
    });
  }
  function openRefItem(coll, rec) {
    const def = S.pack.refs[coll], kf = def.key;
    if (coll === 'tsc') {                                  // перегляд без редагування
      modal(rec.values[kf], h('div', {}, def.fields.filter(f => f !== kf && rec.values[f]).map(f =>
        h('div', { class: 'kv' }, h('span', { class: 'k' }, f), h('span', {}, rec.values[f])))), [{ label: 'Закрити', value: true, cls: 'pri' }]);
      return;
    }
    const input = h('input', { value: rec ? rec.values[kf] : '', placeholder: kf }), err = h('div');
    const use = rec ? T.usage(S, coll, rec.values[kf]) : { devices: [], users: [] }, used = use.devices.length + use.users.length;
    const close = () => m.remove();
    const save = async () => {
      clear(err);
      const val = input.value.trim(), old = rec ? rec.values[kf] : null;
      if (!val) { err.append(h('div', { class: 'msg e' }, 'Значення не може бути порожнім.')); return; }
      const renamed = rec && val !== old;
      if (renamed && used && !(await confirmBox('Змінити всюди?', `«${old}» використовується в записах: ${used}. Їх буде оновлено на «${val}».`, 'Змінити всюди'))) return;
      const r = T.refSave(S, coll, rec ? rec.lid : null, { [kf]: val });
      if (r.error) { err.append(h('div', { class: 'msg e' }, r.error)); return; }
      if (renamed && used) T.cascadeRename(S, coll, old, val);
      persist(); close(); refreshAll(); toast('Збережено на телефоні');
    };
    const del = async () => {
      if (used) { close(); await info('Видалення неможливе', `Значення «${rec.values[kf]}» використовується в записах: ${used}. Спочатку замініть його в цих записах.`); return; }
      if (await confirmBox('Видалити значення?', `«${rec.values[kf]}» буде видалено з довідника.`, 'Видалити', 'bad')) {
        T.refDelete(S, coll, rec.lid); persist(); close(); refreshAll(); toast('Видалено');
      }
    };
    const m = h('div', { class: 'modal' }, h('div', { class: 'box' },
      h('h3', { style: 'margin:0 0 8px' }, rec ? 'Редагувати значення' : 'Нове значення'),
      h('div', { class: 'muted' }, T.TITLES[coll] + (used ? ` · використовується: ${used}` : '')), h('label', {}, kf), input, err,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Скасувати'),
        rec ? h('button', { class: 'btn bad', onclick: del }, 'Видалити') : null,
        h('button', { class: 'btn pri', onclick: save }, 'Зберегти'))));
    document.body.append(m);
  }

  // ---------- форма пристрою ----------
  function openEdit(sheet, row) {
    openScreen(s => {
      s.static = true;
      const pack = S.pack, cur = T.effective(S, sheet, row), inputs = {}, L = T.lists(S);
      const mk = (f, el) => { inputs[f] = el; return h('div', {}, h('label', {}, f), el); };
      const sel = (f, list) => h('select', {}, h('option', { value: '' }, '—'),
        list.map(x => h('option', { value: x, selected: x === cur[f] }, x)));
      const dl = h('datalist', { id: 'dl-users' }, L.users.map(u => h('option', { value: u })));
      const ro = h('div', { class: 'ro' }), profile = h('button', { class: 'btn', style: 'margin-top:8px;min-height:40px' }, 'Відкрити картку співробітника');
      const upd = () => {
        const name = inputs[F.USER].value.trim(), u = T.userInfo(S, name);
        clear(ro).append(h('div', {}, 'Відділ: ', u.dept || '—'), h('div', {}, 'Телефон: ', u.phone || '—'), h('div', {}, 'ТСЦ(РСЦ): ', u.tsc || '—'));
        const rec = T.refRecords(S, 'users').find(r => r.values[T.USER_KEY] === name);
        profile.style.display = rec ? '' : 'none'; profile.onclick = () => rec && showUser(rec.lid);
      };
      const fields = pack.fields;
      const parts = [
        mk(F.NUM, h('input', { inputmode: 'numeric', value: cur[F.NUM] })),
        mk(F.NAME, h('input', { value: cur[F.NAME], autocapitalize: 'off' })),
        mk(F.MAC, h('input', { value: cur[F.MAC], autocapitalize: 'characters', placeholder: 'AA:BB:CC:DD:EE:FF' })),
        mk(F.STATUS, sel(F.STATUS, pack.statuses)),
        mk(F.TYPE, sel(F.TYPE, L.equipment)),
        mk(F.USER, h('input', { value: cur[F.USER], list: 'dl-users', placeholder: 'Почніть вводити ПІБ', oninput: upd })),
        h('label', {}, 'З довідника співробітників (лише перегляд)'), ro, profile,
        mk(F.OS, sel(F.OS, L.os)),
        mk(F.MFR, sel(F.MFR, L.manufacturers)),
        mk(F.NOTES, h('textarea', {}, cur[F.NOTES])),
        mk(F.INV, h('input', { value: cur[F.INV], autocapitalize: 'off', inputmode: 'text' })),
      ];
      if (fields.includes(F.PASS)) parts.push(mk(F.PASS, h('input', { value: cur[F.PASS], autocapitalize: 'off' })));
      const msgs = h('div');
      const collect = () => { const v = {}; fields.forEach(f => { v[f] = inputs[f] ? inputs[f].value.trim() : cur[f]; }); return v; };
      const save = async () => {
        clear(msgs);
        const res = T.validate(S, sheet, row, collect());
        if (res.errors.length) { res.errors.forEach(e => msgs.append(h('div', { class: 'msg e' }, e))); return; }
        if (res.warnings.length && !(await confirmBox('Перевірте дані', res.warnings.join('\n'), 'Все одно зберегти'))) return;
        T.applyEdit(S, sheet, row, res.values); persist(); closeScreen(s); refreshAll(); toast('Збережено на телефоні');
      };
      const clearRec = async () => {
        if (await confirmBox('Очистити запис?', `Усі поля запису ${row.ip} буде очищено (адреса стане вільною).`, 'Очистити', 'bad')) {
          const v = {}; fields.forEach(f => { v[f] = ''; }); T.applyEdit(S, sheet, row, v); persist(); closeScreen(s); refreshAll();
        }
      };
      const el = h('div', { class: 'screen' }, topbar(`${sheet} · ${row.ip}`, () => closeScreen(s)),
        h('div', { class: 'body' }, dl, parts, msgs, h('div', { style: 'height:16px' }),
          h('button', { class: 'btn bad', style: 'width:100%', onclick: clearRec }, 'Очистити запис')),
        h('div', { class: 'bar' }, h('button', { class: 'btn', onclick: () => closeScreen(s) }, 'Скасувати'), h('button', { class: 'btn pri', onclick: save }, 'Зберегти')));
      setTimeout(upd, 0);
      return el;
    });
  }

  // ---------- зміни й експорт ----------
  function showChanges() {
    openScreen(s => {
      const dev = Object.values(S.edits).sort((a, b) => (a.sheet + a.ip).localeCompare(b.sheet + b.ip, 'uk', { numeric: true }));
      const refs = T.refEditList(S);
      const tag = e => h('span', { class: 'tag ' + (T.isPending(e) ? 'chg' : 'on') }, T.isPending(e) ? 'не експортовано' : 'експортовано');
      const rows = [
        ...dev.map(e => h('div', { class: 'chrow' }, h('b', {}, `${e.sheet} · ${e.ip}`), ' ', tag(e),
          h('div', { class: 'muted' }, Object.entries(e.values).filter(([f]) => f !== F.PASS).map(([f, v]) => `${f}: ${v || '∅'}`).join('; ')))),
        ...refs.map(e => {
          const kf = S.pack.refs[e.coll].key, name = e.values ? e.values[kf] : e.orig;
          return h('div', { class: 'chrow' }, h('b', {}, `${T.TITLES[e.coll]}: ${name}`), ' ', tag(e),
            h('div', { class: 'muted' }, OPS[e.op] + (e.op === 'update' && e.orig !== name ? ` (було: ${e.orig})` : '')));
        })];
      const total = rows.length;
      return h('div', { class: 'screen' }, topbar('Зміни для ПК', () => closeScreen(s)),
        h('div', { class: 'body' }, h('p', { class: 'muted' }, 'Файл змін зашифрований тим самим паролем. Збережіть його в хмару й імпортуйте на ПК.'),
          total ? rows : h('p', { class: 'muted' }, 'Змін немає.'),
          total ? h('button', { class: 'btn bad', style: 'width:100%;margin-top:16px', onclick: async () => {
            if (await confirmBox('Скасувати всі зміни?', 'Усі зміни на телефоні (пристрої, співробітники, довідники) буде видалено. Дані з ПК залишаться.', 'Скасувати зміни', 'bad')) {
              T.clearEdits(S); persist(true); refreshAll(); } } }, 'Скасувати всі зміни') : null),
        h('div', { class: 'bar' },
          h('button', { class: 'btn', disabled: !total, onclick: () => doExport('save') }, 'Зберегти файл'),
          h('button', { class: 'btn pri', disabled: !total, onclick: () => doExport('share') }, 'Поділитися…')));
    });
  }
  async function doExport(mode) {
    const obj = await T.buildChanges(S);
    if (!obj.changes.length && !obj.ref_changes.length) { toast('Немає змін'); return; }
    const bytes = await T.encryptObj(obj, KEY, SALT, T.MAGIC_PACK); await persist(true);
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `зміни_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.enc`;
    const file = new File([bytes], name, { type: 'application/octet-stream' });
    const download = () => { const a = h('a', { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); toast('Файл змін збережено: ' + name); };
    if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); toast('Файл змін створено'); }
      catch (e) { if (e.name !== 'AbortError') download(); }
    } else download();
    refreshAll();
  }

  // ---------- меню ----------
  function showMenu() {
    const p = S.pack, fileIn = h('input', { type: 'file', accept: '.enc,application/octet-stream', style: 'display:none',
      onchange: () => { if (fileIn.files[0]) { m.remove(); openPack(fileIn.files[0]); } } });
    const infoBox = h('div', { class: 'muted' },
      h('div', {}, 'Пакет з ПК: ', (p.exported_at || '').replace('T', ' ')), h('div', {}, 'Записів-слотів: ', Object.values(p.sheets).reduce((n, a) => n + a.length, 0)),
      h('div', {}, 'Пароль обладнання на телефоні: ', p.fields.includes(F.PASS) ? 'передається' : 'не передається'));
    const m = h('div', { class: 'modal', onclick: e => { if (e.target === m) m.remove(); } }, h('div', { class: 'box' },
      h('h3', { style: 'margin:0 0 8px' }, 'Меню'), infoBox, fileIn,
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
