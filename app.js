/* app.js – Visualizer (MusicXML) with keyboard-only transpose
   – Flags:
     xml=URL                → load MusicXML by URL (prefer .xml/.musicxml)
     title=...              → set title text (emoji stays)
     bpm=NUMBER             → set starting BPM
     loop=1|0               → loop on/off (default off)
     autoplay=1|0           → try to auto-start after load (user gesture required in many browsers)
     hideLog=1              → hide the status log block
     transposeVis=INT       → visual-only transpose in semitones (keyboard lights), sound/score stay true
     low=NOTE|MIDI          → keyboard lower bound (e.g., C2 or 36)
     high=NOTE|MIDI         → keyboard upper bound (e.g., G5 or 79)
     rangeStrict=1|0        → if 1, keep keyboard range fixed even after loading (default 1)
     fit=1                  → force-fit keyboard to notes (overrides strict if provided)
     osmdFit=1              → try to fit score to container width (auto-resize)
*/

(function () {
  // ---------- Utilities ----------
  const $ = (id) => document.getElementById(id);
  const logEl = $("status");
  const log = (...a) => {
    if (!logEl) return;
    logEl.textContent += a.join(" ") + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };
  const params = new URLSearchParams(location.search);

  // Title
  (function applyTitleFromURL() {
    const t = params.get("title");
    if (t) {
      const titleText = $("titleText") || $("titleLine");
      if (titleText) {
        // Keep the 🎹 emoji as in your HTML
        if (titleText.id === "titleText") titleText.textContent = t;
        else titleText.innerHTML = "🎹 " + t;
      }
    }
  })();

  // Hide status log if requested
  if (params.get('hideLog') === '1') {
    const logEl = document.getElementById('status');
    const logHdr = document.querySelector('h3'); // the "Status" header
    if (logEl) logEl.style.display = 'none';
    if (logHdr) logHdr.style.display = 'none';
  }

  // Loop default?
  const loopDefault = params.get("loop") === "1";
  // Visual transpose (keyboard lights only)
  const transposeVis = parseInt(params.get("transposeVis") || "0", 10) || 0;

  // URL helpers
  const NOTE_INDEX = {
    c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5,
    "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11
  };
  function parseNoteNameToMidi(s) {
    if (!s) return null;
    s = String(s).trim();
    const m = s.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return null;
    const name = (m[1] + m[2]).toLowerCase();
    const oct = parseInt(m[3], 10);
    if (!(name in NOTE_INDEX)) return null;
    return 12 * (oct + 1) + NOTE_INDEX[name];
  }
  function parseMidiOrNote(val) {
    if (val == null) return null;
    if (/^-?\d+$/.test(String(val))) {
      const n = Number(val);
      return n >= 0 && n <= 127 ? n : null;
    }
    return parseNoteNameToMidi(val);
  }

  // ---------- Elements ----------
  const playBtn = $("play");
  const stopBtn = $("stop");
  const loopCb = $("loop");
  const bpm = $("bpm");
  const bpmVal = $("bpmVal");
  const testBtn = $("testTone");
  const panicBtn = $("panic");
  const xmlInput = $("xmlFile");
  const kb = $("kb");
  const rollCv = $("roll");
  const ctx = rollCv.getContext("2d");
  const osmdHost = $("osmd");

  if (loopCb) loopCb.checked = loopDefault;

  // ---------- Config ----------
  let scoreBPM = Math.max(1, parseInt(params.get("bpm") || "100", 10) || 100);
  if (bpm) bpm.value = String(scoreBPM);
  if (bpmVal) bpmVal.textContent = String(scoreBPM);

  const MIN_OCTAVES = 2;
  const PAD_SEMITONES = 1;
  const LOWEST_EMITTABLE_MIDI = 24; // all-around-keyboard emits MIDI = 24 + index
  const MIDI_BASE_FOR_LAYOUT = 24;

  // ---------- State ----------
  let notes = []; // {p: midi, s: sec, e: sec} in score seconds (at scoreBPM reference)
  let total = 0;
  let playing = false, startedAt = 0, t0 = 0, rafId = null;
  let scheduled = [], loopTimer = null, lightTimers = [];

  // ---------- OSMD ----------
  let osmd = null;
  const wantOsmdFit = params.get("osmdFit") === "1";

  // ---------- Keyboard / Roll independent windows ----------
  // Keyboard (visual) — affected by transposeVis and URL 'low/high'
  let KEY_LOWEST = 60;
  let KEY_TOTAL = 12 * (parseInt(kb?.getAttribute("octaves")) || MIN_OCTAVES);

  // Roll (real) — true pitches, never transposed visually
  let ROLL_LOWEST = 60;
  let ROLL_TOTAL = KEY_TOTAL;

  const getLeftmostIndex = () => Number(kb?.getAttribute("leftmostKey") || 48);
  const setLeftmostIndex = (idx) => kb?.setAttribute("leftmostKey", String(Math.max(0, Math.round(idx))));

  // Visual mapping helpers
  function visualToAudioMidi(midiVis) { return midiVis - transposeVis; }   // lights → sound
  function audioToVisualMidi(midiReal) { return midiReal + transposeVis; } // sound → lights
  function indexFromMidiVisual(midiReal) {
    const midiVis = audioToVisualMidi(midiReal);
    return getLeftmostIndex() + (midiVis - KEY_LOWEST);
  }

  // ---------- Audio ----------
  const audio = { ctx: null, master: null, voices: new Map() };
  function audioInit() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.15;
    audio.master.connect(audio.ctx.destination);
    log("🔊 AudioContext created. state=" + audio.ctx.state);
  }
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function mkVoice(freq, vel = 0.25) {
    const osc = audio.ctx.createOscillator();
    const gain = audio.ctx.createGain();
    osc.type = "sawtooth";
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

  // Test tone & panic
  testBtn?.addEventListener("click", () => {
    audioInit();
    audio.ctx.resume?.().then(() => {
      log("Test resume state=" + audio.ctx.state);
      const v = mkVoice(440, 0.2);
      v.osc.start();
      v.osc.stop(audio.ctx.currentTime + 0.3);
    }).catch(e => log("Test resume err: " + e));
  });
  function clearLightingTimers(andDim = false) {
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim && typeof kb?.keysDim === "function") {
      const L = getLeftmostIndex();
      const allIdx = Array.from({ length: KEY_TOTAL }, (_, i) => L + i);
      kb.keysDim(allIdx);
    }
  }
  function allNotesOff() {
    for (const n of scheduled) { try { n.osc.stop(); } catch { } }
    scheduled.length = 0;
    for (const [, v] of audio.voices) { try { v.osc.stop(); } catch { } }
    audio.voices.clear();
    clearLightingTimers(true);
  }
  panicBtn?.addEventListener("click", () => { allNotesOff(); log("⏹ Panic: all voices stopped, lights cleared."); });

  // Manual key → sound (maps from emitted MIDI or index)
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === "number" && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === "number" && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = m => Number.isInteger(m) && m >= 0 && m <= 127;
  if (kb) {
    kb.addEventListener("noteon", e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener("noteOff", e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener("noteoff", e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener("keypress", e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener("keyrelease", e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
  }

  // ---------- Lighting helpers (visual-only mapping) ----------
  function lightMidi(realMidi) {
    const idx = indexFromMidiVisual(realMidi);
    if (typeof kb?.keysLight === "function") kb.keysLight([idx]);
  }
  function dimMidi(realMidi) {
    const idx = indexFromMidiVisual(realMidi);
    if (typeof kb?.keysDim === "function") kb.keysDim([idx]);
  }

  // ---------- Piano roll (true pitches) ----------
  function drawRoll() {
    const pad = 6, W = rollCv.clientWidth, H = rollCv.clientHeight;
    if (rollCv.width !== W || rollCv.height !== H) { rollCv.width = W; rollCv.height = H; }
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#f3f5fb"; ctx.fillRect(0, 0, W, H);
    if (!notes.length || total <= 0) return;
    const toIdxRoll = p => p - ROLL_LOWEST;
    const secToX = s => pad + (W - 2 * pad) * (s / total);
    const keyH = (H - 2 * pad) / ROLL_TOTAL;
    ctx.fillStyle = "#2f6fab";
    for (const n of notes) {
      const i = toIdxRoll(n.p);
      if (i < 0 || i >= ROLL_TOTAL) continue;
      const x = secToX(n.s), w = Math.max(2, secToX(n.e) - secToX(n.s)), y = H - pad - (i + 1) * keyH;
      ctx.fillRect(x, y, w, keyH - 1);
    }
  }
  function drawPlayhead(t) {
    if (total <= 0) return; const pad = 6;
    const x = pad + (rollCv.width - 2 * pad) * (Math.min(t, total) / total);
    ctx.strokeStyle = "#e74c3c"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rollCv.height); ctx.stroke();
  }

  // ---------- Apply windows ----------
  function applyKeyboardRange(lowMidi, highMidi, strict = true) {
    lowMidi = Math.max(LOWEST_EMITTABLE_MIDI, Math.min(127, lowMidi));
    highMidi = Math.max(lowMidi, Math.min(127, highMidi));

    const fitLow = Math.floor(lowMidi / 12) * 12;
    const fitHigh = Math.ceil((highMidi + 1) / 12) * 12 - 1;
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil((fitHigh - fitLow + 1) / 12));

    KEY_LOWEST = fitLow;
    KEY_TOTAL = neededOcts * 12;

    kb?.setAttribute("octaves", String(neededOcts));
    const leftmostIndex = Math.max(0, KEY_LOWEST - MIDI_BASE_FOR_LAYOUT);
    setLeftmostIndex(leftmostIndex);

    kb?.offsetWidth; // force layout
    const finalHigh = KEY_LOWEST + KEY_TOTAL - 1;
    log(`🎛 Keyboard range ${strict ? "(strict) " : ""}MIDI ${KEY_LOWEST}..${finalHigh} | Oktaven: ${neededOcts} | leftmostKey=${leftmostIndex}`);
  }
  function applyRollRange(lowMidi, highMidi) {
    lowMidi = Math.max(0, Math.min(127, lowMidi));
    highMidi = Math.max(lowMidi, Math.min(127, highMidi));

    const fitLow = Math.floor(lowMidi / 12) * 12;
    const fitHigh = Math.ceil((highMidi + 1) / 12) * 12 - 1;
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil((fitHigh - fitLow + 1) / 12));

    ROLL_LOWEST = fitLow;
    ROLL_TOTAL = neededOcts * 12;

    log(`📏 Roll range set to MIDI ${ROLL_LOWEST}..${ROLL_LOWEST + ROLL_TOTAL - 1} (${neededOcts} oct)`);
  }

  // URL range override (keyboard only)
  let userRangeOverride = null; // {low, high, strict}
  (function applyRangeFromURL() {
    const lowMidiParam = parseMidiOrNote(params.get("low"));
    const highMidiParam = parseMidiOrNote(params.get("high"));
    const rangeStrict = params.get("rangeStrict") !== "0"; // default strict
    if (lowMidiParam != null && highMidiParam != null) {
      const lo = Math.min(lowMidiParam, highMidiParam);
      const hi = Math.max(lowMidiParam, highMidiParam);
      userRangeOverride = { low: lo, high: hi, strict: rangeStrict };
      // Apply to *keyboard* (visual)
      applyKeyboardRange(lo, hi, rangeStrict);
    } else if (lowMidiParam != null || highMidiParam != null) {
      log('⚠️ Bitte sowohl "low" als auch "high" setzen (z.B. low=C2&high=G5).');
    }
  })();

  // ---------- Auto-fit both windows ----------
  function autoFitKeyboard(noteArray) {
    const forceFit = params.get("fit") === "1";
    if (!noteArray.length) return;

    const lowReal = noteArray.reduce((m, n) => Math.min(m, n.p), 127);
    const highReal = noteArray.reduce((m, n) => Math.max(m, n.p), 0);

    // Roll always fits REAL pitches (no transpose)
    applyRollRange(lowReal - PAD_SEMITONES, highReal + PAD_SEMITONES);

    // Keyboard fits VISUAL pitches (real + transposeVis), unless strict override
    if (userRangeOverride && userRangeOverride.strict && !forceFit) {
      applyKeyboardRange(userRangeOverride.low, userRangeOverride.high, true);
    } else {
      const lowVis = lowReal + transposeVis;
      const highVis = highReal + transposeVis;

      let lo = Math.max(LOWEST_EMITTABLE_MIDI, lowVis - PAD_SEMITONES);
      let hi = Math.min(127, highVis + PAD_SEMITONES);

      if (userRangeOverride && !userRangeOverride.strict) {
        lo = Math.min(lo, userRangeOverride.low);
        hi = Math.max(hi, userRangeOverride.high);
      }
      applyKeyboardRange(lo, hi, !forceFit && !!userRangeOverride?.strict);
    }
  }

  // ---------- Tempo detection (MusicXML) ----------
  async function detectTempoFromXMLText(text) {
    const xml = new DOMParser().parseFromString(text, "application/xml");

    // <sound tempo="...">
    const soundWithTempo = xml.querySelector("sound[tempo]");
    const tempoAttr = Number(soundWithTempo?.getAttribute("tempo"));
    if (Number.isFinite(tempoAttr) && tempoAttr > 0) return Math.round(tempoAttr);

    // <direction-type><metronome>
    const met = xml.querySelector("direction-type > metronome");
    if (met) {
      const perMin = Number(met.querySelector("per-minute")?.textContent);
      const unit = met.querySelector("beat-unit")?.textContent?.trim()?.toLowerCase();
      if (Number.isFinite(perMin) && perMin > 0 && unit) {
        const base = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "8th": 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625 }[unit] ?? 1;
        const dots = met.querySelectorAll("beat-unit-dot").length;
        let dotFactor = 1; for (let k = 1; k <= dots; k++) dotFactor += Math.pow(0.5, k);
        const beatInQuarters = base * dotFactor;
        const qpm = perMin * beatInQuarters;
        return Math.max(1, Math.round(qpm));
      }
    }
    return null;
  }

  // ---------- MusicXML → notes ----------
  async function renderXMLinOSMD(fileOrText, isText = false) {
    if (!window.opensheetmusicdisplay) throw new Error("OSMD Script nicht geladen.");
    if (!osmd) {
      osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay("osmd", {
        drawingParameters: "compact",
        autoResize: params.get("osmdFit") === "1"
      });
    }
    if (isText) { await osmd.load(fileOrText); }
    else {
      const name = fileOrText.name?.toLowerCase?.() || "";
      const ext = name.split(".").pop();
      if (ext === "mxl") { await osmd.load(await fileOrText.arrayBuffer()); }
      else { await osmd.load(await fileOrText.text()); }
    }
    await osmd.render();

    if (wantOsmdFit) {
      // best effort: trigger a re-render on container resize to keep it snug
      const ro = new ResizeObserver(() => osmd.render());
      ro.observe(osmdHost);
    }
    log("MusicXML gerendert.");
  }

  async function extractNotesFromXMLText(text, bpmForTiming) {
    const xml = new DOMParser().parseFromString(text, "application/xml");

    const stepToSemitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const secPerQuarterAtBase = 60 / (bpmForTiming || 100);

    const parts = Array.from(xml.querySelectorAll("score-partwise > part, part"));
    const collected = [];

    for (const part of parts) {
      const voiceTimes = new Map();
      const tieOpen = new Map();
      let divisions = Number(part.querySelector("attributes > divisions")?.textContent || xml.querySelector("divisions")?.textContent || 1);
      const measures = Array.from(part.querySelectorAll(":scope > measure"));

      for (const m of measures) {
        const dHere = m.querySelector("attributes > divisions");
        if (dHere) divisions = Number(dHere.textContent) || divisions;

        const events = Array.from(m.querySelectorAll(":scope > note, :scope > backup, :scope > forward"));
        for (const ev of events) {
          if (ev.tagName === "backup") {
            const durQ = Number(ev.querySelector("duration")?.textContent || 0) / divisions;
            const durSec = durQ * secPerQuarterAtBase;
            for (const [v, t] of voiceTimes.entries()) voiceTimes.set(v, Math.max(0, t - durSec));
            continue;
          }
          if (ev.tagName === "forward") {
            const durQ = Number(ev.querySelector("duration")?.textContent || 0) / divisions;
            const durSec = durQ * secPerQuarterAtBase;
            for (const [v, t] of voiceTimes.entries()) voiceTimes.set(v, t + durSec);
            continue;
          }

          const isRest = ev.querySelector("rest") !== null;
          const isChordFollower = ev.querySelector("chord") !== null;
          const voiceId = ev.querySelector("voice")?.textContent?.trim() || "1";
          const curTime = voiceTimes.get(voiceId) ?? 0;

          let durDivs = ev.querySelector("duration") ? Number(ev.querySelector("duration").textContent) : NaN;
          if (!Number.isFinite(durDivs) && isChordFollower) durDivs = 0;
          const durQ = (durDivs / divisions) || 0;
          const durSec = durQ * secPerQuarterAtBase;

          if (!isRest) {
            const step = ev.querySelector("step")?.textContent;
            const alter = Number(ev.querySelector("alter")?.textContent || 0);
            const octave = Number(ev.querySelector("octave")?.textContent);
            if (step && Number.isFinite(octave)) {
              const pitchMidi = 12 * (octave + 1) + stepToSemitone[step] + alter;
              const startSec = curTime, endSec = startSec + durSec;

              const tieTags = Array.from(ev.querySelectorAll("tie"));
              const hasTieStart = tieTags.some(t => t.getAttribute("type") === "start");
              const hasTieStop = tieTags.some(t => t.getAttribute("type") === "stop");
              const tieKey = voiceId + "|" + pitchMidi;

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
      log("⚠️ XML-Parser fand keine Noten. Enthält die Datei echte Noten (nicht nur Pausen/Layouts)?");
    } else {
      log(`XML-Parser: ${notes.length} Noten, Dauer: ${total.toFixed(2)}s (bei ${bpmForTiming} BPM)`);
      autoFitKeyboard(notes);
    }
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

      // Audio (true pitches)
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push({ ...v, offAt: startBase + s + d + 0.03 });

      // Lights (visual mapping only)
      const onDelaySec = Math.max(0, (startBase + s) - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + s + d) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidi(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidi(n.p), offDelaySec * 1000));
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
  const nowTime = () => !playing ? t0 : t0 + (performance.now() / 1000 - startedAt) * (Number(bpm.value) / scoreBPM);
  bpm?.addEventListener("input", e => {
    bpmVal.textContent = e.target.value;
    if (playing) { stop(); start(); } // re-sync schedules
  });

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
    if (!notes.length || playing) { if (!notes.length) log("⚠️ Keine Noten geladen."); return; }
    audioInit(); audio.ctx.resume?.().then(() => log("Play resume state=" + audio.ctx.state));
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
  playBtn?.addEventListener("click", start);
  stopBtn?.addEventListener("click", stop);

  // ---------- File input wiring ----------
  xmlInput?.addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop();
    try {
      if (ext === "mxl") {
        await renderXMLinOSMD(f);
        log("ℹ️ Für Playback/Tempo ist .xml/.musicxml ideal (Text). .mxl wird angezeigt, aber nicht geparst.");
      } else {
        const xmlText = await f.text();
        const detected = await detectTempoFromXMLText(xmlText);
        if (detected && detected > 0 && !params.get("bpm")) {
          scoreBPM = detected; bpm.value = String(detected); bpmVal.textContent = String(detected);
          log("⏱ Tempo aus MusicXML:", detected, "BPM");
        }
        await renderXMLinOSMD(xmlText, true);
        await extractNotesFromXMLText(xmlText, scoreBPM);
      }
      drawRoll();
      const has = notes.length > 0;
      playBtn.disabled = stopBtn.disabled = !has;
      log("MusicXML geladen:", f.name, "| Noten:", notes.length, "| Dauer:", total.toFixed(2) + "s");
    } catch (err) {
      console.error(err);
      log("XML/OSMD Fehler:", err?.message || err);
      alert("Konnte MusicXML nicht laden/analysieren.");
    }
  });

  // ---------- URL loader ----------
  async function fetchAsFile(url, suggestedName) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const name = suggestedName || (url.split("/").pop() || "file");
    return new File([blob], name, { type: blob.type || "application/octet-stream" });
  }

  async function loadFromURLParam() {
    const xmlUrl = params.get("xml");
    const autoplay = params.get("autoplay") === "1";

    try {
      if (xmlUrl) {
        log("🌐 Lade XML von URL:", xmlUrl);
        const file = await fetchAsFile(xmlUrl);
        const ext = file.name.toLowerCase().split(".").pop();
        if (ext === "mxl") {
          await renderXMLinOSMD(file);
          log("ℹ️ .mxl per URL: Score sichtbar. Für Playback bitte .xml/.musicxml verwenden.");
        } else {
          const text = await file.text();
          const detected = await detectTempoFromXMLText(text);
          if (detected && detected > 0 && !params.get("bpm")) {
            scoreBPM = detected; bpm.value = String(detected); bpmVal.textContent = String(detected);
            log("⏱ Tempo aus MusicXML:", detected, "BPM");
          }
          await renderXMLinOSMD(text, true);
          await extractNotesFromXMLText(text, scoreBPM);
        }
        drawRoll();
        const has = notes.length > 0;
        playBtn.disabled = stopBtn.disabled = !has;
        if (has && autoplay) start(); // may still be blocked by gesture policy
      }
    } catch (err) {
      console.error(err);
      log("URL-Load Fehler:", err?.message || err);
      alert("Konnte Datei von URL nicht laden.");
    }
  }

  // ---------- Resize roll to card width ----------
  function fitRollToCard() {
    // The canvas itself is responsive via CSS width:100%; we just redraw on resize
    drawRoll();
  }
  const resizeObs = new ResizeObserver(() => fitRollToCard());
  const card = document.querySelector(".card");
  if (card) resizeObs.observe(card);

  // ---------- Boot ----------
  setTimeout(() => {
    log("HTTP-Served?", location.protocol.startsWith("http") ? "ja" : "nein (bitte lokalen Server nutzen)");
  }, 0);
  loadFromURLParam();
})();
