// app.js
// Visualizer – Roll ↑ | Score ↔ | Keyboard ↓ + MusicXML BPM
// Features: MusicXML render, WebAudio synth, piano roll, keyboard lights, URL flags, visual-only transpose

const log = (...a)=>{ const el=document.getElementById('status'); if (!el) return; el.textContent += a.join(' ') + '\n'; el.scrollTop=el.scrollHeight; };

    // --- Hide status log via URL flag ---
    (function applyLogVisibilityFromURL(){
    const params = new URLSearchParams(location.search);
    const v = params.get('log');
    if (v !== null && /^(0|false|no|off|hide)$/i.test(v)) {
        const statusBlock = document.getElementById('status');
        const statusHeader = statusBlock?.previousElementSibling;
        if (statusHeader && statusHeader.tagName === 'H3') statusHeader.style.display = 'none';
        if (statusBlock) statusBlock.style.display = 'none';
    }
    })();


document.addEventListener('DOMContentLoaded', async () => {
  // ---------- URL flags ----------
  const params = new URLSearchParams(location.search);

  // Title (keeps emoji; index.html owns the actual <h1>, but we support it here if present)
  (function applyTitleFromURL(){
    const t = params.get('title');
    if (!t) return;
    const span = document.getElementById('titleText');
    if (span) span.textContent = t;
  })();

  // Visual-only transpose for keyboard lighting
  const transposeVis = Number(params.get('transposeVis') ?? params.get('transpose') ?? 0) || 0;
  if (transposeVis !== 0) log(`🎚 Visual transpose (lights only): ${transposeVis} semitones`);

  // ---------- Config ----------
  let scoreBPM = 100;          // dynamically set from XML/MIDI (or ?bpm=)
  const MIN_OCTAVES = 2;       // cute default
  const PAD_SEMITONES = 1;     // a little margin so edge notes aren't clipped
  const LOWEST_EMITTABLE_MIDI = 24; // all-around-keyboard emits MIDI = 24 + index

  // ---------- UI ----------
  const xmlInput  = document.getElementById('xmlFile');     // may or may not exist depending on your index.html
  const playBtn   = document.getElementById('play');
  const stopBtn   = document.getElementById('stop');
  const testBtn   = document.getElementById('testTone');
  const panicBtn  = document.getElementById('panic');
  const loopCb    = document.getElementById('loop');
  const bpm       = document.getElementById('bpm');
  const bpmVal    = document.getElementById('bpmVal');
  const kb        = document.getElementById('kb');
  const rollCv    = document.getElementById('roll');
  const ctx       = rollCv.getContext('2d');

  if (window.customElements?.whenDefined) {
    try { await customElements.whenDefined('all-around-keyboard'); } catch {}
  }

    // --- Loop via URL flag ---
    (function applyLoopFromURL(){
    const params = new URLSearchParams(location.search);
    const v = params.get('loop');
    if (v !== null) {
        const on = /^(1|true|yes|on)$/i.test(v);
        loopCb.checked = on;
        log('🔁 Loop via URL: ' + (on ? 'ON' : 'OFF'));
    }
    })();

  // ---------- Keyboard range / mapping ----------
  let LOWEST_PITCH = 60; // updates after fit or URL range
  let TOTAL_KEYS   = 12 * (parseInt(kb?.getAttribute('octaves')) || MIN_OCTAVES);
  const toIdx      = p => p - LOWEST_PITCH;

  // Component layout: layout index 0 == MIDI 24 (C1)
  const MIDI_BASE_FOR_LAYOUT = 24;
  const getLeftmostIndex = () => Number(kb?.getAttribute('leftmostKey') || 48);
  const setLeftmostIndex = (idx) => kb?.setAttribute('leftmostKey', String(Math.max(0, Math.round(idx))));
  const indexFromMidi   = midi => getLeftmostIndex() + (midi - LOWEST_PITCH);

  // ---------- State ----------
  let notes   = [];   // {p,s,e} in "score seconds" (at scoreBPM reference)
  let total   = 0;
  let playing = false, startedAt=0, t0=0, rafId=null;
  let scheduled = [], loopTimer=null, lightTimers=[];

  // ---------- Range flags (parse, but apply later) ----------
  let userRangeOverride = null; // {low, high, strict}
  const NOTE_INDEX = {c:0,'c#':1,'db':1,d:2,'d#':3,'eb':3,e:4,f:5,'f#':6,'gb':6,g:7,'g#':8,'ab':8,a:9,'a#':10,'bb':10,b:11};

  function parseNoteNameToMidi(s){
    if (!s) return null;
    s = String(s).trim();
    const m = s.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) return null;
    const name = (m[1]+m[2]).toLowerCase();
    const oct = parseInt(m[3],10);
    if (!(name in NOTE_INDEX)) return null;
    return 12 * (oct + 1) + NOTE_INDEX[name];
  }
  function parseMidiOrNote(val){
    if (val == null) return null;
    if (/^-?\d+$/.test(String(val))) {
      const n = Number(val);
      return (n>=0 && n<=127) ? n : null;
    }
    return parseNoteNameToMidi(val);
  }

  // Apply a range window (snaps to octaves) and align keyboard mapping
  function applyKeyboardRange(lowMidi, highMidi, strict=true){
    if (!kb) return;
    // Clamp to what the component can actually emit (>= C1 / MIDI 24)
    lowMidi  = Math.max(LOWEST_EMITTABLE_MIDI, Math.min(127, lowMidi));
    highMidi = Math.max(lowMidi, Math.min(127, highMidi));

    const fitLow  = Math.floor(lowMidi / 12) * 12;
    const fitHigh = Math.ceil((highMidi+1) / 12) * 12 - 1;
    const neededOcts = Math.max(MIN_OCTAVES, Math.ceil((fitHigh - fitLow + 1) / 12));

    LOWEST_PITCH = fitLow;
    TOTAL_KEYS   = neededOcts * 12;

    kb.setAttribute('octaves', String(neededOcts));

    // Align component index→MIDI mapping so clicking plays the intended notes.
    // We set leftmostKey so that: emitted MIDI (24 + index) == intended MIDI at left edge.
    // That means leftmostKey = LOWEST_PITCH - 24 (but never below 0).
    const leftmostIndex = Math.max(0, LOWEST_PITCH - MIDI_BASE_FOR_LAYOUT);
    setLeftmostIndex(leftmostIndex);

    kb.offsetWidth; // force layout
    const finalHigh = LOWEST_PITCH + TOTAL_KEYS - 1;
    log(`🎛 Range ${strict?'(strict) ':''}gesetzt: MIDI ${LOWEST_PITCH}..${finalHigh} | Oktaven: ${neededOcts} | leftmostKey(index)=${leftmostIndex}`);
  }

  // ---------- Audio ----------
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
  const midiToFreq = m => 440 * Math.pow(2,(m-69)/12);
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

  // Test & Panic
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      audioInit();
      audio.ctx.resume?.().then(()=>{
        log('Test resume state=' + audio.ctx.state);
        const v = mkVoice(440, 0.2);
        v.osc.start();
        v.osc.stop(audio.ctx.currentTime + 0.3);
      }).catch(e=>log('Test resume err: '+e));
    });
  }
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
  if (panicBtn) {
    panicBtn.addEventListener('click', ()=>{ allNotesOff(); log('⏹ Panic: all voices stopped, lights cleared.'); });
  }

  // Manual key → sound
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = m => Number.isInteger(m) && m >= 0 && m <= 127;
  if (kb) {
    kb.addEventListener('noteon',    e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener('noteOff',   e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener('noteoff',   e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
    kb.addEventListener('keypress',  e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m, 0.7); });
    kb.addEventListener('keyrelease',e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m); });
  }

  // ---------- Lighting helpers (visual-only transpose applied here) ----------
  function clampMidi(m){ return Math.max(0, Math.min(127, m|0)); }
  function lightMidi(m){
    if (!kb) return;
    const pitch = clampMidi(m + transposeVis);         // visual shift only
    const idx = indexFromMidi(pitch);
    if (typeof kb.keysLight === 'function') kb.keysLight([idx]);
  }
  function dimMidi(m){
    if (!kb) return;
    const pitch = clampMidi(m + transposeVis);         // visual shift only
    const idx = indexFromMidi(pitch);
    if (typeof kb.keysDim === 'function') kb.keysDim([idx]);
  }

  // ---------- Piano roll ----------
  function drawRoll(){
    if (!rollCv) return;
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight;
    if (rollCv.width!==W||rollCv.height!==H){ rollCv.width=W; rollCv.height=H; }
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#f3f5fb'; ctx.fillRect(0,0,W,H);
    if (!notes.length||total<=0) return;
    const secToX=s=>pad+(W-2*pad)*(s/total), keyH=(H-2*pad)/TOTAL_KEYS;
    ctx.fillStyle='#2f6fab';
    for(const n of notes){
      const i=toIdx(n.p + 0); // roll shows true pitch timeline (no visual transpose)
      if(i<0||i>=TOTAL_KEYS) continue;
      const x=secToX(n.s), w=Math.max(2,secToX(n.e)-secToX(n.s)), y=H-pad-(i+1)*keyH;
      ctx.fillRect(x,y,w,keyH-1);
    }
  }
  function drawPlayhead(t){
    if (!rollCv || total<=0) return; const pad=6;
    const x=pad+(rollCv.width-2*pad)*(Math.min(t,total)/total);
    ctx.strokeStyle='#e74c3c'; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,rollCv.height); ctx.stroke();
  }

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
    if (!audio.ctx) audioInit();
    // Convert score seconds → real seconds using current slider BPM
    const scale = scoreBPM / Number(bpm.value);
    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;
    for (const n of notes) {
      const s = n.s * scale;
      const d = (n.e - n.s) * scale;
      if (d <= 0) continue;

      // Audio at TRUE pitch (no transpose)
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push({ ...v, offAt: startBase + s + d + 0.03 });

      // Lights (these helpers apply visual transpose)
      const onDelaySec  = Math.max(0, (startBase + s)     - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + s + d) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidi(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidi(n.p),   offDelaySec * 1000));
      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${bpm.value} (score BPM=${scoreBPM})`);

    const passDur = total * scale;
    if (loopCb?.checked) {
      loopTimer = setTimeout(() => {
        t0 = 0; startedAt = performance.now()/1000;
        clearScheduledAudio(); clearLightingTimers(true);
        scheduleNotesAtTempo();
      }, Math.max(0, (passDur + 0.05) * 1000));
    }
  }

  // ---------- Transport ----------
  const nowTime=()=> !playing ? t0 : t0 + (performance.now()/1000 - startedAt) * (Number(bpm.value)/scoreBPM);
  if (bpm) {
    bpm.addEventListener('input',e=>{
      if (bpmVal) bpmVal.textContent=e.target.value;
      if (playing) { stop(); start(); } // re-sync schedules
    });
    if (bpmVal) bpmVal.textContent=bpm.value;
  }

  function tick(){
    const t=nowTime();
    if(!loopCb?.checked && total>0 && t>=total){
      drawRoll(); drawPlayhead(total); playing=false; return;
    }
    if(loopCb?.checked && total>0 && t>=total){
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

  if (playBtn) playBtn.addEventListener('click', start);
  if (stopBtn) stopBtn.addEventListener('click', stop);

    function drawRoll(){
    if (!rollCv) return;
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight;
    if (rollCv.width!==W||rollCv.height!==H){ rollCv.width=W; rollCv.height=H; }
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#f3f5fb'; ctx.fillRect(0,0,W,H);
    if (!notes.length||total<=0) return;

    const secToX=s=>pad+(W-2*pad)*(s/total), keyH=(H-2*pad)/TOTAL_KEYS;
    ctx.fillStyle='#2f6fab';
    for (const n of notes) {
        const i = toIdx(n.p);                  // ← TRUE pitch (no transpose)
        if (i<0||i>=TOTAL_KEYS) continue;
        const x=secToX(n.s), w=Math.max(2,secToX(n.e)-secToX(n.s)), y=H-pad-(i+1)*keyH;
        ctx.fillRect(x,y,w,keyH-1);
    }
    }

  // ---------- Auto-fit keyboard (respects override) ----------
    function autoFitKeyboard(noteArray){
    const forceFit = params.get('fit') === '1';
    if (userRangeOverride && userRangeOverride.strict && !forceFit) return;
    if (!noteArray.length) return;

    // True pitch range (for roll)
    const loTrue = noteArray.reduce((m, n) => Math.min(m, n.p), 127);
    const hiTrue = noteArray.reduce((m, n) => Math.max(m, n.p), 0);

    // Visually shifted range (for lights)
    const loVis  = noteArray.reduce((m, n) => Math.min(m, Math.max(0, Math.min(127, n.p + transposeVis))), 127);
    const hiVis  = noteArray.reduce((m, n) => Math.max(m, Math.max(0, Math.min(127, n.p + transposeVis))), 0);

    // Use the union so BOTH roll (true) and lights (shifted) are in view
    let low  = Math.min(loTrue, loVis);
    let high = Math.max(hiTrue, hiVis);

    // Safety pad + component floor/ceiling
    low  = Math.max(LOWEST_EMITTABLE_MIDI,  low  - PAD_SEMITONES);
    high = Math.min(127,                    high + PAD_SEMITONES);

    // If a non-strict baseline exists, ensure at least that window
    if (userRangeOverride && !userRangeOverride.strict) {
        low  = Math.min(low,  userRangeOverride.low);
        high = Math.max(high, userRangeOverride.high);
    }

    applyKeyboardRange(low, high, !forceFit && !!userRangeOverride?.strict);
    }


  // ---------- MusicXML tempo detection ----------
  async function detectTempoFromXMLText(text){
    const xml = new DOMParser().parseFromString(text, "application/xml");

    // 1) <sound tempo="...">
    const soundWithTempo = xml.querySelector('sound[tempo]');
    const tempoAttr = Number(soundWithTempo?.getAttribute('tempo'));
    if (Number.isFinite(tempoAttr) && tempoAttr > 0) return Math.round(tempoAttr);

    // 2) <direction-type><metronome>...</metronome>
    const met = xml.querySelector('direction-type > metronome');
    if (met) {
      const perMin = Number(met.querySelector('per-minute')?.textContent);
      const unit = met.querySelector('beat-unit')?.textContent?.trim()?.toLowerCase();
      if (Number.isFinite(perMin) && perMin > 0 && unit) {
        const base = { 'whole':4, 'half':2, 'quarter':1, 'eighth':0.5, '8th':0.5, '16th':0.25, '32nd':0.125, '64th':0.0625 }[unit] ?? 1;
        const dots = met.querySelectorAll('beat-unit-dot').length;
        let dotFactor = 1; for (let k=1;k<=dots;k++) dotFactor += Math.pow(0.5, k);
        const beatInQuarters = base * dotFactor;
        const qpm = perMin * beatInQuarters;
        return Math.max(1, Math.round(qpm));
      }
    }
    return null;
  }

  // ---------- Loaders ----------
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
      if (qpm > 0) { scoreBPM = qpm; bpm.value = String(qpm); if (bpmVal) bpmVal.textContent = String(qpm); log('⏱ Tempo aus MIDI:', qpm, 'BPM'); }
      notes = (ns.notes||[]).map(n=>({p:n.pitch,s:n.startTime,e:n.endTime})).sort((a,b)=>a.s-b.s);
      total = ns.totalTime || (notes.length?Math.max(...notes.map(n=>n.e)):0);

      const forceFit = params.get('fit') === '1';
      if (userRangeOverride && userRangeOverride.strict && !forceFit) {
        applyKeyboardRange(userRangeOverride.low, userRangeOverride.high, true);
      } else {
        autoFitKeyboard(notes);
      }

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

    const forceFit = params.get('fit') === '1';

    if (!notes.length) {
      log('⚠️ XML-Parser fand keine Noten. Enthält die Datei echte Noten (nicht nur Pausen/Layouts)?');
    } else {
      log(`XML-Parser: ${notes.length} Noten, Dauer: ${total.toFixed(2)}s (bei ${bpmForTiming} BPM)`);
      if (userRangeOverride && userRangeOverride.strict && !forceFit) {
        applyKeyboardRange(userRangeOverride.low, userRangeOverride.high, true);
      } else {
        autoFitKeyboard(notes);
      }
    }
  }

  // ---------- File input wiring (if button exists) ----------
  if (xmlInput) {
    xmlInput.addEventListener('change', async e => {
      const f=e.target.files[0]; if(!f) return;
      const ext=f.name.toLowerCase().split('.').pop();
      if(!['xml','musicxml','mxl'].includes(ext)) { alert('Bitte .xml/.musicxml/.mxl wählen.'); return; }
      try {
        let xmlText = null;
        if (ext === 'mxl') {
          await renderXMLinOSMD(f);
          log('ℹ️ Für Playback/Tempo ist .xml/.musicxml ideal (Text). .mxl wird angezeigt, aber nicht geparst.');
        } else {
          xmlText = await f.text();
          const detected = await detectTempoFromXMLText(xmlText);
          if (detected && detected > 0) {
            scoreBPM = detected;
            if (bpm) bpm.value = String(detected);
            if (bpmVal) bpmVal.textContent = String(detected);
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

  // ---------- URL param loader (xml/midi, bpm, range, autoplay) ----------
  async function loadFromURLParam(){
    const xmlUrl  = params.get('xml');
    const midiUrl = params.get('midi');
    const bpmUrl  = params.get('bpm');
    const autoplay= params.get('autoplay');

    // Range from URL (supports MIDI numbers or note names; clamps low to C1/24)
    const lowMidiParam  = parseMidiOrNote(params.get('low'));
    const highMidiParam = parseMidiOrNote(params.get('high'));
    const rangeStrict = params.get('rangeStrict') !== '0'; // default strict
    const forceFit = params.get('fit') === '1';

    if (lowMidiParam != null && highMidiParam != null) {
      const lo = Math.min(lowMidiParam, highMidiParam);
      const hi = Math.max(lowMidiParam, highMidiParam);
      userRangeOverride = { low: lo, high: hi, strict: rangeStrict };
      applyKeyboardRange(lo, hi, rangeStrict);
    } else if (lowMidiParam != null || highMidiParam != null) {
      log('⚠️ Bitte sowohl "low" als auch "high" setzen (MIDI Zahl oder Notenname, z.B. low=C3&high=G5).');
    }

    if (bpmUrl && Number(bpmUrl) > 0) {
      scoreBPM = Number(bpmUrl);
      if (bpm) bpm.value = String(scoreBPM);
      if (bpmVal) bpmVal.textContent = String(scoreBPM);
      log('⏱ Tempo via URL:', scoreBPM, 'BPM');
    }

    async function fetchAsFile(url, suggestedName){
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) {
          log(`⚠️ Fetch failed: HTTP ${res.status} ${res.statusText} | URL: ${url}`);
          throw new Error(`HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const name = suggestedName || (url.split('/').pop() || 'file');
        log(`✅ Loaded URL ok (${res.status}). Content-Type: ${res.headers.get('Content-Type')||'(none)'}`);
        return new File([blob], name, { type: blob.type || 'application/octet-stream' });
      } catch (err) {
        log('URL-Load Fehler (fetchAsFile): ' + (err?.message||err));
        throw err;
      }
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
          if (detected && detected > 0 && !bpmUrl) {
            scoreBPM = detected; if (bpm) bpm.value = String(detected); if (bpmVal) bpmVal.textContent = String(detected);
            log('⏱ Tempo aus MusicXML:', detected, 'BPM');
          }
          await renderXMLinOSMD(text, true);
          await extractNotesFromXMLText(text, scoreBPM);
        }
        drawRoll();
        const has = notes.length>0;
        if (playBtn) playBtn.disabled = !has;
        if (stopBtn) stopBtn.disabled = !has;
        if (has && (autoplay || forceFit)) {
          if (forceFit) {
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
        if (has && (autoplay || forceFit)) {
          if (forceFit) { userRangeOverride = null; autoFitKeyboard(notes); drawRoll(); log('🧩 Auto-fit erzwungen (fit=1).'); }
          start();
        }
      }
    } catch (err) {
      console.error(err);
      log('URL-Load Fehler:', err?.message||err);
      alert('Konnte Datei von URL nicht laden. CORS/HTTPS korrekt?');
    }
  }

  // Debug + kick URL loader
  setTimeout(()=>{
    log('HTTP-Served?', location.protocol.startsWith('http') ? 'ja' : 'nein (bitte lokalen Server nutzen)');
    log('Magenta geladen?', !!window.mm, '| midiToNoteSequence:', typeof window.mm?.midiToNoteSequence, '| midiToSequenceProto:', typeof window.mm?.midiToSequenceProto);
  },0);
  loadFromURLParam();
});
