/* app.js — player with OSMD, piano roll, visual transpose, global audio transpose,
   score cursor (show on play), BPM override, loop/hideLog/title flags, and URL loading. */

(() => {
  // ---------- Utilities ----------
  const $ = (sel) => document.querySelector(sel);
  const logEl = $('#status');
  let loggingEnabled = true;
  const log = (...a) => {
    if (!loggingEnabled || !logEl) return;
    logEl.textContent += a.join(' ') + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };

  const params = new URLSearchParams(location.search);

  // Flags
  const xmlURL         = params.get('xml') || '';
  const urlBPM         = params.get('bpm');                   // number
  const urlLoop        = params.get('loop') === '1';          // default off
  const urlHideLog     = params.get('hideLog') === '1';       // hide status block
  const transposeVis   = parseInt(params.get('transposeVis') || '0', 10) || 0;  // visual-only semitones
  const transposeAudio = parseInt(params.get('transposeAudio') || '0', 10) || 0; // GLOBAL audio semitones
  const highlightScore = params.get('highlightScore') === '1';
  const titleParam     = params.get('title');

  // Apply title (keep emoji if your HTML has #titleText span)
  const titleSpan = $('#titleText');
  if (titleParam && titleSpan) titleSpan.textContent = titleParam;

  // Hide log if requested
  if (urlHideLog && logEl) {
    logEl.style.display = 'none';
    loggingEnabled = false;
  }

  // ---------- DOM ----------
  const playBtn  = $('#play');
  const stopBtn  = $('#stop');
  const loopCb   = $('#loop');
  const bpmInput = $('#bpm');
  const bpmVal   = $('#bpmVal');
  const kb       = $('#kb');
  const rollCv   = $('#roll');
  const ctx      = rollCv?.getContext('2d');

  // Guard if essentials missing
  if (!playBtn || !stopBtn || !bpmInput || !bpmVal || !kb || !rollCv || !ctx || !$('#osmd')) {
    console.error('Required elements not found in the page.');
    return;
  }

  // ---------- State ----------
  // Notes represented in QUARTERS
  // each note: { p: midi, qStart: number, qEnd: number }
  let notesQ = [];
  let totalQ = 0;

  // Keyboard range (for roll drawing)
  const MIN_OCTAVES = 2;
  const PAD_SEMITONES = 1;
  const MIDI_BASE_FOR_LAYOUT = 24; // all-around-keyboard emits MIDI = 24 + index

  let LOWEST_PITCH = 60;
  let TOTAL_KEYS   = 12 * (parseInt(kb.getAttribute('octaves')) || MIN_OCTAVES);

  const getLeftmostIndex = () => Number(kb.getAttribute('leftmostKey') || 48);
  const setLeftmostIndex = (idx) => kb.setAttribute('leftmostKey', String(Math.max(0, Math.round(idx))));
  const toIdx = (midi) => midi - LOWEST_PITCH;

  // Timing / transport
  let playing   = false;
  let startedAt = 0;   // performance.now()/1000 at start
  let rafId     = null;

  // Audio
  const audio = { ctx: null, master: null, voices: new Map(), scheduled: [] };

  // OSMD + cursor
  let osmd = null;
  let scoreCursorReady = false;  // cursor available to use
  let scoreCursorShown = false;  // currently visible

  // ---------- BPM helpers ----------
  const currentBPM = () => Number(bpmInput.value) || 100;
  const quartersPerSecond = () => currentBPM() / 60;
  const secondsPerQuarter = () => 60 / currentBPM();

  // ---------- Audio synth ----------
  function audioInit() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.15;
    audio.master.connect(audio.ctx.destination);
    log('🔊 AudioContext ready. state=' + audio.ctx.state);
  }
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function mkVoice(freq, vel = 0.22) {
    const osc = audio.ctx.createOscillator();
    const gain = audio.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, audio.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vel), audio.ctx.currentTime + 0.01);
    osc.connect(gain).connect(audio.master);
    return { osc, gain };
  }
  function clampMidi(m) { return Math.min(127, Math.max(0, Math.round(m))); }

  function noteOn(midi, vel = 0.8) {
    if (!audio.ctx) audioInit();
    audio.ctx.resume?.();
    const mClamped = clampMidi(midi);
    if (audio.voices.has(mClamped)) return;
    const v = mkVoice(midiToFreq(mClamped), vel);
    v.osc.start();
    audio.voices.set(mClamped, v);
  }
  function noteOff(midi) {
    if (!audio.ctx) return;
    const mClamped = clampMidi(midi);
    const v = audio.voices.get(mClamped);
    if (!v) return;
    const t = audio.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, 0.03);
    v.osc.stop(t + 0.08);
    setTimeout(() => audio.voices.delete(mClamped), 120);
  }
  function clearScheduledAudio() {
    if (!audio.ctx) return;
    for (const n of audio.scheduled) {
      try {
        const t = audio.ctx.currentTime;
        n.gain.gain.cancelScheduledValues(t);
        n.gain.gain.setTargetAtTime(0.0001, t, 0.02);
        n.osc.stop(t + 0.05);
      } catch {}
    }
    audio.scheduled.length = 0;
  }
  function panicAll() {
    clearScheduledAudio();
    for (const [m, v] of audio.voices) { try { v.osc.stop(); } catch {} }
    audio.voices.clear();
  }

  // ---------- Manual keyboard mapping ----------
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = (m) => Number.isInteger(m) && m >= 0 && m <= 127;

  // Manual key → sound:
  //   - compensate visual transpose so manual pitch matches the score
  //   - then apply global audio transpose so we hear the transposition
  kb.addEventListener('noteon', (e) => {
    const m = midiFromKbEvent(e);
    if (!isValidMidi(m)) return;
    const soundMidi = clampMidi(m - transposeVis + transposeAudio);
    noteOn(soundMidi, 0.7);
  });
  kb.addEventListener('noteoff', (e) => {
    const m = midiFromKbEvent(e);
    if (!isValidMidi(m)) return;
    const soundMidi = clampMidi(m - transposeVis + transposeAudio);
    noteOff(soundMidi);
  });
  kb.addEventListener('noteOff', (e) => {
    const m = midiFromKbEvent(e);
    if (!isValidMidi(m)) return;
    const soundMidi = clampMidi(m - transposeVis + transposeAudio);
    noteOff(soundMidi);
  });
  kb.addEventListener('keypress', (e) => {
    const m = midiFromKbEvent(e);
    if (!isValidMidi(m)) return;
    const soundMidi = clampMidi(m - transposeVis + transposeAudio);
    noteOn(soundMidi, 0.7);
  });
  kb.addEventListener('keyrelease', (e) => {
    const m = midiFromKbEvent(e);
    if (!isValidMidi(m)) return;
    const soundMidi = clampMidi(m - transposeVis + transposeAudio);
    noteOff(soundMidi);
  });

  // ---------- Keyboard lighting (visual only) ----------
  function indexFromMidiVisual(m) {
    // Visual-only transpose affects which keys light up
    const midiVis = m + transposeVis;
    return getLeftmostIndex() + (midiVis - LOWEST_PITCH);
  }
  function lightMidi(m) {
    const idx = indexFromMidiVisual(m);
    if (typeof kb.keysLight === 'function') kb.keysLight([idx]);
  }
  function dimMidi(m) {
    const idx = indexFromMidiVisual(m);
    if (typeof kb.keysDim === 'function') kb.keysDim([idx]);
  }

  // ---------- OSMD ----------
  let osmd = null;
  let osmdHost = $('#osmd');
  let scoreCursorReady = false;
  let scoreCursorShown = false;

  async function renderXML(text) {
    if (!window.opensheetmusicdisplay) throw new Error('OSMD script not loaded.');
    if (!osmd) osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd', { drawingParameters: 'compact' });
    await osmd.load(text);
    await osmd.render();

    if (highlightScore && osmd.cursor) {
      // Initialize cursor silently (hidden until Play)
      try {
        if (typeof osmd.cursor.hide === 'function') osmd.cursor.hide();
        scoreCursorReady = true;
        scoreCursorShown = false;
        log('🎯 Score highlight: cursor ready (hidden until Play).');
      } catch {
        scoreCursorReady = false;
        scoreCursorShown = false;
        log('⚠️ Score cursor could not be prepared (non-fatal).');
      }
    } else {
      scoreCursorReady = false;
      scoreCursorShown = false;
    }
  }

  function ensureCursorShownAt(qElapsed) {
    if (!highlightScore || !scoreCursorReady || !osmd?.cursor) return;
    if (!scoreCursorShown) {
      try {
        osmd.cursor.show();
        if (typeof osmd.cursor.reset === 'function') osmd.cursor.reset();
        scoreCursorShown = true;
      } catch {}
    }
    updateScoreCursor(qElapsed);
  }

  function hideCursor() {
    if (!highlightScore || !osmd?.cursor) return;
    try { osmd.cursor.hide(); } catch {}
    scoreCursorShown = false;
  }

  function updateScoreCursor(qElapsed) {
    if (!highlightScore || !scoreCursorShown || !osmd || !osmd.cursor) return;
    const bpm = currentBPM();
    const ms = (qElapsed * 60000) / Math.max(1, bpm);
    try {
      if (typeof osmd.cursor.goToTime === 'function') {
        osmd.cursor.goToTime(ms);
      }
    } catch {}
  }

  // ---------- MusicXML parsing → quarters ----------
  async function detectTempoFromXMLText(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');

    const soundWithTempo = xml.querySelector('sound[tempo]');
    const tempoAttr = Number(soundWithTempo?.getAttribute('tempo'));
    if (Number.isFinite(tempoAttr) && tempoAttr > 0) return Math.round(tempoAttr);

    const met = xml.querySelector('direction-type > metronome');
    if (met) {
      const perMin = Number(met.querySelector('per-minute')?.textContent);
      const unit = met.querySelector('beat-unit')?.textContent?.trim()?.toLowerCase();
      if (Number.isFinite(perMin) && perMin > 0 && unit) {
        const base = { 'whole': 4, 'half': 2, 'quarter': 1, 'eighth': 0.5, '8th': 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 }[unit] ?? 1;
        const dots = met.querySelectorAll('beat-unit-dot').length;
        let dotFactor = 1; for (let k = 1; k <= dots; k++) dotFactor += Math.pow(0.5, k);
        const beatInQuarters = base * dotFactor;
        const qpm = perMin * beatInQuarters;
        return Math.max(1, Math.round(qpm));
      }
    }
    return null;
  }

  async function extractNotesFromXMLText(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const stepToSemitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

    const parts = Array.from(xml.querySelectorAll('score-partwise > part, part'));
    const collected = [];

    for (const part of parts) {
      let divisions = Number(part.querySelector('attributes > divisions')?.textContent || xml.querySelector('divisions')?.textContent || 1);

      const voiceTimesQ = new Map(); // voiceId -> quarters
      const tieOpen = new Map();     // "voice|midi" -> index

      const measures = Array.from(part.querySelectorAll(':scope > measure'));
      for (const meas of measures) {
        const dHere = meas.querySelector('attributes > divisions');
        if (dHere) divisions = Number(dHere.textContent) || divisions;

        const events = Array.from(meas.querySelectorAll(':scope > note, :scope > backup, :scope > forward'));
        for (const ev of events) {
          if (ev.tagName === 'backup') {
            const dq = Number(ev.querySelector('duration')?.textContent || 0) / divisions;
            for (const [v, t] of voiceTimesQ.entries()) voiceTimesQ.set(v, Math.max(0, t - dq));
            continue;
          }
          if (ev.tagName === 'forward') {
            const dq = Number(ev.querySelector('duration')?.textContent || 0) / divisions;
            for (const [v, t] of voiceTimesQ.entries()) voiceTimesQ.set(v, t + dq);
            continue;
          }

          const isRest = !!ev.querySelector('rest');
          const isChordFollower = !!ev.querySelector('chord');
          const voiceId = ev.querySelector('voice')?.textContent?.trim() || '1';
          const curQ = voiceTimesQ.get(voiceId) ?? 0;

          let durDivs = ev.querySelector('duration') ? Number(ev.querySelector('duration').textContent) : NaN;
          if (!Number.isFinite(durDivs) && isChordFollower) durDivs = 0;
          const dq = (durDivs / divisions) || 0;

          if (!isRest) {
            const step = ev.querySelector('step')?.textContent;
            const alter = Number(ev.querySelector('alter')?.textContent || 0);
            const octave = Number(ev.querySelector('octave')?.textContent);
            if (step && Number.isFinite(octave)) {
              const pitchMidi = 12 * (octave + 1) + stepToSemitone[step] + alter;
              const qStart = curQ;
              const qEnd   = qStart + dq;

              const tieTags = Array.from(ev.querySelectorAll('tie'));
              const hasTieStart = tieTags.some(t => t.getAttribute('type') === 'start');
              const hasTieStop  = tieTags.some(t => t.getAttribute('type') === 'stop');
              const tieKey = voiceId + '|' + pitchMidi;

              if (hasTieStop && tieOpen.has(tieKey)) {
                const idx = tieOpen.get(tieKey);
                if (idx != null && collected[idx]) {
                  collected[idx].qEnd = Math.max(collected[idx].qEnd, qEnd);
                }
              }
              if (!hasTieStop || hasTieStart) {
                if (qEnd > qStart) {
                  const newIdx = collected.push({ p: pitchMidi, qStart, qEnd, _v: voiceId }) - 1;
                  if (hasTieStart) tieOpen.set(tieKey, newIdx); else tieOpen.delete(tieKey);
                }
              }
              if (hasTieStop && !hasTieStart) tieOpen.delete(tieKey);
            }
          }

          if (!isChordFollower) voiceTimesQ.set(voiceId, curQ + dq);
        }
      }
    }

    notesQ = collected.filter(n => n.qEnd > n.qStart).sort((a, b) => a.qStart - b.qStart);
    totalQ = notesQ.length ? Math.max(...notesQ.map(n => n.qEnd)) : 0;

    if (!notesQ.length) {
      log('⚠️ XML-Parser fand keine Noten.');
    } else {
      log(`XML-Parser: ${notesQ.length} Noten, Dauer: ${totalQ.toFixed(2)} Viertel`);
      autoFitKeyboard(notesQ);
    }
  }

  // ---------- Auto-fit keyboard to notes (no visual transpose here) ----------
  function autoFitKeyboard(noteArrayQ) {
    if (!noteArrayQ.length) return;
    const lowNote  = noteArrayQ.reduce((m, n) => Math.min(m, n.p), 127);
    const highNote = noteArrayQ.reduce((m, n) => Math.max(m, n.p), 0);

    let low  = Math.max(0,   lowNote  - PAD_SEMITONES);
    let high = Math.min(127, highNote + PAD_SEMITONES);

    const fitLow  = Math.floor(low / 12) * 12;
    const fitHigh = Math.ceil((high + 1) / 12) * 12 - 1;

    const neededKeys = (fitHigh - fitLow + 1);
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil(neededKeys / 12));

    LOWEST_PITCH = fitLow;
    TOTAL_KEYS   = neededOcts * 12;

    kb.setAttribute('octaves', String(neededOcts));
    const leftmostIndex = Math.max(0, LOWEST_PITCH - MIDI_BASE_FOR_LAYOUT);
    setLeftmostIndex(leftmostIndex);

    kb.offsetWidth; // force layout
    const finalHigh = LOWEST_PITCH + TOTAL_KEYS - 1;
    log(`🧩 Auto-fit → MIDI ${LOWEST_PITCH}..${finalHigh} | Oktaven: ${neededOcts} | leftmostKey=${leftmostIndex}`);
  }

  // ---------- Roll drawing (true to score; no visual transpose) ----------
  function ensureCanvasSize() {
    const W = rollCv.clientWidth;
    const H = rollCv.clientHeight;
    if (rollCv.width !== W) rollCv.width = W;
    if (rollCv.height !== H) rollCv.height = H;
  }
  function drawRoll() {
    ensureCanvasSize();
    const pad = 6, W = rollCv.width, H = rollCv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f3f5fb';
    ctx.fillRect(0, 0, W, H);
    if (!notesQ.length || totalQ <= 0) return;

    const qToX = (q) => pad + (W - 2 * pad) * (q / totalQ);
    const keyH = (H - 2 * pad) / TOTAL_KEYS;
    ctx.fillStyle = '#2f6fab';

    for (const n of notesQ) {
      const i = toIdx(n.p);
      if (i < 0 || i >= TOTAL_KEYS) continue;
      const x = qToX(n.qStart);
      const w = Math.max(2, qToX(n.qEnd) - qToX(n.qStart));
      const y = H - pad - (i + 1) * keyH;
      ctx.fillRect(x, y, w, keyH - 1);
    }
  }
  function drawPlayhead(qNow) {
    if (totalQ <= 0) return;
    const pad = 6, W = rollCv.width;
    const x = pad + (W - 2 * pad) * (Math.min(qNow, totalQ) / totalQ);
    ctx.strokeStyle = '#e74c3c';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rollCv.height);
    ctx.stroke();
  }

  // ---------- Scheduling (sound + lights) ----------
  function scheduleAllAtCurrentTempo() {
    audioInit();
    audio.ctx.resume?.();

    clearScheduledAudio();

    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;

    for (const n of notesQ) {
      const s = n.qStart * secondsPerQuarter();
      const d = Math.max(0, (n.qEnd - n.qStart) * secondsPerQuarter());
      if (d <= 0) continue;

      // AUDIO: apply global transposeAudio only (roll/score stay true)
      const playMidi = clampMidi(n.p + transposeAudio);
      const v = mkVoice(midiToFreq(playMidi), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      audio.scheduled.push(v);

      // VISUAL LIGHTS: use raw score midi + transposeVis (handled inside lightMidi/dimMidi)
      setTimeout(() => lightMidi(n.p), Math.max(0, (startBase + s - audio.ctx.currentTime)) * 1000);
      setTimeout(() => dimMidi(n.p),   Math.max(0, (startBase + s + d - audio.ctx.currentTime)) * 1000);

      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${currentBPM()} (transposeAudio=${transposeAudio})`);
  }

  // ---------- Transport ----------
  function start() {
    if (!notesQ.length || playing) { if (!notesQ.length) log('⚠️ Keine Noten geladen.'); return; }
    playing = true;
    startedAt = performance.now() / 1000;

    // show score cursor only now (not during load)
    if (highlightScore && scoreCursorReady) {
      try {
        ensureCursorShownAt(0);
      } catch {}
    }

    scheduleAllAtCurrentTempo();
    tick();
  }
  function stop() {
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    clearScheduledAudio();
    panicAll();
    hideCursor();                 // hide cursor when stopped
    drawRoll();                   // clear playhead
  }
  function tick() {
    if (!playing) return;
    const secondsElapsed = performance.now() / 1000 - startedAt;
    const qElapsed = secondsElapsed * quartersPerSecond();

    if (totalQ > 0 && qElapsed >= totalQ) {
      if (loopCb.checked) {
        stop(); start(); return;
      } else {
        stop(); return;
      }
    }
    drawRoll();
    drawPlayhead(Math.min(qElapsed, totalQ));

    // Move cursor while playing
    ensureCursorShownAt(qElapsed);

    rafId = requestAnimationFrame(tick);
  }

  // ---------- UI wiring ----------
  loopCb.checked = urlLoop;
  bpmInput.addEventListener('input', (e) => {
    bpmVal.textContent = String(e.target.value);
    if (playing) { stop(); start(); }
  });

  // if ?bpm= provided, override after load; else we may adopt XML tempo if present
  if (urlBPM && Number(urlBPM) > 0) {
    bpmInput.value = String(Number(urlBPM));
  }
  bpmVal.textContent = bpmInput.value;

  // ---------- Fetch + load ----------
  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.text();
  }

  async function loadXMLFromURL(url) {
    log('🌐 Lade XML von URL:', url);
    const text = await fetchText(url);

    // Detect tempo (only if user did NOT pass bpm)
    const detected = await detectTempoFromXMLText(text);
    if (!urlBPM && detected && detected > 0) {
      bpmInput.value = String(detected);
      bpmVal.textContent = String(detected);
      log('⏱ Tempo aus MusicXML:', detected, 'BPM');
    } else if (urlBPM) {
      log('⏱ Tempo via URL:', Number(urlBPM), 'BPM (overrides XML)');
    }

    await renderXML(text);
    await extractNotesFromXMLText(text);
    drawRoll();

    const has = notesQ.length > 0;
    playBtn.disabled = stopBtn.disabled = !has;
  }

  playBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  // ---------- Canvas resize handling ----------
  const ro = new ResizeObserver(() => { drawRoll(); });
  ro.observe(rollCv);

  // ---------- Kick things off ----------
  (async function init() {
    try {
      if (xmlURL) {
        await loadXMLFromURL(xmlURL);
      } else {
        log('ℹ️ No ?xml= provided. Use the URL flag to load a MusicXML.');
        playBtn.disabled = stopBtn.disabled = true;
      }
    } catch (err) {
      console.error(err);
      log('❌ Fehler beim Laden:', err?.message || err);
      playBtn.disabled = stopBtn.disabled = true;
    }
  })();
})();
