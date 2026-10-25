// VO Timer — app logic.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const fmt = (x) => (x == null || isNaN(x) ? '—' : x.toFixed(2));
  const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(2);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const DEFAULTS = { thresholdDb: -45, holdLine: 0.7, holdSection: 2.0, tolerance: 0.25, target: 'strict', mode: 'line',
    autoAdvance: 'always', autoArm: false, listenToTarget: true, minTakePct: 40, autoPlay: false, textSize: 26, theme: 'dark', calibrated: false, bannerDismissed: false };
  const APP_VERSION = '1.4.6';
  const settings = Object.assign({}, DEFAULTS, store.get('vot.settings', {}));
  if (settings.autoAdvance === true) settings.autoAdvance = 'always';     // older boolean setting
  if (settings.autoAdvance === false) settings.autoAdvance = 'off';
  const saveSettings = () => store.set('vot.settings', settings);

  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('vo-timer', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('projects', mode); const s = t.objectStore('projects');
        const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
      });
    },
    put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
    get(id) { return this.tx('readonly', (s) => s.get(id)); },
    all() { return this.tx('readonly', (s) => s.getAll()); },
    del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  };

  // ---------- state ----------
  let P = null;               // current project (meta, without audio data)
  let lines = [];             // flat list of lines
  let refBuffer = null;       // decoded reference audio
  let takes = {};             // key -> [{d, ts, est}]
  let selIdx = 0;
  let ctx = null, micStream = null, levelNode = null, micInput = null, filterNode = null;
  let lastDb = -100;
  let take = null;            // {det, mode, sec, line, status}
  let playing = null;         // {src, ids}
  let calib = null;           // {kind, until, samples}
  let roomSamples = store.get('vot.room', null);
  let wakeLock = null;
  let pending = [];           // timers for auto-advance / re-arm after a take
  let lastSaved = null;       // {ts, keys, selIdx, label} for Discard

  // ---------- helpers ----------
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const targetOf = (item) => item.dur + (settings.target === 'window' && hasRoom() ? Math.max(0, item.roomAfter || 0) : 0);
  const curLine = () => lines[selIdx];
  const hasRoom = () => !!P && !(P.source && P.source.mode === 'script');
  const curSec = () => (curLine() ? curLine().sec : null);
  function secName(sec) {
    if (sec.label) return sec.label;
    return (sec.group === 'open' ? 'Opening ' : sec.group === 'close' ? 'Close ' : 'Section ') + sec.groupN;
  }
  function lineNo(line) { return line.idx + 1; }
  const isLive = () => !!take && take.status === 'live';
  function clearPending() { pending.forEach(clearTimeout); pending = []; }
  function later(fn, ms) { pending.push(setTimeout(fn, ms)); }

  // ---------- audio ----------
  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    return ctx;
  }
  async function ensureMic() {
    if (micStream && micStream.active) return true;
    const c = audioCtx();
    await c.resume();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      $('#micState').textContent = 'Mic blocked';
      toast(e && e.name === 'NotAllowedError' ? 'Mic permission was refused. Allow it in Chrome’s site settings, then try again.' : 'Couldn’t open the mic: ' + (e && e.message ? e.message : e));
      return false;
    }
    if (!levelNode) {
      await c.audioWorklet.addModule('level-worklet.js');
      filterNode = c.createBiquadFilter(); filterNode.type = 'highpass'; filterNode.frequency.value = 90;
      levelNode = new AudioWorkletNode(c, 'level-processor');
      const sink = c.createGain(); sink.gain.value = 0;
      filterNode.connect(levelNode).connect(sink).connect(c.destination);
      levelNode.port.onmessage = (ev) => onLevel(ev.data);
    }
    micInput = c.createMediaStreamSource(micStream);
    micInput.connect(filterNode);
    await c.resume();
    $('#micState').textContent = 'Mic on';
    $('#btnMic').textContent = 'Mic is on';
    return true;
  }
  // Stop the mic completely so other apps can use it.
  function closeMic() {
    if (micInput) { try { micInput.disconnect(); } catch (e) { /* already gone */ } micInput = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    lastDb = -100;
    $('#micState').textContent = 'Mic off';
    $('#btnMic').textContent = 'Turn on mic';
    if (ctx && ctx.state === 'running' && !playing) ctx.suspend().catch(() => {});
  }
  // The mic is only held while armed or timing, during setup, or with Settings open.
  function idleMic() { if (!take && !calib && !$('#dlgSettings').open) closeMic(); }
  // The app went to the background or lost focus: cancel everything and let go of the mic.
  function releaseMic() {
    clearPending();
    if (take) { take = null; renderTakeState(); }
    if (calib) { calib = null; $('#btnRoom').disabled = $('#btnVoice').disabled = false; $('#calibNote').textContent = 'Setup was interrupted when the app went to the background. Try again.'; }
    stopPlayback();
    closeMic();
  }

  function onLevel({ t, db, f }) {
    lastDb = db;
    if (calib) {
      calib.samples.push(db);
      if (t >= calib.until) finishCalib();
    }
    if (take && !playing && take.status !== 'done') {
      const ev = take.det.push(t, db, f);
      if (ev === 'start') { take.status = 'live'; renderTakeState(); }
      else if (ev === 'stop') finishTake();
    }
  }

  function stopPlayback() {
    if (!playing) return;
    try { playing.src.onended = null; playing.src.stop(); } catch (e) { /* already stopped */ }
    document.querySelectorAll('.line.playing').forEach((el) => el.classList.remove('playing'));
    playing = null; renderButtons();
  }
  async function playRange(start, end, ids, onDone) {
    if (!refBuffer) { toast('This project has no reference audio loaded.'); return; }
    if (isLive()) return;
    cancelTake();
    stopPlayback();
    const c = audioCtx(); await c.resume();
    const src = c.createBufferSource(); src.buffer = refBuffer; src.connect(c.destination);
    const s = Math.max(0, start - 0.08); const d = Math.max(0.1, end - s + 0.3);
    src.start(0, s, d);
    playing = { src, ids };
    ids.forEach((id) => { const el = document.querySelector(`.line[data-id="${id}"]`); if (el) el.classList.add('playing'); });
    src.onended = () => { if (playing && playing.src === src) { stopPlayback(); if (onDone) onDone(); } };
    renderButtons();
  }

  // ---------- takes ----------
  async function arm() {
    if (!P) { openProjects(); return; }
    clearPending();
    stopPlayback();
    if (!micStream) { $('#status').textContent = 'Opening mic…'; $('#status').className = 'status armed'; }
    if (!(await ensureMic())) return;
    requestWakeLock();
    const mode = settings.mode;
    const item = mode === 'section' ? curSec() : curLine();
    const det = new VOT.Detector({ thresholdDb: settings.thresholdDb, holdMs: (mode === 'section' ? settings.holdSection : settings.holdLine) * 1000,
      minMs: settings.listenToTarget ? targetOf(item) * 1000 : 0 });
    take = { det, mode, line: curLine(), sec: curSec(), status: 'armed' };
    $('#verdict').textContent = ''; $('#verdict').className = 'verdict'; $('#parts').innerHTML = '';
    renderTakeState();
  }
  function cancelTake() {
    if (!take) return;
    take = null; renderTakeState();
    idleMic();
  }
  function finishNow() {
    if (isLive() && take.det.finish()) finishTake(true);
  }
  function armButton() {
    if (!take) arm();
    else if (isLive()) finishNow();
    else cancelTake();
  }
  function discard() {
    clearPending();
    if (isLive()) {
      take = null; renderTakeState();
      $('#status').textContent = 'Take discarded';
      if (settings.autoArm) arm(); else idleMic();
      return;
    }
    if (!lastSaved || !P) return;
    const ls = lastSaved; lastSaved = null;
    for (const key of ls.keys) {
      if (!takes[key]) continue;
      takes[key] = takes[key].filter((x) => x.ts !== ls.ts);
      if (!takes[key].length) delete takes[key];
    }
    store.set('vot.takes.' + P.id, takes);
    take = null;
    select(ls.selIdx, true, { noPlay: true });
    $('#parts').innerHTML = '';
    $('#prevResult').textContent = `Previous take discarded (${ls.label}).`;
    renderLines(); renderTakeState();
    $('#status').textContent = 'Take discarded';
    if (settings.autoArm) arm(); else idleMic();
  }
  function saveTake(key, d, est, ts) {
    (takes[key] = takes[key] || []).push({ d: +d.toFixed(3), ts, tt: settings.target, est: !!est });
    if (takes[key].length > 60) takes[key].shift();
    store.set('vot.takes.' + P.id, takes);
    if (lastSaved && lastSaved.ts === ts) lastSaved.keys.push(key);
  }
  function finishTake(manual) {
    const t = take; t.status = 'done';
    const dur = t.det.duration;
    const tol = settings.tolerance;
    const target = targetOf(t.mode === 'line' ? t.line : t.sec);
    // An automatic stop far shorter than the target is a cough or an "okay", not a take: ignore it and stay armed.
    if (!manual && settings.minTakePct > 0 && dur < target * settings.minTakePct / 100) {
      take = null;
      arm().then(() => {
        $('#verdict').textContent = `Ignored a ${fmt(dur)} s sound (too short to count). Still armed.`;
        $('#verdict').className = 'verdict';
      });
      return;
    }
    const parts = $('#parts'); parts.innerHTML = '';
    const label = t.mode === 'line' ? `Line ${lineNo(t.line)}` : `Section ${secName(t.sec)}`;
    const pg = VOT.grade(dur, target, tol);
    const ts = Date.now();
    lastSaved = { ts, keys: [], selIdx: t.line.idx, label };
    $('#prevResult').innerHTML = `Previous take · ${label}: <b class="num ${pg.band}">${fmt(dur)}</b> (${pg.delta <= 0 ? Math.abs(pg.delta).toFixed(2) + ' s under' : pg.delta.toFixed(2) + ' s over'})`;
    if (t.mode === 'line') {
      saveTake(t.line.id, dur, false, ts);
      showResult(dur, targetOf(t.line));
    } else {
      const sec = t.sec;
      saveTake('sec:' + sec.id, dur, false, ts);
      showResult(dur, targetOf(sec));
      const split = t.det.split(sec.lines.length);
      if (split) {
        split.forEach((p, i) => {
          const ln = sec.lines[i]; saveTake(ln.id, p.dur, true, ts);
          const g = VOT.grade(p.dur, targetOf(ln), tol);
          const row = document.createElement('div');
          row.innerHTML = `<span>Line ${lineNo(ln)}${ln.title ? ' (title)' : ''}</span><span class="num chip ${g.band} est">${fmt(p.dur)} ${sign(g.delta)}</span>`;
          parts.appendChild(row);
        });
      } else if (sec.lines.length > 1) {
        parts.innerHTML = '<div><span>Per-line split unclear: not enough pauses between lines.</span></div>';
      }
    }
    take = null;
    renderLines();
    renderTakeState(true);
    const passed = pg.band === 'good';
    const advance = settings.autoAdvance === 'always' || (settings.autoAdvance === 'pass' && passed);
    if (settings.autoAdvance === 'pass' && !passed) $('#status').textContent = 'Over target · staying on this line';
    if (advance) {
      later(() => {
        move(1, { noPlay: true });
        afterMove(settings.autoArm, 400);
      }, 900);
    } else if (settings.autoArm) {
      later(() => { if (!take && !playing) arm(); }, 1300);
    }
    if (!settings.autoArm) closeMic();
  }
  function showResult(dur, target) {
    const g = VOT.grade(dur, target, settings.tolerance);
    const clock = $('#clock'); clock.textContent = fmt(dur); clock.className = 'clock ' + g.band;
    const v = $('#verdict');
    v.textContent = g.delta <= 0 ? `${Math.abs(g.delta).toFixed(2)} s under target` : `${g.delta.toFixed(2)} s over target`;
    v.className = 'verdict ' + g.band;
    setProgress(dur, target, g.band);
  }

  // ---------- calibration ----------
  async function startCalib(kind) {
    if (!(await ensureMic())) return;
    cancelTake(); stopPlayback();
    const c = audioCtx();
    calib = { kind, until: c.currentTime + (kind === 'room' ? 3 : 5), samples: [] };
    $('#calibNote').textContent = kind === 'room' ? 'Recording room tone. Stay quiet…' : 'Recording voice sample. Read a line at performance level now…';
    $('#btnRoom').disabled = $('#btnVoice').disabled = true;
  }
  function finishCalib() {
    const c = calib; calib = null;
    $('#btnRoom').disabled = $('#btnVoice').disabled = false;
    const sorted = c.samples.slice().sort((a, b) => a - b);
    if (c.kind === 'room') {
      roomSamples = c.samples; store.set('vot.room', roomSamples.slice(-400));
      const floor = sorted[Math.floor(sorted.length * 0.95)];
      settings.thresholdDb = VOT.suggestThreshold(roomSamples, null);
      $('#calibNote').textContent = `Room tone is about ${floor.toFixed(0)} dB. Threshold set to ${settings.thresholdDb} dB for now. Next, record a voice sample.`;
    } else {
      if (!roomSamples) { $('#calibNote').textContent = 'Record room tone first, then the voice sample.'; return; }
      const rs = roomSamples.slice().sort((a, b) => a - b); const floor = rs[Math.floor(rs.length * 0.95)];
      const voiced = c.samples.filter((x) => x > floor + 6);
      if (voiced.length < 50) { $('#calibNote').textContent = 'That sample was too quiet to measure. Try again, reading at full performance level.'; return; }
      settings.thresholdDb = VOT.suggestThreshold(roomSamples, voiced);
      settings.calibrated = true;
      const v = voiced.slice().sort((a, b) => a - b); const mid = v[Math.floor(v.length * 0.6)];
      $('#calibNote').textContent = `Room about ${floor.toFixed(0)} dB, voice about ${mid.toFixed(0)} dB. Threshold set to ${settings.thresholdDb} dB. Adjust the slider if takes start late or false-start.`;
      $('#banner') && ($('#banner').hidden = true);
    }
    saveSettings(); syncSettingsUI(); renderMeterThr();
  }

  // ---------- projects ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    const jsonF = files.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
    const audioF = files.find((f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name));
    if (!jsonF && audioF && P) { // replace audio for current project
      const rec = await idb.get(P.id); rec.audio = audioF; await idb.put(rec); await openProject(P.id); toast('Reference audio replaced.'); return;
    }
    if (!jsonF) { toast('Pick the project .json file (and the mp3 if it isn’t built in).'); return; }
    let proj;
    try { proj = JSON.parse(await jsonF.text()); } catch (e) { toast('That file isn’t a readable project file.'); return; }
    if (!proj || proj.format !== 'vo-timer/1' || !Array.isArray(proj.sections)) { toast('That .json isn’t a VO Timer project file.'); return; }
    let audio = audioF || null;
    if (proj.audio && proj.audio.data) {
      const bin = atob(proj.audio.data); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      if (!audio) audio = new Blob([u8], { type: proj.audio.mime || 'audio/mpeg' });
      delete proj.audio.data;
    }
    await idb.put({ id: proj.id, title: proj.title, savedAt: Date.now(), meta: proj, audio });
    await openProject(proj.id);
    closeDialogs();
    toast(audio ? 'Project loaded.' : 'Project loaded without reference audio. Open the mp3 from Projects to hear lines.');
  }

  async function openProject(id) {
    const rec = await idb.get(id);
    if (!rec) return false;
    cancelTake(); stopPlayback();
    P = rec.meta; lines = []; lastSaved = null; clearPending();
    const firstLabeled = P.sections.findIndex((s) => s.label);
    let lastLabeled = -1; P.sections.forEach((s, i) => { if (s.label) lastLabeled = i; });
    let openN = 0, closeN = 0, midN = 0;
    P.sections.forEach((s, si) => {
      if (!s.label) {
        if (firstLabeled === -1 || si < firstLabeled) { s.group = 'open'; s.groupN = ++openN; }
        else if (si > lastLabeled) { s.group = 'close'; s.groupN = ++closeN; }
        else { s.group = 'mid'; s.groupN = ++midN; }
      }
      s.lines.forEach((ln) => { ln.sec = s; ln.idx = lines.length; lines.push(ln); });
    });
    takes = store.get('vot.takes.' + P.id, {});
    selIdx = Math.min(store.get('vot.sel.' + P.id, 0), lines.length - 1);
    store.set('vot.last', P.id);
    $('#projTitle').textContent = P.title;
    refBuffer = null;
    renderScript();
    if (rec.audio) {
      try { refBuffer = await audioCtx().decodeAudioData(await rec.audio.arrayBuffer()); }
      catch (e) { toast('Couldn’t decode the reference audio.'); }
    }
    renderButtons();
    return true;
  }

  async function renderProjectList() {
    const list = $('#projList'); list.innerHTML = '';
    let recs = [];
    try { recs = await idb.all(); } catch (e) { list.innerHTML = '<p class="note">This browser blocked local storage, so projects can’t be kept between visits.</p>'; return; }
    recs.sort((a, b) => b.savedAt - a.savedAt);
    if (!recs.length) { list.innerHTML = '<p class="note">No projects on this tablet yet.</p>'; return; }
    for (const r of recs) {
      const n = r.meta.sections.reduce((a, s) => a + s.lines.length, 0);
      const el = document.createElement('div'); el.className = 'proj-item';
      el.innerHTML = `<div class="t"><strong></strong><small>${r.meta.sections.length} sections · ${n} lines · ${r.audio ? 'reference audio included' : 'no reference audio'}</small></div>
        <button class="btn" data-act="open">Open</button><button class="btn danger" data-act="del">Remove</button>
        <span data-confirm hidden>Remove from this tablet? <button class="btn danger" data-act="yes">Remove</button> <button class="btn" data-act="no">Keep</button></span>`;
      el.querySelector('strong').textContent = r.title + (P && P.id === r.id ? ' (open)' : '');
      el.addEventListener('click', async (ev) => {
        const act = ev.target.dataset && ev.target.dataset.act; if (!act) return;
        const conf = el.querySelector('[data-confirm]');
        if (act === 'open') { await openProject(r.id); closeDialogs(); }
        if (act === 'del') conf.hidden = false;
        if (act === 'no') conf.hidden = true;
        if (act === 'yes') {
          await idb.del(r.id);
          if (P && P.id === r.id) { P = null; lines = []; refBuffer = null; $('#projTitle').textContent = 'No project loaded'; renderScript(); renderButtons(); }
          renderProjectList();
        }
      });
      list.appendChild(el);
    }
  }

  // ---------- rendering ----------
  function lastTake(key) { const a = takes[key]; return a && a.length ? a[a.length - 1] : null; }
  function chipHtml(key, target) {
    const t = lastTake(key); if (!t) return '';
    const g = VOT.grade(t.d, target, settings.tolerance);
    return `<span class="chip ${g.band}${t.est ? ' est' : ''}" title="Last take${t.est ? ' (split from a section take)' : ''}">${fmt(t.d)}</span>`;
  }

  function renderScript() {
    const root = $('#script');
    root.querySelectorAll('.sec, .banner').forEach((el) => el.remove());
    $('#empty').hidden = !!P;
    if (!P) { renderPanel(); return; }
    if (!settings.calibrated && !settings.bannerDismissed) {
      const b = document.createElement('div'); b.className = 'banner'; b.id = 'banner';
      b.innerHTML = '<p>Set the detection level for your booth before your first take. It takes about 10 seconds.</p><button class="btn primary" id="bnSetup">Set it up</button><button class="btn" id="bnLater">Later</button>';
      root.appendChild(b);
      b.querySelector('#bnSetup').onclick = () => openSettings();
      b.querySelector('#bnLater').onclick = () => { settings.bannerDismissed = true; saveSettings(); b.hidden = true; };
    }
    for (const s of P.sections) {
      const el = document.createElement('div'); el.className = 'sec'; el.dataset.id = s.id;
      const head = document.createElement('div'); head.className = 'sec-head';
      el.appendChild(head);
      for (const ln of s.lines) {
        const row = document.createElement('div'); row.className = 'line' + (ln.title ? ' title' : ''); row.dataset.id = ln.id;
        row.innerHTML = '<div class="txt"></div><div class="meta"></div>';
        row.querySelector('.txt').textContent = ln.text;
        row.addEventListener('click', () => select(ln.idx));
        el.appendChild(row);
      }
      head.addEventListener('click', () => select(s.lines[0].idx));
      root.appendChild(el);
    }
    renderLines();
    renderSelection(false);
  }

  function renderLines() {
    if (!P) return;
    for (const s of P.sections) {
      const head = document.querySelector(`.sec[data-id="${s.id}"] .sec-head`);
      head.innerHTML = `<span class="name"></span><span class="mark">${s.mark || ''}</span><span class="spacer"></span>
        <span class="num">${fmt(targetOf(s))} s</span>${hasRoom() ? `<span class="num" title="Room after this section">+${fmt(Math.max(0, s.roomAfter))}</span>` : ''}${chipHtml('sec:' + s.id, targetOf(s))}`;
      head.querySelector('.name').textContent = secName(s);
      for (const ln of s.lines) {
        const meta = document.querySelector(`.line[data-id="${ln.id}"] .meta`);
        meta.innerHTML = `<span class="mark">${ln.mark || ''}</span><span class="tgt num" title="${ln.est ? 'Estimated from the section time' : 'Target'}">${ln.est ? '~' : ''}${fmt(targetOf(ln))}</span>${chipHtml(ln.id, targetOf(ln))}`;
      }
    }
  }

  function renderSelection(scroll = true) {
    document.querySelectorAll('.line.selected, .sec.selected').forEach((el) => el.classList.remove('selected'));
    if (!P) return;
    const ln = curLine(); if (!ln) return;
    if (settings.mode === 'section') {
      const el = document.querySelector(`.sec[data-id="${ln.sec.id}"]`); el.classList.add('selected');
      if (scroll) el.scrollIntoView({ block: 'start' });
    } else {
      const el = document.querySelector(`.line[data-id="${ln.id}"]`); el.classList.add('selected');
      if (scroll) el.scrollIntoView({ block: 'center' });
    }
    renderPanel();
  }

  function renderPanel() {
    const ln = curLine();
    if (!P || !ln) {
      $('#selLabel').textContent = 'Nothing selected'; $('#selText').textContent = ''; $('#tgtVal').textContent = '—'; $('#roomVal').textContent = '';
      renderButtons(); return;
    }
    const item = settings.mode === 'section' ? ln.sec : ln;
    $('#selLabel').textContent = settings.mode === 'section'
      ? `Section · ${secName(ln.sec)} · ${ln.sec.lines.length} line${ln.sec.lines.length > 1 ? 's' : ''}`
      : `Line ${lineNo(ln)} · ${secName(ln.sec)}`;
    $('#selText').textContent = settings.mode === 'section' ? ln.sec.lines.map((l) => l.text).join(' ') : ln.text;
    $('#tgtVal').textContent = fmt(targetOf(item)) + ' s';
    $('#roomVal').textContent = hasRoom() ? `room after +${fmt(Math.max(0, item.roomAfter))}` : (item.est ? 'estimated target' : '');
    if (!take) {
      const lt = lastTake(settings.mode === 'section' ? 'sec:' + item.id : item.id);
      if (lt) {
        const g = VOT.grade(lt.d, targetOf(item), settings.tolerance);
        $('#clock').textContent = fmt(lt.d); $('#clock').className = 'clock ' + g.band;
        $('#verdict').textContent = 'Last take: ' + (g.delta <= 0 ? `${Math.abs(g.delta).toFixed(2)} s under` : `${g.delta.toFixed(2)} s over`);
        $('#verdict').className = 'verdict ' + g.band;
        setProgress(lt.d, targetOf(item), g.band);
      } else {
        $('#clock').textContent = '0.00'; $('#clock').className = 'clock';
        $('#verdict').textContent = ''; $('#verdict').className = 'verdict';
        setProgress(0, targetOf(item), '');
      }
    }
    renderButtons();
  }

  function setProgress(elapsed, target, band) {
    const scale = Math.max(target * 1.25, elapsed, 0.01);
    $('#progFill').style.width = Math.min(100, (elapsed / scale) * 100) + '%';
    $('#progFill').className = 'fill' + (band ? ' ' + band : '');
    $('#progTick').style.left = Math.min(99.5, (target / scale) * 100) + '%';
  }

  function renderTakeState(justFinished) {
    const arm = $('#btnArm'); const st = $('#status');
    if (take && take.status === 'armed') {
      arm.innerHTML = 'Armed<small>tap to cancel</small>'; arm.className = 'arm on';
      st.textContent = 'Armed. Start reading when ready'; st.className = 'status armed';
      $('#clock').textContent = '0.00'; $('#clock').className = 'clock';
      $('#parts').innerHTML = '';
      setProgress(0, targetOf(take.mode === 'section' ? take.sec : take.line), '');
    } else if (take && take.status === 'live') {
      arm.innerHTML = 'Timing<small>tap to finish</small>'; arm.className = 'arm live';
      st.textContent = 'Timing'; st.className = 'status live';
    } else {
      arm.textContent = 'Arm'; arm.className = 'arm';
      st.textContent = justFinished ? 'Take finished' : 'Ready'; st.className = 'status';
      if (!justFinished) renderPanel();
    }
    renderButtons();
  }

  function renderButtons() {
    const has = !!P && lines.length > 0;
    $('#btnPrev').disabled = !has || selIdx <= 0;
    $('#btnNext').disabled = !has || selIdx >= lines.length - 1;
    $('#btnPlay').disabled = !has || !refBuffer;
    $('#btnPlaySec').disabled = !has || !refBuffer;
    $('#btnPlay').textContent = playing ? 'Stop' : settings.mode === 'section' ? 'Play section' : 'Play line';
    $('#btnPlaySec').hidden = settings.mode === 'section';
    $('#btnPlaySec').textContent = 'Play section';
    $('#modeLine').setAttribute('aria-pressed', settings.mode === 'line');
    $('#modeSection').setAttribute('aria-pressed', settings.mode === 'section');
    $('#tgtStrict').setAttribute('aria-pressed', settings.target === 'strict');
    $('#tgtWindow').setAttribute('aria-pressed', settings.target === 'window' && hasRoom());
    $('#tgtStrict').setAttribute('aria-pressed', settings.target === 'strict' || !hasRoom());
    $('#tgtWindow').disabled = !!P && !hasRoom();
    const canDiscard = isLive() || (!!lastSaved && !!P);
    $('#btnDiscard').hidden = !canDiscard;
    $('#btnDiscard').textContent = isLive() ? 'Discard this take' : 'Discard last take';
  }

  function renderMeterThr() {
    const pos = ((settings.thresholdDb + 80) / 80) * 100;
    $('#meterThr').style.left = pos + '%'; $('#setThr').style.left = pos + '%';
  }

  function frame() {
    const pct = Math.max(0, Math.min(100, ((lastDb + 80) / 80) * 100));
    const hot = lastDb >= settings.thresholdDb;
    for (const id of ['#meterLvl', '#setLvl']) { const el = $(id); el.style.width = pct + '%'; el.classList.toggle('hot', hot); }
    if (micStream) $('#setLvlNum').textContent = lastDb.toFixed(0) + ' dB';
    if (isLive()) {
      const d = take.det; const tgt = targetOf(take.mode === 'section' ? take.sec : take.line);
      const pausing = d.now - d.lastSound > 0.25;
      const e = d.shown(0.25);                       // held at your last word while you pause
      const band = e <= tgt ? '' : e <= tgt + settings.tolerance ? 'close' : 'over';
      $('#clock').textContent = fmt(e); $('#clock').className = 'clock' + (band ? ' ' + band : '');
      setProgress(e, tgt, band);
      const waitingForTarget = d.o.minMs && (d.now - d.start) < tgt;
      $('#status').textContent = !pausing ? 'Timing' : waitingForTarget ? `Paused · listening until ${fmt(tgt)} s · tap to finish` : 'Paused · tap to finish';
    }
    requestAnimationFrame(frame);
  }

  // ---------- navigation ----------
  function select(idx, scroll = true, opts = {}) {
    if (!P) return;
    let keepArmed = false;
    if (take) {
      // Tapping the line (or section) you're armed on or reading does nothing.
      const target = lines[Math.max(0, Math.min(lines.length - 1, idx))];
      const same = take.mode === 'section' ? target.sec === take.sec : target === take.line;
      if (same) {
        // With "play each line" on, tapping the armed line replays it, then arms again. During a take it still does nothing.
        if (!(settings.autoPlay && refBuffer && take.status === 'armed')) return;
        take = null; renderTakeState(); clearPending(); stopPlayback();
        playSelection(false, () => { if (!take && !playing) arm(); });
        return;
      }
      // Tapping a different one cancels any take in progress (nothing saved) and goes there;
      // with auto re-arm on it stays armed on the new line, keeping the mic open.
      keepArmed = settings.autoArm;
      const wasLive = isLive();
      if (keepArmed) { take = null; renderTakeState(); } else cancelTake();
      if (wasLive) $('#status').textContent = 'Take cancelled';
    }
    clearPending();
    stopPlayback();
    selIdx = Math.max(0, Math.min(lines.length - 1, idx));
    store.set('vot.sel.' + P.id, selIdx);
    renderSelection(scroll);
    if (keepArmed) afterMove(true, 0);
    else if (!opts.noPlay) afterMove(false, 0);
  }
  // After moving to a line: play it if "play each line" is on, then arm if asked (arming waits for playback to finish).
  function afterMove(shouldArm, delay) {
    const armIt = () => { if (!take && !playing) arm(); };
    if (settings.autoPlay && refBuffer) playSelection(false, shouldArm ? armIt : null);
    else if (shouldArm) { if (delay) later(armIt, delay); else armIt(); }
  }
  function move(dir, opts = {}) {
    if (!P) return;
    if (settings.mode === 'section') {
      const secs = P.sections; const si = secs.indexOf(curSec());
      const ni = Math.max(0, Math.min(secs.length - 1, si + dir));
      select(secs[ni].lines[0].idx, true, opts);
    } else select(selIdx + dir, true, opts);
  }
  function playSelection(section, onDone) {
    if (isLive()) return;
    if (playing) { stopPlayback(); return; }
    const ln = curLine(); if (!ln) return;
    if (section || settings.mode === 'section') playRange(ln.sec.start, ln.sec.end, ln.sec.lines.map((l) => l.id), onDone);
    else playRange(ln.start, ln.end, [ln.id], onDone);
  }

  // ---------- history ----------
  function renderHistory() {
    const tbl = $('#histTable');
    if (!P) { tbl.innerHTML = '<tr><td>No project loaded.</td></tr>'; return; }
    const rows = [];
    for (const [key, arr] of Object.entries(takes)) {
      const isSec = key.startsWith('sec:');
      const item = isSec ? P.sections.find((s) => 'sec:' + s.id === key) : lines.find((l) => l.id === key);
      if (!item) continue;
      for (const t of arr) rows.push({ key, isSec, item, t });
    }
    rows.sort((a, b) => b.t.ts - a.t.ts);
    if (!rows.length) { tbl.innerHTML = '<tr><td>No takes yet. Arm a line and read it.</td></tr>'; return; }
    tbl.innerHTML = '<thead><tr><th>When</th><th>Line or section</th><th class="n">Take</th><th class="n">Target</th><th class="n">Diff</th></tr></thead><tbody></tbody>';
    const tb = tbl.querySelector('tbody');
    for (const r of rows.slice(0, 400)) {
      const tgt = targetOf(r.item); const g = VOT.grade(r.t.d, tgt, settings.tolerance);
      const tr = document.createElement('tr');
      const name = r.isSec ? 'Section: ' + secName(r.item) : `Line ${lineNo(r.item)}: ${r.item.text}`;
      tr.innerHTML = `<td class="n">${new Date(r.t.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td><td></td>
        <td class="n"><span class="chip ${g.band}${r.t.est ? ' est' : ''}">${fmt(r.t.d)}</span></td><td class="n">${fmt(tgt)}</td><td class="n">${sign(g.delta)}</td>`;
      tr.children[1].textContent = name.length > 70 ? name.slice(0, 68) + '…' : name;
      tb.appendChild(tr);
    }
  }
  function exportCsv() {
    if (!P) return;
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const out = [['Time', 'Kind', 'Section', 'Line', 'Text', 'Take (s)', 'Strict target (s)', 'Window target (s)', 'Diff vs strict (s)', 'Split estimate'].join(',')];
    for (const [key, arr] of Object.entries(takes)) {
      const isSec = key.startsWith('sec:');
      const item = isSec ? P.sections.find((s) => 'sec:' + s.id === key) : lines.find((l) => l.id === key);
      if (!item) continue;
      for (const t of arr) {
        out.push([new Date(t.ts).toISOString(), isSec ? 'section' : 'line', q(secName(isSec ? item : item.sec)), isSec ? '' : lineNo(item),
          q(isSec ? item.lines.map((l) => l.text).join(' ') : item.text), t.d.toFixed(3), item.dur.toFixed(3),
          (item.dur + Math.max(0, item.roomAfter)).toFixed(3), (t.d - item.dur).toFixed(3), t.est ? 'yes' : ''].join(','));
      }
    }
    const blob = new Blob([out.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (P.title || 'takes').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '_takes.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- settings UI ----------
  function syncSettingsUI() {
    $('#sThr').value = settings.thresholdDb; $('#oThr').textContent = settings.thresholdDb + ' dB';
    $('#sHoldLine').value = settings.holdLine; $('#oHoldLine').textContent = settings.holdLine.toFixed(2) + ' s';
    $('#sHoldSec').value = settings.holdSection; $('#oHoldSec').textContent = settings.holdSection.toFixed(1) + ' s';
    $('#sTol').value = settings.tolerance; $('#oTol').textContent = settings.tolerance.toFixed(2) + ' s';
    $('#sText').value = settings.textSize; $('#oText').textContent = settings.textSize + ' px';
    $('#selAdv').value = settings.autoAdvance; $('#cArm').checked = settings.autoArm; $('#cPlay').checked = settings.autoPlay;
    $('#appVersion').textContent = 'VO Timer ' + APP_VERSION; $('#cMin').checked = settings.listenToTarget;
    $('#sMinTake').value = settings.minTakePct; $('#oMinTake').textContent = settings.minTakePct ? settings.minTakePct + '% of target' : 'Off';
    $('#selTheme').value = settings.theme;
    document.documentElement.style.setProperty('--script-size', settings.textSize + 'px');
    document.documentElement.dataset.theme = settings.theme;
  }
  function bindRange(id, key, parse) {
    $(id).addEventListener('input', (e) => { settings[key] = parse(e.target.value); saveSettings(); syncSettingsUI(); renderMeterThr(); if (key === 'tolerance') { renderLines(); renderPanel(); } });
  }
  function openSettings() { syncSettingsUI(); $('#dlgSettings').showModal(); }
  function openProjects() { renderProjectList(); $('#dlgProjects').showModal(); }
  function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
    catch (e) { /* not granted; screen may sleep */ }
  }

  // ---------- wiring ----------
  function wire() {
    $('#btnArm').onclick = armButton;
    $('#btnDiscard').onclick = discard;
    $('#btnPrev').onclick = () => move(-1);
    $('#btnNext').onclick = () => move(1);
    $('#btnPlay').onclick = () => playSelection(false);
    $('#btnPlaySec').onclick = () => playSelection(true);
    $('#modeLine').onclick = () => { if (isLive()) return; settings.mode = 'line'; saveSettings(); cancelTake(); renderSelection(); };
    $('#modeSection').onclick = () => { if (isLive()) return; settings.mode = 'section'; saveSettings(); cancelTake(); renderSelection(); };
    $('#tgtStrict').onclick = () => { settings.target = 'strict'; saveSettings(); renderLines(); renderPanel(); };
    $('#tgtWindow').onclick = () => { settings.target = 'window'; saveSettings(); renderLines(); renderPanel(); };
    $('#btnSettings').onclick = openSettings;
    $('#btnProjects').onclick = openProjects;
    $('#btnOpenEmpty').onclick = () => $('#fileInput').click();
    $('#btnOpenFile').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = (e) => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; };
    $('#btnHistory').onclick = () => { renderHistory(); $('#clearConfirm').hidden = true; $('#dlgHistory').showModal(); };
    $('#btnExport').onclick = exportCsv;
    $('#btnClear').onclick = () => { $('#clearConfirm').hidden = false; };
    $('#btnClearNo').onclick = () => { $('#clearConfirm').hidden = true; };
    $('#btnClearYes').onclick = () => { takes = {}; if (P) store.set('vot.takes.' + P.id, takes); $('#clearConfirm').hidden = true; renderHistory(); renderLines(); renderPanel(); };
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
    $('#btnMic').onclick = () => ensureMic();
    $('#btnRoom').onclick = () => startCalib('room');
    $('#btnVoice').onclick = () => startCalib('voice');
    bindRange('#sThr', 'thresholdDb', (v) => parseInt(v, 10));
    bindRange('#sHoldLine', 'holdLine', parseFloat);
    bindRange('#sHoldSec', 'holdSection', parseFloat);
    bindRange('#sTol', 'tolerance', parseFloat);
    bindRange('#sText', 'textSize', (v) => parseInt(v, 10));
    bindRange('#sMinTake', 'minTakePct', (v) => parseInt(v, 10));
    $('#selAdv').onchange = (e) => { settings.autoAdvance = e.target.value; saveSettings(); };
    $('#cArm').onchange = (e) => { settings.autoArm = e.target.checked; saveSettings(); };
    $('#cPlay').onchange = (e) => { settings.autoPlay = e.target.checked; saveSettings(); };
    $('#cMin').onchange = (e) => { settings.listenToTarget = e.target.checked; saveSettings(); };
    $('#selTheme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); syncSettingsUI(); };

    document.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter') { e.preventDefault(); armButton(); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); if (take && take.status === 'armed') cancelTake(); else discard(); }
      else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); move(1); }
      else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); move(-1); }
      else if (k === 'p' || k === 'P') { e.preventDefault(); playSelection(false); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseMic();
      else requestWakeLock();
    });
    window.addEventListener('blur', () => { setTimeout(() => { if (!document.hasFocus()) releaseMic(); }, 250); });
    $('#dlgSettings').addEventListener('close', idleMic);
    document.addEventListener('pointerdown', requestWakeLock, { passive: true });
    document.addEventListener('keydown', requestWakeLock);
  }

  async function boot() {
    syncSettingsUI(); renderMeterThr(); wire(); renderScript(); renderButtons(); requestWakeLock();
    requestAnimationFrame(frame);
    const last = store.get('vot.last', null);
    if (last) { try { await openProject(last); } catch (e) { /* storage unavailable */ } }
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__vot = { get mic() { return micStream; }, get take() { return take; }, get takes() { return takes; }, get lines() { return lines; }, settings, select, arm, handleFiles };
  boot();
})();
