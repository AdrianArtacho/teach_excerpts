/* app.js — single bundle */

(function () {
  // --- Small logger that can be disabled via ?hideLog=1
  const $ = (sel) => document.querySelector(sel);
  const statusEl = $('#status');

  const params = new URLSearchParams(location.search);

  // After: const params = new URLSearchParams(location.search);
  (() => {
    const t = params.get('title');
    if (!t) return;
    // Update the H1 (keeps the emoji if your HTML has it)
    const titleTextEl = document.getElementById('titleText');
    if (titleTextEl) titleTextEl.textContent = t;
    // Also update the browser tab title (optional but nice)
    document.title = `🎹 ${t}`;
  })();



  const hideLog = params.get('hideLog') === '1';

  function log(...a) {
    if (hideLog || !statusEl) return;
    statusEl.textContent += a.join(' ') + '\n';
    statusEl.scrollTop = statusEl.scrollHeight;
  }

  // --- Score-fit / Score-zoom URL flags
  let scoreFitActive = (() => {
    const v = params.get('scoreFit');
    return v !== null && /^(1|true|yes|on|fit|fill)$/i.test(v);
  })();
  let scoreZoomOverride = (() => {
    const z = params.get('scoreZoom');
    return z && !isNaN(+z) ? Math.max(0.1, Math.min(5, +z)) : null;
  })();

  if (scoreFitActive) log('🎼 scoreFit: ON (fit to container width)');
  if (scoreZoomOverride != null) log('🎼 scoreZoom override:', scoreZoomOverride);

  // --- Transpose visuals only (keyboard + lighting), sound & roll keep real pitch
  const transposeVis = (() => {
    const t = params.get('transposeVis');
    return t && !isNaN(+t) ? Math.round(+t) : 0;
  })();
  if (transposeVis !== 0) log('🎚 transposeVis:', transposeVis, '(visual only)');

  // --- Loop default via URL
  const loopDefault = (() => {
    const v = params.get('loop');
    return v !== null && /^(1|true|yes|on)$/i.test(v);
  })();

  // --- Hide log panel if requested
  if (hideLog && statusEl) {
    statusEl.style.display = 'none';
  }

  // --- UI refs
  const xmlInput = $('#xmlFile');
  const playBtn = $('#play');
  const stopBtn = $('#stop');
  const loopCb = $('#loop');
  const bpm = $('#bpm');
  const bpmVal = $('#bpmVal');
  const testBtn = $('#testTone');
  const panicBtn = $('#panic');
  const kb = $('#kb');
  const rollCv = $('#roll');
  const ctx = rollCv.getContext('2d');
  const scoreContainer = $('#osmd');

  // Apply loop default
  if (loopCb && loopDefault) loopCb.checked = true;

  // --- Await keyboard readiness (custom element)
  const ready = window.customElements?.whenDefined
    ? window.customElements.whenDefined('all-around-keyboard').catch(() => {})
    : Promise.resolve();

  // ---------- Config & state ----------
  let scoreBPM = 100;           // dynamically set from XML/MIDI
  const MIN_OCTAVES = 2;
  const PAD_SEMITONES = 1;
  const LOWEST_EMITTABLE_MIDI = 24; // component emits midi = 24 + index

  let LOWEST_PITCH = 60; // updated by fit/range
  let TOTAL_KEYS = 12 * (parseInt(kb.getAttribute('octaves')) || MIN_OCTAVES);
  const toIdx = (p) => p - LOWEST_PITCH;

  // Component mapping: index 0 == MIDI 24 (C1)
  const MIDI_BASE_FOR_LAYOUT = 24;
  const getLeftmostIndex = () => Number(kb.getAttribute('leftmostKey') || 48);
  const setLeftmostIndex = (idx) =>
    kb.setAttribute('leftmostKey', String(Math.max(0, Math.round(idx))));

  // Map a *visual* MIDI to component index (apply transposeVis)
  const indexFromMidiVisual = (midi) =>
    getLeftmostIndex() + ((midi + transposeVis) - LOWEST_PITCH);

  // Notes & transport
  let notes = [];   // {p,s,e} at *real* pitch/time
  let total = 0;
  let playing = false, startedAt = 0, t0 = 0, rafId = null;
  let scheduled = [], loopTimer = null, lightTimers = [];

  // Range override from URL
  let userRangeOverride = null; // { low, high, strict }

  // ---------- Audio ----------
  const audio = { ctx: null, master: null, voices: new Map() };

  function audioInit() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.15;
    audio.master.connect(audio.ctx.destination);
    log('🔊 AudioContext created. state=' + audio.ctx.state);
  }
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function mkVoice(freq, vel = 0.25) {
    const osc = audio.ctx.createOscillator();
    const gain = audio.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, audio.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vel), audio.ctx.currentTime + 0.01);
    osc.connect(gain).connect(audio.master);
    return { osc, gain };
  }
  function noteOn(midi, vel = 0.8) {
    if (!audio.ctx) audioInit();
    audio.ctx.resume?.();
    if (audio.voices.has(midi)) return;
    const v = mkVoice(midiToFreq(midi), vel);
    v.osc.start();
    audio.voices.set(midi, v);
  }
  function noteOff(midi) {
    if (!audio.ctx) return;
    const v = audio.voices.get(midi);
    if (!v) return;
    const t = audio.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, 0.03);
    v.osc.stop(t + 0.08);
    setTimeout(() => audio.voices.delete(midi), 120);
  }

  testBtn?.addEventListener('click', () => {
    audioInit();
    audio.ctx.resume?.().then(() => {
      log('Test resume state=' + audio.ctx.state);
      const v = mkVoice(440, 0.2);
      v.osc.start();
      v.osc.stop(audio.ctx.currentTime + 0.3);
    }).catch(e => log('Test resume err: ' + e));
  });

  function clearLightingTimers(andDim = false) {
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim) {
      const L = getLeftmostIndex();
      const allIdx = Array.from({ length: TOTAL_KEYS }, (_, i) => L + i);
      if (typeof kb.keysDim === 'function') kb.keysDim(allIdx);
    }
  }
  function allNotesOff() {
    for (const n of scheduled) { try { n.osc.stop(); } catch {} }
    scheduled.length = 0;
    for (const [, v] of audio.voices) { try { v.osc.stop(); } catch {} }
    audio.voices.clear();
    clearLightingTimers(true);
  }
  panicBtn?.addEventListener('click', () => { allNotesOff(); log('⏹ Panic: all voices stopped, lights cleared.'); });

  // ---------- Manual key input: VISUAL transpose only (sound = midi - transposeVis) ----------
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = (m) => Number.isInteger(m) && m >= 0 && m <= 127;

  function visualToAudioMidi(m) {
    // Clicking a visually transposed key should produce *real* pitch:
    // audioMidi = visualMidi - transposeVis
    return Math.max(0, Math.min(127, m - transposeVis));
  }

  kb?.addEventListener('noteon', (e) => {
    const mVis = midiFromKbEvent(e);
    if (!isValidMidi(mVis)) return;
    const mAudio = visualToAudioMidi(mVis);
    noteOn(mAudio, 0.7);
  });
  kb?.addEventListener('keypress', (e) => {
    const mVis = midiFromKbEvent(e);
    if (!isValidMidi(mVis)) return;
    const mAudio = visualToAudioMidi(mVis);
    noteOn(mAudio, 0.7);
  });
  kb?.addEventListener('noteoff', (e) => {
    const mVis = midiFromKbEvent(e);
    if (!isValidMidi(mVis)) return;
    const mAudio = visualToAudioMidi(mVis);
    noteOff(mAudio);
  });
  kb?.addEventListener('noteOff', (e) => {
    const mVis = midiFromKbEvent(e);
    if (!isValidMidi(mVis)) return;
    const mAudio = visualToAudioMidi(mVis);
    noteOff(mAudio);
  });
  kb?.addEventListener('keyrelease', (e) => {
    const mVis = midiFromKbEvent(e);
    if (!isValidMidi(mVis)) return;
    const mAudio = visualToAudioMidi(mVis);
    noteOff(mAudio);
  });

  // ---------- Lighting (uses *visual* pitch for key indices) ----------
  function lightMidiVisual(realMidi) {
    const idx = indexFromMidiVisual(realMidi);
    if (typeof kb.keysLight === 'function') kb.keysLight([idx]);
  }
  function dimMidiVisual(realMidi) {
    const idx = indexFromMidiVisual(realMidi);
    if (typeof kb.keysDim === 'function') kb.keysDim([idx]);
  }

  // ---------- Piano roll (draws *real* pitches; not transposed) ----------
  function sizeRollToClient() {
    const W = rollCv.clientWidth, H = rollCv.clientHeight;
    if (rollCv.width !== W || rollCv.height !== H) {
      rollCv.width = W; rollCv.height = H;
    }
  }
  function drawRoll() {
    sizeRollToClient();
    const pad = 6, W = rollCv.width, H = rollCv.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#f3f5fb'; ctx.fillRect(0, 0, W, H);
    if (!notes.length || total <= 0) return;
    const secToX = (s) => pad + (W - 2 * pad) * (s / total);
    const keyH = (H - 2 * pad) / TOTAL_KEYS;
    ctx.fillStyle = '#2f6fab';
    for (const n of notes) {
      const i = toIdx(n.p); if (i < 0 || i >= TOTAL_KEYS) continue;
      const x = secToX(n.s), w = Math.max(2, secToX(n.e) - secToX(n.s)), y = H - pad - (i + 1) * keyH;
      ctx.fillRect(x, y, w, keyH - 1);
    }
  }
  function drawPlayhead(t) {
    if (total <= 0) return; const pad = 6, W = rollCv.width, H = rollCv.height;
    const x = pad + (W - 2 * pad) * (Math.min(t, total) / total);
    ctx.strokeStyle = '#e74c3c'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // ---------- Scheduling (sound + lights) ----------
  function clearScheduledAudio() {
    if (!audio.ctx) return;
    for (const n of scheduled) {
      try {
        const t = audio.ctx.currentTime;
        n.gain.gain.cancelScheduledValues(t);
        n.gain.gain.setTargetAtTime(0.0001, t, 0.02);
        n.osc.stop(t + 0.05);
      } catch {}
    }
    scheduled.length = 0;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  }
  function scheduleNotesAtTempo() {
    const scale = scoreBPM / Number(bpm.value); // scoreSec → realSec
    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;
    for (const n of notes) {
      const s = n.s * scale;
      const d = (n.e - n.s) * scale;
      if (d <= 0) continue;

      // Audio plays *real* pitch n.p
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push({ ...v, offAt: startBase + s + d + 0.03 });

      // Lights use *visual* index for the *real* pitch
      const onDelaySec  = Math.max(0, (startBase + s)     - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + s + d) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidiVisual(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidiVisual(n.p),   offDelaySec * 1000));
      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${bpm.value} (score BPM=${scoreBPM})`);

    const passDur = total * scale;
    if (loopCb?.checked) {
      loopTimer = setTimeout(() => {
        t0 = 0; startedAt = performance.now() / 1000;
        clearScheduledAudio(); clearLightingTimers(true);
        scheduleNotesAtTempo();
      }, Math.max(0, (passDur + 0.05) * 1000));
    }
  }

  // ---------- Transport ----------
  const nowTime = () =>
    !playing ? t0 : t0 + (performance.now() / 1000 - startedAt) * (Number(bpm.value) / scoreBPM);

  bpm?.addEventListener('input', e => {
    bpmVal.textContent = e.target.value;
    if (playing) { stop(); start(); } // re-sync schedules
  });
  if (bpmVal) bpmVal.textContent = bpm?.value || '100';

  function tick() {
    const t = nowTime();
    if (!loopCb?.checked && total > 0 && t >= total) {
      drawRoll(); drawPlayhead(total); playing = false; return;
    }
    if (loopCb?.checked && total > 0 && t >= total) {
      t0 = 0; startedAt = performance.now() / 1000;
    }
    drawRoll();
    drawPlayhead(Math.min(t, total));
    rafId = requestAnimationFrame(tick);
  }
  function start() {
    if (!notes.length || playing) { if (!notes.length) log('⚠️ Keine Noten geladen.'); return; }
    audioInit(); audio.ctx.resume?.().then(() => log('Play resume state=' + audio.ctx.state));
    playing = true; startedAt = performance.now() / 1000; t0 = 0;
    clearScheduledAudio(); clearLightingTimers(true);
    scheduleNotesAtTempo();
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    playing = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; t0 = 0;
    clearScheduledAudio(); clearLightingTimers(true);
    allNotesOff(); drawRoll();
  }
  playBtn?.addEventListener('click', start);
  stopBtn?.addEventListener('click', stop);

  // ---------- Ranging helpers ----------
  function applyKeyboardRange(lowMidi, highMidi, strict = true) {
    lowMidi = Math.max(LOWEST_EMITTABLE_MIDI, Math.min(127, lowMidi));
    highMidi = Math.max(lowMidi, Math.min(127, highMidi));

    const fitLow = Math.floor(lowMidi / 12) * 12;
    const fitHigh = Math.ceil((highMidi + 1) / 12) * 12 - 1;
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil((fitHigh - fitLow + 1) / 12));

    LOWEST_PITCH = fitLow;
    TOTAL_KEYS = neededOcts * 12;
    kb.setAttribute('octaves', String(neededOcts));

    // Align component so that index 0 (emits MIDI 24) maps visually to LOWEST_PITCH - transposeVis
    // We keep sound correct via visualToAudioMidi.
    const leftmostIndex = Math.max(0, (LOWEST_PITCH - transposeVis) - MIDI_BASE_FOR_LAYOUT);
    setLeftmostIndex(leftmostIndex);

    kb.offsetWidth; // layout pass
    const finalHigh = LOWEST_PITCH + TOTAL_KEYS - 1;
    log(`🎛 Range${strict ? ' (strict)' : ''}: MIDI ${LOWEST_PITCH}..${finalHigh} | Oktaven: ${neededOcts} | leftmostKey=${leftmostIndex}`);
  }

  function autoFitKeyboard(noteArray) {
    if (!noteArray.length) return;

    // If strict range override is active and not forcing fit, respect it
    const forceFit = params.get('fit') === '1';
    if (userRangeOverride && userRangeOverride.strict && !forceFit) {
      applyKeyboardRange(userRangeOverride.low, userRangeOverride.high, true);
      return;
    }

    const lowNote = noteArray.reduce((m, n) => Math.min(m, n.p), 127);
    const highNote = noteArray.reduce((m, n) => Math.max(m, n.p), 0);

    let low = Math.max(LOWEST_EMITTABLE_MIDI, lowNote - PAD_SEMITONES);
    let high = Math.min(127, highNote + PAD_SEMITONES);

    if (userRangeOverride && !userRangeOverride.strict) {
      low = Math.min(low, userRangeOverride.low);
      high = Math.max(high, userRangeOverride.high);
    }
    applyKeyboardRange(low, high, !forceFit && !!userRangeOverride?.strict);
  }

  // ---------- MusicXML tempo detection ----------
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
        const base = { 'whole':4, 'half':2, 'quarter':1, 'eighth':0.5, '8th':0.5, '16th':0.25, '32nd':0.125, '64th':0.0625 }[unit] ?? 1;
        const dots = met.querySelectorAll('beat-unit-dot').length;
        let dotFactor = 1; for (let k = 1; k <= dots; k++) dotFactor += Math.pow(0.5, k);
        const beatInQuarters = base * dotFactor;
        const qpm = perMin * beatInQuarters;
        return Math.max(1, Math.round(qpm));
      }
    }
    return null;
  }

  // ---------- OSMD render + fit-to-width ----------
  let osmd = null;
  window.osmdInstance = null;
  let scoreResizeObs = null;
  let _fitTick = null;

  async function fitScoreToWidth() {
    if (!window.osmdInstance || !scoreContainer) return;
    const os = window.osmdInstance;

    // If explicit zoom was set, honor & bail
    if (scoreZoomOverride != null) {
      if (os.zoom !== scoreZoomOverride) {
        os.zoom = scoreZoomOverride;
        await os.render();
      }
      return;
    }

    // Two pass fit: render at 1.0, measure, re-render at scale
    if (os.zoom !== 1) {
      os.zoom = 1;
      await os.render();
    }
    const svg = scoreContainer.querySelector('svg');
    if (!svg) return;

    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
    let svgWidth = 0;
    if (vb && vb.width) svgWidth = vb.width;
    if (!svgWidth) {
      svgWidth = (typeof svg.getBBox === 'function' ? svg.getBBox().width : 0) || svg.clientWidth || 0;
    }
    if (!svgWidth) return;
    const containerWidth = scoreContainer.clientWidth;
    if (!containerWidth) return;

    const scale = containerWidth / svgWidth;
    if (Math.abs(scale - 1) < 0.01) return;

    os.zoom = Math.max(0.2, Math.min(4, scale));
    await os.render();
  }

  function ensureScoreResizeObserver() {
    if (!scoreFitActive) return;
    if (scoreResizeObs) return;
    scoreResizeObs = new ResizeObserver(() => {
      clearTimeout(_fitTick);
      _fitTick = setTimeout(() => fitScoreToWidth(), 60);
    });
    scoreResizeObs.observe(scoreContainer);
  }

  async function renderXMLinOSMD(fileOrText, isText = false) {
    if (!window.opensheetmusicdisplay) throw new Error('OSMD Script nicht geladen.');
    if (!osmd) {
      osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd', { drawingParameters: 'compact' });
      window.osmdInstance = osmd;
    }
    if (isText) {
      await osmd.load(fileOrText);
    } else {
      const name = fileOrText.name?.toLowerCase?.() || '';
      const ext = name.split('.').pop();
      if (ext === 'mxl') {
        await osmd.load(await fileOrText.arrayBuffer());
      } else {
        await osmd.load(await fileOrText.text());
      }
    }
    await osmd.render();
    log('MusicXML gerendert.');

    if (scoreFitActive || scoreZoomOverride != null) {
      await fitScoreToWidth();
      ensureScoreResizeObserver();
    }
  }

  // ---------- MusicXML -> notes extraction ----------
  async function extractNotesFromXMLText(text, bpmForTiming) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');

    const stepToSemitone = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
    const secPerQuarterAtBase = 60 / (bpmForTiming || 100);

    const parts = Array.from(xml.querySelectorAll('score-partwise > part, part'));
    const collected = [];

    for (const part of parts) {
      const voiceTimes = new Map();
      const tieOpen = new Map();
      let divisions = Number(part.querySelector('attributes > divisions')?.textContent || xml.querySelector('divisions')?.textContent || 1);
      const measures = Array.from(part.querySelectorAll(':scope > measure'));

      for (const m of measures) {
        const dHere = m.querySelector('attributes > divisions');
        if (dHere) divisions = Number(dHere.textContent) || divisions;

        const events = Array.from(m.querySelectorAll(':scope > note, :scope > backup, :scope > forward'));
        for (const ev of events) {
          if (ev.tagName === 'backup') {
            const durQ = Number(ev.querySelector('duration')?.textContent || 0) / divisions;
            const durSec = durQ * secPerQuarterAtBase;
            for (const [v, t] of voiceTimes.entries()) voiceTimes.set(v, Math.max(0, t - durSec));
            continue;
          }
          if (ev.tagName === 'forward') {
            const durQ = Number(ev.querySelector('duration')?.textContent || 0) / divisions;
            const durSec = durQ * secPerQuarterAtBase;
            for (const [v, t] of voiceTimes.entries()) voiceTimes.set(v, t + durSec);
            continue;
          }

          const isRest = ev.querySelector('rest') !== null;
          const isChordFollower = ev.querySelector('chord') !== null;
          const voiceId = ev.querySelector('voice')?.textContent?.trim() || '1';
          const curTime = voiceTimes.get(voiceId) ?? 0;

          let durDivs = ev.querySelector('duration') ? Number(ev.querySelector('duration').textContent) : NaN;
          if (!Number.isFinite(durDivs) && isChordFollower) durDivs = 0;
          const durQ = (durDivs / divisions) || 0;
          const durSec = durQ * secPerQuarterAtBase;

          if (!isRest) {
            const step = ev.querySelector('step')?.textContent;
            const alter = Number(ev.querySelector('alter')?.textContent || 0);
            const octave = Number(ev.querySelector('octave')?.textContent);
            if (step && Number.isFinite(octave)) {
              const pitchMidi = 12 * (octave + 1) + stepToSemitone[step] + alter;
              const startSec = curTime, endSec = startSec + durSec;

              const tieTags = Array.from(ev.querySelectorAll('tie'));
              const hasTieStart = tieTags.some(t => t.getAttribute('type') === 'start');
              const hasTieStop  = tieTags.some(t => t.getAttribute('type') === 'stop');
              const tieKey = voiceId + '|' + pitchMidi;

              if (hasTieStop && tieOpen.has(tieKey)) {
                const idx = tieOpen.get(tieKey);
                if (idx != null && collected[idx]) collected[idx].e = Math.max(collected[idx].e, endSec);
              }
              if (!hasTieStop || hasTieStart) {
                if (endSec > startSec) {
                  const newIdx = collected.push({ p: pitchMidi, s: startSec, e: endSec, _voice: voiceId }) - 1;
                  if (hasTieStart) tieOpen.set(tieKey, newIdx); else tieOpen.delete(tieKey);
                }
              }
              if (hasTieStop && !hasTieStart) tieOpen.delete(tieKey);
            }
          }
          if (!isChordFollower) voiceTimes.set(voiceId, curTime + durSec);
        }
      }
    }

    notes = collected.filter(n => n.e > n.s).map(({ p, s, e }) => ({ p, s, e })).sort((a, b) => a.s - b.s);
    total = notes.length ? Math.max(...notes.map(n => n.e)) : 0;
    t0 = 0;

    if (!notes.length) {
      log('⚠️ XML-Parser fand keine Noten. Enthält die Datei echte Noten?');
    } else {
      log(`XML-Parser: ${notes.length} Noten, Dauer: ${total.toFixed(2)}s (bei ${bpmForTiming} BPM)`);
      autoFitKeyboard(notes);
    }
  }

  // ---------- File input wiring ----------
  xmlInput?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop();
    try {
      let xmlText = null;
      if (ext === 'mxl') {
        await renderXMLinOSMD(f);
        log('ℹ️ Für Playback/Tempo ist .xml/.musicxml ideal (Text). .mxl wird angezeigt, aber nicht geparst.');
      } else {
        xmlText = await f.text();
        const detected = await detectTempoFromXMLText(xmlText);
        if (detected && detected > 0) {
          scoreBPM = detected; bpm.value = String(detected); bpmVal.textContent = String(detected);
          log('⏱ Tempo aus MusicXML:', detected, 'BPM');
        } else {
          log('⏱ Kein Tempo gefunden – Standard bleibt', scoreBPM, 'BPM');
        }
        await renderXMLinOSMD(xmlText, true);
        await extractNotesFromXMLText(xmlText, scoreBPM);
      }
      drawRoll();
      const has = notes.length > 0;
      playBtn.disabled = stopBtn.disabled = !has;
      log('MusicXML geladen:', f.name, `| Noten: ${notes.length} | Dauer: ${total.toFixed(2)}s`);
    } catch (err) {
      console.error(err);
      log('XML/OSMD Fehler:', err?.message || err);
      alert('Konnte MusicXML nicht laden/analysieren.');
    }
  });

  // ---------- URL param loader ----------
  function parseNoteNameToMidi(s) {
    if (!s) return null;
    s = String(s).trim();
    const m = s.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return null;
    const idx = { c:0,'c#':1,'db':1,d:2,'d#':3,'eb':3,e:4,f:5,'f#':6,'gb':6,g:7,'g#':8,'ab':8,a:9,'a#':10,'bb':10,b:11 };
    const name = (m[1] + m[2]).toLowerCase();
    const oct = parseInt(m[3], 10);
    if (!(name in idx)) return null;
    return 12 * (oct + 1) + idx[name];
  }
  function parseMidiOrNote(val) {
    if (val == null) return null;
    if (/^-?\d+$/.test(String(val))) {
      const n = Number(val);
      return n >= 0 && n <= 127 ? n : null;
    }
    return parseNoteNameToMidi(val);
  }

  async function fetchAsFile(url, suggestedName) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const name = suggestedName || (url.split('/').pop() || 'file');
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  }

  async function loadFromURLParam() {
    const xmlUrl  = params.get('xml');
    const bpmUrl  = params.get('bpm');
    const autoplay = params.get('autoplay');
    const forceFit = params.get('fit') === '1';

    // Optional range
    const lowMidiParam  = parseMidiOrNote(params.get('low'));
    const highMidiParam = parseMidiOrNote(params.get('high'));
    const rangeStrict = params.get('rangeStrict') !== '0'; // default strict

    if (lowMidiParam != null && highMidiParam != null) {
      const lo = Math.min(lowMidiParam, highMidiParam);
      const hi = Math.max(lowMidiParam, highMidiParam);
      userRangeOverride = { low: lo, high: hi, strict: rangeStrict };
      applyKeyboardRange(lo, hi, rangeStrict);
    } else if (lowMidiParam != null || highMidiParam != null) {
      log('⚠️ Bitte sowohl "low" als auch "high" setzen (z.B. low=C3&high=G5).');
    }

    if (bpmUrl && Number(bpmUrl) > 0) {
      scoreBPM = Number(bpmUrl);
      bpm.value = String(scoreBPM);
      bpmVal.textContent = String(scoreBPM);
      log('⏱ Tempo via URL:', scoreBPM, 'BPM');
    }

    try {
      if (xmlUrl) {
        log('🌐 Lade XML von URL:', xmlUrl);
        const file = await fetchAsFile(xmlUrl);
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext === 'mxl') {
          await renderXMLinOSMD(file);
          log('ℹ️ .mxl via URL: Score sichtbar. Für Playback bitte .xml/.musicxml verwenden.');
        } else {
          const text = await file.text();
          const detected = await detectTempoFromXMLText(text);
          if (detected && detected > 0 && !bpmUrl) {
            scoreBPM = detected; bpm.value = String(detected); bpmVal.textContent = String(detected);
            log('⏱ Tempo aus MusicXML:', detected, 'BPM');
          }
          await renderXMLinOSMD(text, true);
          await extractNotesFromXMLText(text, scoreBPM);
        }
        drawRoll();
        const has = notes.length > 0;
        playBtn.disabled = stopBtn.disabled = !has;
        if (has && (autoplay || forceFit)) {
          if (forceFit) {
            userRangeOverride = null;
            autoFitKeyboard(notes);
            drawRoll();
            log('🧩 Auto-fit erzwungen (fit=1).');
          }
          start();
        }
        return;
      }
    } catch (err) {
      console.error(err);
      log('URL-Load Fehler:', err?.message || err);
      alert('Konnte Datei von URL nicht laden.');
    }
  }

  // ---------- Init ----------
  (async function init() {
    await ready;

    // Loop default already applied; show current BPM label
    if (bpmVal && bpm) bpmVal.textContent = bpm.value;

    // Debug line
    setTimeout(() => {
      log('HTTP-Served?', location.protocol.startsWith('http') ? 'ja' : 'nein (bitte lokalen Server nutzen)');
      log('Magenta geladen?', !!window.mm,
          '| midiToNoteSequence:', typeof window.mm?.midiToNoteSequence,
          '| midiToSequenceProto:', typeof window.mm?.midiToSequenceProto);
    }, 0);

    // Start URL loader
    loadFromURLParam();

    // Resize roll to fill width on layout changes
    const rollObs = new ResizeObserver(() => { drawRoll(); drawPlayhead(Math.min(nowTime(), total)); });
    rollObs.observe(rollCv);
  })();
})();
