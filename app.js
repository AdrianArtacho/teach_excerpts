/* app.js — Visualizer logic (BPM fixes + robust flags) */
const log = (...a) => {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent += a.join(' ') + '\n';
  el.scrollTop = el.scrollHeight;
};

document.addEventListener('DOMContentLoaded', async () => {
  // ---------- URL params ----------
  const params = new URLSearchParams(location.search);

  // Title flag (keeps the emoji, replaces text content)
  const titleFlag = params.get('title');
  if (titleFlag) {
    const titleText = document.getElementById('titleText');
    if (titleText) titleText.textContent = titleFlag;
  }

  // Hide log flag
  if (params.get('hideLog') === '1') {
    const logBlock = document.getElementById('status');
    if (logBlock) logBlock.style.display = 'none';
    // hide the nearest "Status" heading if present
    const logHeading = document.querySelector('h3');
    if (logHeading && /status/i.test(logHeading.textContent)) logHeading.style.display = 'none';
  }

  // Loop default flag
  const loopCb = document.getElementById('loop');
  if (loopCb && params.get('loop') === '1') {
    loopCb.checked = true;
  }

  // BPM control + flag precedence
  let scoreBPM = 100;
  const bpmSlider = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  const bpmFromURL = params.get('bpm');
  let bpmLockedByURL = false; // when true, XML detection won't override

  if (bpmFromURL && Number(bpmFromURL) > 0) {
    scoreBPM = Number(bpmFromURL);
    bpmLockedByURL = true;
  }
  // Initialize UI with current BPM
  if (bpmSlider) bpmSlider.value = String(scoreBPM);
  if (bpmVal) bpmVal.textContent = String(scoreBPM);

  // Live-update BPM number + re-sync playback if running
  function reapplyTempoWhilePlaying() {
    if (!playing) return;
    // stop() clears schedules; start() rebuilds them at new tempo
    stop();
    start();
  }
  bpmSlider?.addEventListener('input', (e) => {
    const uiBpm = Number(e.target.value) || scoreBPM;
    bpmVal.textContent = String(uiBpm);
    reapplyTempoWhilePlaying();
  });

  // Visual transpose (keyboard lights + manual keys), audio unchanged for XML
  const transposeVis = parseInt(params.get('transposeVis') || '0', 10);

  // ---------- UI ----------
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const testBtn = document.getElementById('testTone');
  const panicBtn = document.getElementById('panic');
  const kb = document.getElementById('kb');
  const rollCv = document.getElementById('roll');
  const ctx = rollCv.getContext('2d');
  const osmdDiv = document.getElementById('osmd');
  if (osmdDiv) osmdDiv.innerHTML = ''; // remove placeholder text

  if (window.customElements?.whenDefined) {
    try { await customElements.whenDefined('all-around-keyboard'); } catch {}
  }

  // ---------- State ----------
  let notes = [];   // parsed from XML: {p,s,e}
  let total = 0;
  let playing = false, startedAt=0, t0=0, rafId=null;
  let scheduled = [], loopTimer=null, lightTimers=[];

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
  function allNotesOff(){
    for (const [m,v] of audio.voices) { try { v.osc.stop(); } catch {} }
    audio.voices.clear();
    clearLightingTimers(true);
  }

  // Test & Panic
  testBtn?.addEventListener('click', () => {
    audioInit();
    audio.ctx.resume?.().then(()=>{
      log('Test resume state=' + audio.ctx.state);
      const v = mkVoice(440, 0.2);
      v.osc.start();
      v.osc.stop(audio.ctx.currentTime + 0.3);
    });
  });
  panicBtn?.addEventListener('click', ()=>{ allNotesOff(); log('⏹ Panic: all voices stopped.'); });

  // ---------- Keyboard handling ----------
  // Component emits: MIDI = 24 + index (C1 base)
  const MIDI_BASE_FOR_LAYOUT = 24;
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = m => Number.isInteger(m) && m >= 0 && m <= 127;

  // Manual keys: apply inverse transpose for sound (visual is separate)
  kb?.addEventListener('noteon', e => {
    const m = midiFromKbEvent(e);
    if (isValidMidi(m)) noteOn(m - transposeVis, 0.7);
  });
  ['noteoff','noteOff','keyrelease'].forEach(ev=>{
    kb?.addEventListener(ev, e => {
      const m = midiFromKbEvent(e);
      if (isValidMidi(m)) noteOff(m - transposeVis);
    });
  });
  kb?.addEventListener('keypress', e => {
    const m = midiFromKbEvent(e);
    if (isValidMidi(m)) noteOn(m - transposeVis, 0.7);
  });

  // Lighting helpers (apply transpose visually)
  function lightMidi(m){ 
    const visMidi = m + transposeVis;
    const idx = visMidi - MIDI_BASE_FOR_LAYOUT;
    if (typeof kb?.keysLight === 'function') kb.keysLight([idx]);
  }
  function dimMidi(m){   
    const visMidi = m + transposeVis;
    const idx = visMidi - MIDI_BASE_FOR_LAYOUT;
    if (typeof kb?.keysDim === 'function') kb.keysDim([idx]);
  }

  // ---------- Piano roll (fills container width) ----------
  function drawRoll(){
    if (!rollCv) return;
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight;
    if (rollCv.width!==W||rollCv.height!==H){ rollCv.width=W; rollCv.height=H; }
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#f3f5fb'; ctx.fillRect(0,0,W,H);
    if (!notes.length||total<=0) return;
    const secToX=s=>pad+(W-2*pad)*(s/total), keyH=(H-2*pad)/12;
    ctx.fillStyle='#2f6fab';
    for(const n of notes){
      const x=secToX(n.s), w=Math.max(2,secToX(n.e)-secToX(n.s)), y=H-pad-(n.p%12+1)*keyH;
      ctx.fillRect(x,y,w,keyH-1);
    }
  }
  function drawPlayhead(t){
    if (!rollCv || total<=0) return; const pad=6;
    const x=pad+(rollCv.width-2*pad)*(Math.min(t,total)/total);
    ctx.strokeStyle='#e74c3c'; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,rollCv.height); ctx.stroke();
  }

  // ---------- Scheduling ----------
  function clearLightingTimers(andDim=false){
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim && typeof kb?.keysDim==='function') {
      // dim a wide range to ensure clear; component will ignore out-of-range
      kb.keysDim([...Array(128).keys()]);
    }
  }
  function scheduleNotesAtTempo(){
    const uiBpm = Number(bpmSlider?.value) || scoreBPM; // current slider BPM
    const scale = scoreBPM / uiBpm; // scoreSec → realSec
    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;
    for (const n of notes) {
      const s = n.s * scale;
      const d = (n.e - n.s) * scale;
      if (d <= 0) continue;

      // Audio (true to XML pitches)
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setValueAtTime(0.22, startBase + s + Math.max(0.01, d - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + Math.max(0.01, d - 0.03), 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push(v);

      // Lights (visually transposed)
      const onDelaySec  = Math.max(0, (startBase + s)     - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + s + d) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidi(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidi(n.p),   offDelaySec * 1000));
      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${uiBpm} (score BPM=${scoreBPM})`);

    const passDur = total * scale;
    if (loopCb?.checked) {
      loopTimer = setTimeout(() => {
        t0 = 0; startedAt = performance.now()/1000;
        clearLightingTimers(true);
        scheduleNotesAtTempo();
      }, Math.max(0, (passDur + 0.05) * 1000));
    }
  }

  function start(){
    if(!notes.length||playing) { if(!notes.length) log('⚠️ Keine Noten geladen.'); return; }
    audioInit(); audio.ctx.resume?.();
    playing=true; startedAt=performance.now()/1000; t0=0;
    scheduleNotesAtTempo();
    rafId=requestAnimationFrame(tick);
  }
  function stop(){
    playing=false; if(rafId) cancelAnimationFrame(rafId); rafId=null; t0=0;
    // stop scheduled audio
    for (const v of scheduled) { try { v.osc.stop(); } catch {} }
    scheduled.length = 0;
    clearLightingTimers(true); allNotesOff(); drawRoll();
    if (loopTimer) { clearTimeout(loopTimer); loopTimer=null; }
  }
  function tick(){
    const uiBpm = Number(bpmSlider?.value) || scoreBPM;
    const t = t0 + (performance.now()/1000 - startedAt) * (uiBpm/scoreBPM);
    if(total>0 && t>=total) { 
      if(loopCb?.checked){ stop(); start(); return; } 
      else { stop(); return; } 
    }
    drawRoll(); drawPlayhead(Math.min(t,total));
    rafId=requestAnimationFrame(tick);
  }

  playBtn?.addEventListener('click', start);
  stopBtn?.addEventListener('click', stop);

  // ---------- OSMD ----------
  let osmd=null;
  async function renderXML(text){
    if(!osmd) osmd=new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd',{drawingParameters:'compact'});
    await osmd.load(text); 
    await osmd.render();
  }

  // Detect BPM in MusicXML (used only if no ?bpm= set)
  async function detectTempoFromXMLText(text){
    try{
      const xml = new DOMParser().parseFromString(text, 'application/xml');
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
    }catch(_){}
    return null;
  }

  async function parseXML(text){
    const xml=new DOMParser().parseFromString(text,"application/xml");
    const stepToSemitone={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
    let divisions=1;
    const collected=[];
    const parts=[...xml.querySelectorAll("part")];
    for(const part of parts){
      let time=0;
      for(const measure of part.querySelectorAll("measure")){
        const d=measure.querySelector("divisions");
        if(d) divisions=Number(d.textContent)||divisions;
        for(const note of measure.querySelectorAll("note")){
          if(note.querySelector("rest")){
            const dur=Number(note.querySelector("duration")?.textContent||0)/divisions;
            time+=dur; continue; 
          }
          const step=note.querySelector("step")?.textContent;
          const alter=Number(note.querySelector("alter")?.textContent||0);
          const oct=Number(note.querySelector("octave")?.textContent);
          const dur=Number(note.querySelector("duration")?.textContent||0)/divisions;
          if(step&&Number.isFinite(oct)){
            const midi=12*(oct+1)+stepToSemitone[step]+alter;
            collected.push({p:midi,s:time,e:time+dur});
          }
          time+=dur;
        }
      }
    }
    notes=collected; 
    total = notes.length ? Math.max(...notes.map(n=>n.e)) : 0;
  }

  // ---------- URL loader ----------
  async function loadFromURL(){
    const xmlUrl=params.get('xml');
    if(!xmlUrl) return;
    try{
      const res=await fetch(xmlUrl, { cache: 'no-cache' });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt=await res.text();

      // Set BPM from XML only if no ?bpm= was provided
      if (!bpmLockedByURL) {
        const detected = await detectTempoFromXMLText(txt);
        if (detected && detected > 0) {
          scoreBPM = detected;
          if (bpmSlider) bpmSlider.value = String(detected);
          if (bpmVal) bpmVal.textContent = String(detected);
          log('⏱ Tempo aus MusicXML:', detected, 'BPM');
        } else {
          log('⏱ Kein Tempo in XML gefunden – Standard bleibt', scoreBPM, 'BPM');
        }
      } else {
        log('⏱ Tempo via URL festgelegt:', scoreBPM, 'BPM (überschreibt XML)');
      }

      await renderXML(txt);
      await parseXML(txt);

      playBtn.disabled=stopBtn.disabled=!notes.length;
      drawRoll();
    }catch(e){ 
      log('XML load error: '+(e?.message||e)); 
    }
  }

  // Debug + kick URL loader
  setTimeout(()=>{
    log('HTTP-Served?', location.protocol.startsWith('http') ? 'ja' : 'nein');
  },0);
  loadFromURL();
});
