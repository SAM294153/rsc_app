/* scanner.js — сканування штрих-коду / QR камерою телефона. Усе відбувається на пристрої: кадри нікуди не надсилаються.
   Спершу використовується вбудований BarcodeDetector (Chrome на Android); якщо його немає — бібліотека ZXing (zxing.min.js). */
(() => {
  'use strict';
  const FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'qr_code', 'data_matrix'];

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

  let zxingPromise = null;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingPromise) zxingPromise = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'zxing.min.js';
      s.onload = () => res(window.ZXing);
      s.onerror = () => { zxingPromise = null; rej(new Error('Не вдалося завантажити модуль розпізнавання.')); };
      document.head.append(s);
    });
    return zxingPromise;
  }

  // Повертає { name, detect() -> {text, format} | null }
  async function makeDecoder(video) {
    if ('BarcodeDetector' in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter(f => sup.includes(f));
        if (formats.length) {
          const d = new window.BarcodeDetector({ formats });
          return { name: 'BarcodeDetector', delay: 150, detect: async () => {
            const r = await d.detect(video); return r.length ? { text: r[0].rawValue, format: r[0].format } : null; } };
        }
      } catch (e) { /* переходимо на ZXing */ }
    }
    const Z = await loadZXing();
    const hints = new Map();
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
      Z.BarcodeFormat.CODABAR, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX]);
    const reader = new Z.MultiFormatReader(); reader.setHints(hints);
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
    return { name: 'ZXing', delay: 120, detect: async () => {
      const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
      const sc = Math.min(1, 960 / vw); cv.width = Math.round(vw * sc); cv.height = Math.round(vh * sc);
      ctx.drawImage(video, 0, 0, cv.width, cv.height);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data, lum = new Uint8ClampedArray(cv.width * cv.height);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = (d[i] * 306 + d[i + 1] * 601 + d[i + 2] * 117) >> 10;
      try {
        const r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, cv.width, cv.height))));
        return { text: r.getText(), format: Z.BarcodeFormat[r.getBarcodeFormat()] };
      } catch (e) { return null; }                      // у кадрі немає коду
    } };
  }

  function cameraError(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Доступ до камери заборонено. Дозвольте камеру: Налаштування Android → Застосунки → Chrome (або «Облік ТСЦ») → Дозволи → Камера. Або введіть номер вручну.';
      case 'NotFoundError': case 'OverconstrainedError': return 'Камеру не знайдено. Введіть номер вручну.';
      case 'NotReadableError': return 'Камеру використовує інший застосунок. Закрийте його й повторіть, або введіть номер вручну.';
      default: return 'Не вдалося запустити камеру' + (e && e.message ? ` (${e.message})` : '') + '. Введіть номер вручну.';
    }
  }

  // Відкриває сканер. Повертає Promise<string|null> (null — скасовано).
  function open(opts = {}) {
    return new Promise(resolve => {
      let stream = null, track = null, timer = null, decoder = null, stopped = true, torchOn = false, finished = false;
      const status = h('div', { class: 'sc-status' }, 'Запуск камери…');
      const video = h('video', { playsinline: true, autoplay: true }); video.muted = true;
      const torchBtn = h('button', { class: 'btn', style: 'display:none' }, '🔦 Ліхтарик');
      const panel = h('div', { class: 'sc-panel' });
      const view = h('div', { class: 'sc-view' }, video, h('div', { class: 'sc-frame' }));
      const overlay = h('div', { class: 'scanner' },
        h('div', { class: 'sc-top' }, h('b', {}, opts.title || 'Сканування штрих-коду'), h('button', { class: 'btn', onclick: () => finish(null) }, 'Закрити')),
        view, status, panel,
        h('div', { class: 'sc-bar' }, torchBtn, h('button', { class: 'btn', onclick: () => { stop(); showResult('', 'ручне введення'); } }, '✎ Ввести вручну')));

      const stop = () => {
        stopped = true; clearTimeout(timer);
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
        try { video.srcObject = null; } catch (e) { /* ігноруємо */ }
        torchOn = false;
      };
      const finish = val => {
        if (finished) return; finished = true; stop();
        document.removeEventListener('visibilitychange', onVis); overlay.remove(); resolve(val);
      };
      const onVis = () => { if (document.hidden) finish(null); };    // камера не працює у фоні
      document.addEventListener('visibilitychange', onVis);

      const showResult = (text, format) => {
        const input = h('input', { value: text, placeholder: 'Інвентарний номер', autocapitalize: 'off', style: 'margin:8px 0' });
        view.style.display = 'none'; torchBtn.style.display = 'none';
        status.textContent = text ? `Прочитано (${format}). Перевірте номер:` : 'Введіть номер вручну:';
        panel.replaceChildren(input, h('div', { class: 'sc-row' },
          h('button', { class: 'btn', onclick: () => { view.style.display = ''; panel.replaceChildren(); start(); } }, 'Сканувати ще раз'),
          h('button', { class: 'btn pri', onclick: () => { const v = input.value.replace(/[\r\n\t]+/g, ' ').trim(); if (v) finish(v); else input.focus(); } }, 'Використати')));
        if (!text) setTimeout(() => input.focus(), 50);
      };

      const loop = async () => {
        if (stopped) return;
        try {
          const r = await decoder.detect();
          if (r && r.text && !stopped) { if (navigator.vibrate) navigator.vibrate(80); stop(); showResult(r.text, r.format); return; }
        } catch (e) { /* кадр не розпізнано */ }
        if (!stopped) timer = setTimeout(loop, decoder.delay);
      };

      async function start() {
        stopped = false; status.textContent = 'Запуск камери…';
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          status.textContent = 'Камера недоступна: потрібне захищене з\'єднання (https) і браузер із підтримкою камери. Введіть номер вручну.'; stopped = true; return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        } catch (e) { status.textContent = cameraError(e); stopped = true; return; }
        if (finished || stopped) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }
        video.srcObject = stream; try { await video.play(); } catch (e) { /* автозапуск вже ввімкнено */ }
        track = stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) {
          torchBtn.style.display = '';
          torchBtn.onclick = async () => { torchOn = !torchOn; try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = !torchOn; } };
        }
        if (caps.focusMode && caps.focusMode.includes && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        status.textContent = 'Наведіть камеру на штрих-код на наклейці';
        try { decoder = decoder || await makeDecoder(video); }
        catch (e) { status.textContent = e.message + ' Введіть номер вручну.'; stop(); return; }
        loop();
      }

      document.body.append(overlay);
      start();
    });
  }

  window.TSCScan = { open, makeDecoder, FORMATS };
})();
