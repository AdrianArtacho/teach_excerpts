// app.js
(() => {
  // ---------- tiny helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const log = (...a) => {
    const el = $('#status');
    if (!el) return;
    el.textContent += a.join(' ') + '\n';
    el.scrollTop = el.scrollHeight;
  };
  const once = (fn) => { let done=false; return (...args)=>{ if(!done){ done=true; return fn(...args); } }; };
  const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
  const dpr = () => (window.devicePixelRatio || 1);

  // ---------- URL flags ----------
  const params = new URLSearchParams(location.search);
  // Title (keep emoji; only replace text)
  const titleTxt = params.get('title');
  if (titleTxt && $('#titleText')) $('#titleText').textContent = titleTxt;

  // Piano roll rendering mode:
  // - "fit"  : horizontally fit the WHOLE piece to the canvas width (default)
  // - "time" : use pixels-per-second; lets it scale with tempo/length (set via ?pps=120)
  const ROLL_MODE = (params.get('rollMode') || 'fit').toLowerCase(); // 'fit' | 'time'
  const PPS = clamp(parseInt(params.get('pps')||'120',10)||120, 10, 2000); // only used when rollMode=time
  const ROLL_HEIGHT = clamp(parseInt(params.get('rollHeight')||'200',10)||200, 80, 800);

  // Playback flags
  const AUTOPLAY = !!params.get('autoplay');
  const FORCE_FIT = params.get('fit') === '1'; // force auto-fit keyboard to notes after load
  const BPM_URL = params.get('bpm');

  // Range from URL (supports MIDI numbers or note names; clamps low to C1/24)
  const NOTE_INDEX = {c:0,'c#':1,'db':1,d:2,'d#':3,'eb':3,e:4,f:5,'f#':6,'gb':6,g:7,'g#':8,'ab':8,a:9,'a#':10,'bb':10,b:11};
  const parseNoteNameToMidi = (s) => {
    if (!s) return null;
    const m = String(s).trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return null;
    const name = (m[1]+m[2]).toLowerCase(), oct = parseInt(m[3],10);
    if (!(name in NOTE_INDEX)) return null;
    return 12 * (oct + 1) + NOTE_INDEX[name];
  };
  const parseMidiOrNote = (val) => {
    if (val == null) return null;
    if (/^-?\d+$/.test(String(val))) {
      const n = Number(val); return (n>=0 && n<=127) ? n : null;
    }
    return parseNoteNameToMidi(val);
  };

  // ---------- UI refs (use whatever the HTML provides; some may be absent) ----------
  const xmlInput = $('#xmlFile');     // may not exist (we support URL loading)
  const playBtn  = $('#play');
  const stopBtn  = $('#stop');
  const loopCb   = $('#loop');
  const bpm      = $('#bpm');
  const bpmVal   = $('#bpmVal');
  const kb       = $('#kb');
  const rollCv   = $('#roll');
  const osmdHost = $('#osmd');

  // Ensure canvas has the target CSS height (we’ll size its backing store for DPR)
  if (rollCv) rollCv.style.height = ROLL_HEIGHT + 'px';

  // Wait for custom element if present
  (async () => {
    if (window.customElements?.whenDefined && kb) {
      try { await customElements.whenDefined('all-around-keyboard'); } catch {}
    }
  })();

  // ---------- Global state ----------
  let scoreBPM = 100;          // from MusicXML / MIDI / URL
  const MIN_OCTAVES = 2;
  const PAD_SEMITONES = 1;
  const LOWEST_EMITTABLE_MIDI = 24; // component emits MIDI = 24 + index

  let LOWEST_PITCH = 60;
  let TOTAL_KEYS   = 12 * (parseInt(kb?.getAttribute('octaves')) || MIN_OCTAVES);
  const toIdx      = (p) => p - LOWEST_PITCH;

  const MIDI_BASE_FOR_LAYOUT = 24;
  const getLeftmostIndex = () => Number(kb?.getAttribute('leftmostKey') || 48);
  const setLeftmostIndex = (idx) => kb?.setAttribute?.('leftmostKey', String(Math.max(0, Math.round(idx))));
  const indexFromMidi   = (midi) => getLeftmostIndex() + (midi - LOWEST_PITCH);

  let notes   = [];   // {p,s,e}
  let total   = 0;
  let playing = false, startedAt=0, t0=0, rafId=null;
  let scheduled = [], loopTimer=null, lightTimers=[];

  // ---------- Audio (simple synth) ----------
  const audio = { ctx:null, master:null, voices:new Map() };
  function audioInit(){
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.15;
    audio.master.connect(audio.ctx.destination);
    log('🔊 AudioContext created. state=' + audio.ctx.state);
  }
  const midiToFreq = (m) => 440 * Math.pow(2,(m-69)/12);
  function mkVoice(freq, vel=0.25){
    const osc = audio.ctx.createOscillator();
    const gain = audio.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, audio.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vel), audio.ctx.currentTime + 0.01);
    osc.connect(gain).connect(audio.master);
    return {osc, gain};
  }
  function noteOn(midi, vel=0.8){
    if (!audio.ctx) audioInit();
    audio.ctx.resume?.();
    if (audio.voices.has(midi)) return;
    const v = mkVoice(midiToFreq(midi), vel);
    v.osc.start();
    audio.voices.set(midi, v);
  }
  function noteOff(midi){
    if (!audio.ctx) return;
    const v = audio.voices.get(midi);
    if (!v) return;
    const t = audio.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, 0.03);
    v.osc.stop(t + 0.08);
    setTimeout(()=>audio.voices.delete(midi), 120);
  }

  // Manual key → sound (works whether the element emits midi or index)
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = (m) => Number.isInteger(m) && m >= 0 && m <= 127;
  if (kb) {
    kb.addEventListener('noteon',    e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener('noteOff',   e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener('noteoff',   e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener('keypress',  e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener('keyrelease',e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
  }

  // ---------- Keyboard lighting ----------
  function lightMidi(m){ const idx=indexFromMidi(m); if (typeof kb?.keysLight==='function') kb.keysLight([idx]); }
  function dimMidi(m){   const idx=indexFromMidi(m); if (typeof kb?.keysDim  ==='function') kb.keysDim  ([idx]); }
  function clearLightingTimers(andDim=false){
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim && kb){
      const L = getLeftmostIndex();
      const allIdx = Array.from({length:TOTAL_KEYS},(_,i)=>L+i);
      if (typeof kb.keysDim==='function') kb.keysDim(allIdx);
    }
  }
  function allNotesOff(){
    for (const n of scheduled) { try { n.osc.stop(); } catch {} }
    scheduled.length = 0;
    for (const [m, v] of audio.voices) { try { v.osc.stop(); } catch {} }
    audio.voices.clear();
    clearLightingTimers(true);
  }

  // ---------- Piano roll (responsive) ----------
  // Strategy:
  // - We always render the complete sequence width-to-width when ROLL_MODE='fit'
  // - With ROLL_MODE='time', x = t * PPS (and the canvas width adapts to container)
  // - Canvas backing-store scales with devicePixelRatio for crisp lines on retina
  function sizeCanvasToDisplay(){
    if (!rollCv) return;
    const cssW = Math.floor(rollCv.clientWidth);      // CSS pixels
    const cssH = Math.floor(rollCv.clientHeight||ROLL_HEIGHT);
    const ratio = dpr();
    const needW = Math.max(1, Math.floor(cssW * ratio));
    const needH = Math.max(1, Math.floor(cssH * ratio));
    if (rollCv.width !== needW || rollCv.height !== needH) {
      rollCv.width  = needW;
      rollCv.height = needH;
    }
    const ctx = rollCv.getContext('2d');
    ctx.setTransform(ratio,0,0,ratio,0,0); // scale all drawing back to CSS pixels
  }

  function drawRoll(){
    if (!rollCv) return;
    sizeCanvasToDisplay();
    const ctx = rollCv.getContext('2d');
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight||ROLL_HEIGHT;

    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#f3f5fb';
    ctx.fillRect(0,0,W,H);

    if (!notes.length || total<=0) return;

    // Horizontal mapping
    let secToX;
    if (ROLL_MODE === 'time') {
      // fixed pixels-per-second
      secToX = s => pad + s * PPS;
      // If the content is narrower than the canvas, we still leave whitespace at right — by design.
      // If you prefer to extend the canvas width to fit content exactly, uncomment:
      // const contentW = pad + total * PPS + pad;
      // if (contentW > W) rollCv.style.width = contentW + 'px';
    } else {
      // fit: scale full piece across the available width
      secToX = s => pad + (W - 2*pad) * (s / total);
    }

    const keyH=(H-2*pad)/TOTAL_KEYS;
    ctx.fillStyle='#2f6fab';
    for(const n of notes){
      const i=toIdx(n.p); if(i<0||i>=TOTAL_KEYS) continue;
      const x=secToX(n.s), w=Math.max(2,secToX(n.e)-secToX(n.s)), y=H-pad-(i+1)*keyH;
      ctx.fillRect(x,y,w,keyH-1);
    }
  }

  function drawPlayhead(t){
    if (!rollCv || total<=0) return;
    sizeCanvasToDisplay();
    const ctx = rollCv.getContext('2d');
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight||ROLL_HEIGHT;

    let x;
    if (ROLL_MODE === 'time') {
      x = pad + Math.max(0, t) * PPS;
      // Cap the playhead to canvas width, so it does not run past the visible area.
      x = Math.min(x, W - pad);
    } else {
      x = pad + (W-2*pad) * (Math.min(t,total)/total);
    }

    ctx.strokeStyle='#e74c3c';
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
  }

  // Resize handling (makes the roll responsive inside embeds/iframes)
  const handleResize = once(() => {
    const ro = new ResizeObserver(() => {
      // Repaint on size changes
      drawRoll();
    });
    // Observe the canvas and its parent container for layout changes
    if (rollCv) {
      ro.observe(rollCv);
      if (rollCv.parentElement) ro.observe(rollCv.parentElement);
    }
    // Also observe the whole card if present
    const card = rollCv?.closest('.card');
    if (card) ro.observe(card);
    window.addEventListener('orientationchange', () => drawRoll(), { passive:true });
  });

  // ---------- Scheduling (sound + lights) ----------
  function clearScheduledAudio(){
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
  function scheduleNotesAtTempo(){
    const scale = scoreBPM / Number(bpm?.value || scoreBPM); // scoreSec → realSec
    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;
    for (const n of notes) {
      const s = n.s * scale;
      const d = (n.e - n.s) * scale;
      if (d <= 0) continue;

      // Audio
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push({ ...v, offAt: startBase + s + d + 0.03 });

      // Lights
      const onDelaySec  = Math.max(0, (startBase + s)     - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + s + d) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidi(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidi(n.p),   offDelaySec * 1000));
      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${bpm?.value || scoreBPM} (score BPM=${scoreBPM})`);

    const passDur = total * scale;
    if ($('#loop')?.checked) {
      loopTimer = setTimeout(() => {
        t0 = 0; startedAt = performance.now()/1000;
        clearScheduledAudio(); clearLightingTimers(true);
        scheduleNotesAtTempo();
      }, Math.max(0, (passDur + 0.05) * 1000));
    }
  }

  // ---------- Transport ----------
  const nowTime = () => {
    const curBPM = Number(bpm?.value || scoreBPM);
    return !playing ? t0 : t0 + (performance.now()/1000 - startedAt) * (curBPM/scoreBPM);
  };

  function tick(){
    const t=nowTime();
    if(!$('#loop')?.checked && total>0 && t>=total){
      drawRoll(); drawPlayhead(total); playing=false; return;
    }
    if($('#loop')?.checked && total>0 && t>=total){
      t0=0; startedAt=performance.now()/1000;
    }
    drawRoll();
    drawPlayhead(Math.min(t,total));
    rafId=requestAnimationFrame(tick);
  }

  function start(){
    if(!notes.length||playing) { if(!notes.length) log('⚠️ Keine Noten geladen.'); return; }
    audioInit(); audio.ctx.resume?.().then(()=>log('Play resume state=' + audio.ctx.state));
    playing=true; startedAt=performance.now()/1000; t0=0;
    clearScheduledAudio(); clearLightingTimers(true);
    scheduleNotesAtTempo();
    rafId=requestAnimationFrame(tick);
  }
  function stop(){
    playing=false; if(rafId) cancelAnimationFrame(rafId); rafId=null; t0=0;
    clearScheduledAudio(); clearLightingTimers(true);
    allNotesOff(); drawRoll();
  }

  if (bpm && bpmVal) {
    bpm.addEventListener('input',e=>{
      bpmVal.textContent=e.target.value;
      if (playing) { stop(); start(); } // re-sync schedules and playhead mapping
    });
    bpmVal.textContent=bpm.value;
  }
  if (playBtn) playBtn.addEventListener('click', start);
  if (stopBtn) stopBtn.addEventListener('click', stop);
  $('#testTone')?.addEventListener('click', () => {
    audioInit();
    audio.ctx.resume?.().then(()=>{
      log('Test resume state=' + audio.ctx.state);
      const v = mkVoice(440, 0.2);
      v.osc.start();
      v.osc.stop(audio.ctx.currentTime + 0.3);
    }).catch(e=>log('Test resume err: '+e));
  });
  $('#panic')?.addEventListener('click', ()=>{ allNotesOff(); log('⏹ Panic: all voices stopped, lights cleared.'); });

  // ---------- Auto-fit keyboard (respects override) ----------
  let userRangeOverride = null; // {low, high, strict}
  function applyKeyboardRange(lowMidi, highMidi, strict=true){
    lowMidi  = Math.max(LOWEST_EMITTABLE_MIDI, Math.min(127, lowMidi));
    highMidi = Math.max(lowMidi, Math.min(127, highMidi));

    const fitLow  = Math.floor(lowMidi / 12) * 12;
    const fitHigh = Math.ceil((highMidi+1) / 12) * 12 - 1;
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil((fitHigh - fitLow + 1) / 12));

    LOWEST_PITCH = fitLow;
    TOTAL_KEYS   = neededOcts * 12;

    kb?.setAttribute?.('octaves', String(neededOcts));
    const leftmostIndex = Math.max(0, LOWEST_PITCH - MIDI_BASE_FOR_LAYOUT);
    setLeftmostIndex(leftmostIndex);

    kb?.offsetWidth; // force layout
    const finalHigh = LOWEST_PITCH + TOTAL_KEYS - 1;
    log(`🎛 Range ${strict?'(strict) ':''}gesetzt: MIDI ${LOWEST_PITCH}..${finalHigh} | Oktaven: ${neededOcts} | leftmostKey(index)=${leftmostIndex}`);
  }
  function autoFitKeyboard(noteArray){
    if (userRangeOverride && userRangeOverride.strict && !FORCE_FIT) return;
    if (!noteArray?.length) return;

    const lowNote  = noteArray.reduce((m, n) => Math.min(m, n.p), 127);
    const highNote = noteArray.reduce((m, n) => Math.max(m, n.p), 0);

    let low  = Math.max(LOWEST_EMITTABLE_MIDI, lowNote  - PAD_SEMITONES);
    let high = Math.min(127, highNote + PAD_SEMITONES);

    if (userRangeOverride && !userRangeOverride.strict) {
      low  = Math.min(low,  userRangeOverride.low);
      high = Math.max(high, userRangeOverride.high);
    }
    applyKeyboardRange(low, high, !(FORCE_FIT || (userRangeOverride && !userRangeOverride.strict)));
  }

  // ---------- OSMD + MusicXML parsing ----------
  let osmd=null;
  async function renderXMLinOSMD(fileOrText, isText=false){
    if(!window.opensheetmusicdisplay) throw new Error('OSMD Script nicht geladen.');
    if(!osmd) osmd=new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd',{drawingParameters:'compact'});
    if (isText) { await osmd.load(fileOrText); }
    else {
      const name = fileOrText.name?.toLowerCase?.() || '';
      const ext = name.split('.').pop();
      if(ext==='mxl'){ await osmd.load(await fileOrText.arrayBuffer()); }
      else { await osmd.load(await fileOrText.text()); }
    }
    await osmd.render();
    log('MusicXML gerendert.');
  }

  async function detectTempoFromXMLText(text){
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const soundWithTempo = xml.querySelector('sound[tempo]');
    const tempoAttr = Number(soundWithTempo?.getAttribute('tempo'));
    if (Number.isFinite(tempoAttr) && tempoAttr > 0) return Math.round(tempoAttr);

    const met = xml.querySelector('direction-type > metronome');
    if (met) {
      const perMin = Number(met.querySelector('per-minute')?.textContent);
      const unit = met.querySelector('beat-unit')?.textContent?.trim()?.toLowerCase();
      if (Number.isFinite(perMin) && perMin > 0 && unit) {
        const unitMap = { 'whole':4, 'half':2, 'quarter':1, 'eighth':0.5, '8th':0.5, '16th':0.25, '32nd':0.125, '64th':0.0625 };
        const base = unitMap[unit] ?? 1;
        const dots = met.querySelectorAll('beat-unit-dot').length;
        let dotFactor = 1; for (let k=1;k<=dots;k++) dotFactor += Math.pow(0.5, k);
        const beatInQuarters = base * dotFactor;
        const qpm = perMin * beatInQuarters;
        return Math.max(1, Math.round(qpm));
      }
    }
    return null;
  }

  async function extractNotesFromXMLText(text, bpmForTiming) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const stepToSemitone = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
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
            for (const [v,t] of voiceTimes.entries()) voiceTimes.set(v, Math.max(0, t - durSec));
            continue;
          }
          if (ev.tagName === "forward") {
            const durQ = Number(ev.querySelector("duration")?.textContent || 0) / divisions;
            const durSec = durQ * secPerQuarterAtBase;
            for (const [v,t] of voiceTimes.entries()) voiceTimes.set(v, t + durSec);
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
              const hasTieStop  = tieTags.some(t => t.getAttribute("type") === "stop");
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

    notes = collected.filter(n => n.e > n.s).map(({p,s,e})=>({p,s,e})).sort((a,b)=>a.s-b.s);
    total = notes.length ? Math.max(...notes.map(n=>n.e)) : 0;
    t0 = 0;

    if (!notes.length) {
      log('⚠️ XML-Parser fand keine Noten. Enthält die Datei echte Noten (nicht nur Pausen/Layouts)?');
    } else {
      log(`XML-Parser: ${notes.length} Noten, Dauer: ${total.toFixed(2)}s (bei ${bpmForTiming} BPM)`);
      autoFitKeyboard(notes);
    }
  }

  // ---------- MIDI (optional via Magenta) ----------
  async function parseMidi(file){
    if(!window.mm) throw new Error('Magenta (mm) nicht geladen.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fn = mm?.midiToNoteSequence || mm?.midiToSequenceProto;
    if(typeof fn!=='function') throw new Error('Kein MIDI-Parser exportiert.');
    return await Promise.resolve(fn(bytes));
  }
  async function loadMidi(file){
    try{
      const ns = await parseMidi(file);
      const qpm = Math.round(ns?.tempos?.[0]?.qpm || ns?.qpm || 0);
      if (qpm > 0) { scoreBPM = qpm; if (bpm) { bpm.value = String(qpm); bpmVal.textContent = String(qpm); } log('⏱ Tempo aus MIDI:', qpm, 'BPM'); }
      notes = (ns.notes||[]).map(n=>({p:n.pitch,s:n.startTime,e:n.endTime})).sort((a,b)=>a.s-b.s);
      total = ns.totalTime || (notes.length?Math.max(...notes.map(n=>n.e)):0);
      autoFitKeyboard(notes);
      drawRoll();
      const has = notes.length>0;
      if (playBtn) playBtn.disabled = !has;
      if (stopBtn) stopBtn.disabled = !has;
      log('MIDI geladen:', file.name, `| Noten: ${notes.length} | Dauer: ${total.toFixed(2)}s`);
    }catch(err){
      console.error(err); log('MIDI-Fehler:', err?.message||err);
      alert('MIDI konnte nicht geladen werden. Probier MusicXML.\n\nDetails: '+(err?.message||err));
    }
  }

  // ---------- File input (optional/hidden) ----------
  if (xmlInput) {
    xmlInput.addEventListener('change', async e => {
      const f=e.target.files[0]; if(!f) return;
      const ext=f.name.toLowerCase().split('.').pop();
      try {
        if (ext === 'mxl') {
          await renderXMLinOSMD(f);
          log('ℹ️ Für Playback/Tempo ist .xml/.musicxml ideal (Text). .mxl wird angezeigt, aber nicht geparst.');
        } else {
          const xmlText = await f.text();
          const detected = await detectTempoFromXMLText(xmlText);
          if (detected && detected > 0) {
            scoreBPM = detected;
            if (bpm) { bpm.value = String(detected); bpmVal.textContent = String(detected); }
            log('⏱ Tempo aus MusicXML:', detected, 'BPM');
          } else {
            log('⏱ Kein Tempo in XML gefunden – Standard bleibt', scoreBPM, 'BPM');
          }
          await renderXMLinOSMD(xmlText, true);
          await extractNotesFromXMLText(xmlText, scoreBPM);
        }
        drawRoll();
        const has = notes.length>0;
        if (playBtn) playBtn.disabled = !has;
        if (stopBtn) stopBtn.disabled = !has;
        log('MusicXML geladen:', f.name, `| Noten: ${notes.length} | Dauer: ${total.toFixed(2)}s`);
      } catch (err) {
        console.error(err);
        log('XML/OSMD Fehler:', err?.message||err);
        alert('Konnte MusicXML nicht laden/analysieren.');
      }
    });
  }

  // ---------- URL loader ----------
  async function fetchAsFile(url, suggestedName){
    // Prefer no-cors hints that work when same-origin is set up properly
    const res = await fetch(url, { cache:'no-cache', credentials:'same-origin' });
    if (!res.ok) {
      log(`⚠️ Fetch failed: HTTP ${res.status} ${res.statusText} | URL: ${url}`);
      const retry = await fetch(url, { cache:'no-cache' });
      if (!retry.ok) {
        log(`⚠️ Retry failed: HTTP ${retry.status} ${retry.statusText}`);
        throw new Error(`HTTP ${retry.status}`);
      }
      const blob2 = await retry.blob();
      const name2 = suggestedName || (url.split('/').pop() || 'file');
      return new File([blob2], name2, { type: blob2.type || 'application/octet-stream' });
    }
    const blob = await res.blob();
    const name = suggestedName || (url.split('/').pop() || 'file');
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  }

  async function loadFromURLParam(){
    const xmlUrl  = params.get('xml');
    const midiUrl = params.get('midi');

    // Optional range override from URL
    const lowMidiParam  = parseMidiOrNote(params.get('low'));
    const highMidiParam = parseMidiOrNote(params.get('high'));
    const rangeStrict   = params.get('rangeStrict') !== '0'; // default strict

    if (lowMidiParam != null && highMidiParam != null) {
      const lo = Math.min(lowMidiParam, highMidiParam);
      const hi = Math.max(lowMidiParam, highMidiParam);
      userRangeOverride = { low: lo, high: hi, strict: rangeStrict };
      applyKeyboardRange(lo, hi, rangeStrict);
    } else if (lowMidiParam != null || highMidiParam != null) {
      log('⚠️ Bitte sowohl "low" als auch "high" setzen (MIDI Zahl oder Notenname, z.B. low=C3&high=G5).');
    }

    if (BPM_URL && Number(BPM_URL) > 0) {
      scoreBPM = Number(BPM_URL);
      if (bpm){ bpm.value = String(scoreBPM); bpmVal.textContent = String(scoreBPM); }
      log('⏱ Tempo via URL:', scoreBPM, 'BPM');
    }

    try {
      if (xmlUrl) {
        log('🌐 Lade XML von URL:', xmlUrl);
        const file = await fetchAsFile(xmlUrl);
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext === 'mxl') {
          await renderXMLinOSMD(file);
          log('ℹ️ .mxl per URL: Score sichtbar. Für Playback bitte .xml/.musicxml verwenden.');
        } else {
          const text = await file.text();
          const detected = await detectTempoFromXMLText(text);
          if (detected && detected > 0 && !BPM_URL) {
            scoreBPM = detected; if (bpm){ bpm.value = String(detected); bpmVal.textContent = String(detected); }
            log('⏱ Tempo aus MusicXML:', detected, 'BPM');
          }
          await renderXMLinOSMD(text, true);
          await extractNotesFromXMLText(text, scoreBPM);
        }
        drawRoll();
        const has = notes.length>0;
        if (playBtn) playBtn.disabled = !has;
        if (stopBtn) stopBtn.disabled = !has;
        if (has && (AUTOPLAY || FORCE_FIT)) {
          if (FORCE_FIT) {
            userRangeOverride = null; // ignore strict and fit to notes
            autoFitKeyboard(notes);
            drawRoll();
            log('🧩 Auto-fit erzwungen (fit=1).');
          }
          start();
        }
        return;
      }
      if (midiUrl) {
        log('🌐 Lade MIDI von URL:', midiUrl);
        const file = await fetchAsFile(midiUrl);
        await loadMidi(file);
        drawRoll();
        const has = notes.length>0;
        if (playBtn) playBtn.disabled = !has;
        if (stopBtn) stopBtn.disabled = !has;
        if (has && (AUTOPLAY || FORCE_FIT)) {
          if (FORCE_FIT) { userRangeOverride = null; autoFitKeyboard(notes); drawRoll(); log('🧩 Auto-fit erzwungen (fit=1).'); }
          start();
        }
      }
    } catch (err) {
      console.error(err);
      log('URL-Load Fehler:', err?.message||err);
      alert('Konnte Datei von URL nicht laden. CORS/HTTPS korrekt?');
    }
  }

  // ---------- Kick things off ----------
  setTimeout(()=>{
    log('HTTP-Served?', location.protocol.startsWith('http') ? 'ja' : 'nein (bitte lokalen Server nutzen)');
    log('Magenta geladen?', !!window.mm, '| midiToNoteSequence:', typeof window.mm?.midiToNoteSequence, '| midiToSequenceProto:', typeof window.mm?.midiToSequenceProto);
  },0);

  // Attach responsive behavior and do first paint
  handleResize();
  drawRoll();

  // Load from URL if present
  loadFromURLParam();

})();
