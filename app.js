/* app.js — Correct BPM math (quarters → seconds), visual-only transpose, robust flags */

const log = (...a) => {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent += a.join(' ') + '\n';
  el.scrollTop = el.scrollHeight;
};

document.addEventListener('DOMContentLoaded', async () => {
  // ---------- URL params ----------
  const params = new URLSearchParams(location.search);

  // Title (keeps emoji, replaces text)
  const titleFlag = params.get('title');
  if (titleFlag) {
    const titleText = document.getElementById('titleText');
    if (titleText) titleText.textContent = titleFlag;
  }

  // Hide log
  if ((params.get('hideLog') || params.get('hidelog')) === '1') {
    const logBlock = document.getElementById('status');
    if (logBlock) logBlock.style.display = 'none';
    const logHeading = [...document.querySelectorAll('h3')].find(h => /status/i.test(h.textContent));
    if (logHeading) logHeading.style.display = 'none';
  }

  // Loop default
  const loopCb = document.getElementById('loop');
  if (loopCb && params.get('loop') === '1') loopCb.checked = true;

  // BPM
  const bpmSlider = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  const bpmFromURL = params.get('bpm');
  let bpmLockedByURL = false;
  let defaultBPM = 100; // used only to initialize the UI if nothing else provided

  if (bpmFromURL && Number(bpmFromURL) > 0) {
    defaultBPM = Number(bpmFromURL);
    bpmLockedByURL = true; // XML detection won't override
  }
  if (bpmSlider) bpmSlider.value = String(defaultBPM);
  if (bpmVal) bpmVal.textContent = String(defaultBPM);

  // Visual transpose
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
  if (osmdDiv) osmdDiv.innerHTML = ''; // remove placeholder

  if (window.customElements?.whenDefined) {
    try { await customElements.whenDefined('all-around-keyboard'); } catch {}
  }

  // ---------- State ----------
  // We store timing in QUARTER-NOTES:
  //   n.qs = start in quarters, n.qe = end in quarters
  let notes = [];         // [{p, qs, qe}]
  let totalQ = 0;         // total duration in quarters
  let playing = false, startedAt = 0, rafId = null;
  let scheduled = [], loopTimer=null, lightTimers=[];

  // ---------- Helpers ----------
  const currentBPM = () => Number(bpmSlider?.value) || defaultBPM;
  const secPerQuarter = () => 60 / currentBPM();  // seconds for one quarter
  const quartersPerSecond = () => currentBPM() / 60;

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
  const MIDI_BASE_FOR_LAYOUT = 24; // C1
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = m => Number.isInteger(m) && m >= 0 && m <= 127;

  // Manual keys: sound = (pressed - transposeVis) so audio stays true to score; lights are handled separately
  kb?.addEventListener('noteon', e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m - transposeVis, 0.7); });
  ['noteoff','noteOff','keyrelease'].forEach(ev=>{
    kb?.addEventListener(ev, e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOff(m - transposeVis); });
  });
  kb?.addEventListener('keypress', e => { const m = midiFromKbEvent(e); if (isValidMidi(m)) noteOn(m - transposeVis, 0.7); });

  // Lighting helpers (visual transpose only)
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

  // ---------- Piano roll (width = container) ----------
  function drawRoll(){
    if (!rollCv) return;
    const pad=6, W=rollCv.clientWidth, H=rollCv.clientHeight;
    if (rollCv.width!==W||rollCv.height!==H){ rollCv.width=W; rollCv.height=H; }
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#f3f5fb'; ctx.fillRect(0,0,W,H);
    if (!notes.length||totalQ<=0) return;
    const qToX=q=>pad+(W-2*pad)*(q/totalQ), keyH=(H-2*pad)/12;
    ctx.fillStyle='#2f6fab';
    for(const n of notes){
      const x=qToX(n.qs), w=Math.max(2,qToX(n.qe)-qToX(n.qs)), y=H-pad-(n.p%12+1)*keyH;
      ctx.fillRect(x,y,w,keyH-1);
    }
  }
  function drawPlayhead(q){
    if (!rollCv || totalQ<=0) return; const pad=6;
    const x=pad+(rollCv.width-2*pad)*(Math.min(q,totalQ)/totalQ);
    ctx.strokeStyle='#e74c3c'; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,rollCv.height); ctx.stroke();
  }
  window.addEventListener('resize', drawRoll);

  // ---------- Scheduling ----------
  function clearLightingTimers(andDim=false){
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim && typeof kb?.keysDim==='function') {
      kb.keysDim([...Array(128).keys()]);
    }
  }
  function scheduleNotes(){
    const spq = secPerQuarter(); // seconds per quarter from LIVE UI BPM
    const startBase = audio.ctx.currentTime + 0.03;
    let count = 0;
    for (const n of notes) {
      const sSec = n.qs * spq;
      const dSec = (n.qe - n.qs) * spq;
      if (dSec <= 0) continue;

      // Audio (true to XML pitches)
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + sSec);
      v.gain.gain.setValueAtTime(0.22, startBase + sSec + Math.max(0.01, dSec - 0.03));
      v.gain.gain.setTargetAtTime(0.0001, startBase + sSec + Math.max(0.01, dSec - 0.03), 0.02);
      v.osc.stop(startBase + sSec + dSec + 0.03);
      scheduled.push(v);

      // Lights (visually transposed)
      const onDelaySec  = Math.max(0, (startBase + sSec)     - audio.ctx.currentTime);
      const offDelaySec = Math.max(0, (startBase + sSec + dSec) - audio.ctx.currentTime);
      lightTimers.push(setTimeout(() => lightMidi(n.p), onDelaySec * 1000));
      lightTimers.push(setTimeout(() => dimMidi(n.p),   offDelaySec * 1000));
      count++;
    }
    log(`🎼 Scheduled ${count} notes @ BPM ${currentBPM()}`);

    const passDurSec = totalQ * spq;
    if (loopCb?.checked) {
      loopTimer = setTimeout(() => {
        stop(); start(); // simplest reliable reloop with fresh BPM
      }, Math.max(0, (passDurSec + 0.05) * 1000));
    }
  }

  function start(){
    if(!notes.length||playing) { if(!notes.length) log('⚠️ Keine Noten geladen.'); return; }
    audioInit(); audio.ctx.resume?.();
    playing=true; startedAt=performance.now()/1000;
    scheduleNotes();
    rafId=requestAnimationFrame(tick);
  }
  function stop(){
    playing=false; if(rafId) cancelAnimationFrame(rafId); rafId=null;
    for (const v of scheduled) { try { v.osc.stop(); } catch {} }
    scheduled.length = 0;
    clearLightingTimers(true); allNotesOff(); drawRoll();
    if (loopTimer) { clearTimeout(loopTimer); loopTimer=null; }
  }

  // Playback clock in QUARTERS: qElapsed = secondsElapsed * (BPM/60)
  function tick(){
    const secondsElapsed = (performance.now()/1000 - startedAt);
    const qElapsed = secondsElapsed * quartersPerSecond();
    if(totalQ>0 && qElapsed>=totalQ) { 
      if(loopCb?.checked){ stop(); start(); return; } 
      else { stop(); return; }
    }
    drawRoll(); drawPlayhead(Math.min(qElapsed,totalQ));
    rafId=requestAnimationFrame(tick);
  }

  playBtn?.addEventListener('click', start);
  stopBtn?.addEventListener('click', stop);

  // Live BPM slider
  bpmSlider?.addEventListener('input', (e) => {
    bpmVal.textContent = String(Number(e.target.value) || defaultBPM);
    if (playing) { stop(); start(); } // re-sync schedules at new BPM
  });

  // ---------- OSMD ----------
  let osmd=null;
  async function renderXML(text){
    if(!osmd) osmd=new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd',{drawingParameters:'compact'});
    await osmd.load(text); 
    await osmd.render();
  }

  // Detect BPM from XML (only if no ?bpm=)
  async function detectTempoFromXMLText(text){
    try{
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
          let dotFactor = 1; for (let k=1;k<=dots;k++) dotFactor += Math.pow(0.5, k);
          const beatInQuarters = base * dotFactor;
          const qpm = perMin * beatInQuarters;
          return Math.max(1, Math.round(qpm));
        }
      }
    }catch(_){}
    return null;
  }

  // Parse MusicXML to notes in QUARTERS
  async function parseXMLtoQuarters(text){
    const xml=new DOMParser().parseFromString(text,"application/xml");
    const stepToSemitone={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
    const parts=[...xml.querySelectorAll("part")];
    const out=[];
    for(const part of parts){
      let divisions = 1;
      let timeQ = 0; // in quarters
      for(const measure of part.querySelectorAll("measure")){
        const d = measure.querySelector("divisions");
        if (d) divisions = Number(d.textContent) || divisions;
        const qPerDiv = 1 / divisions;

        for(const node of measure.children){
          if (node.tagName === 'backup') {
            const durDiv = Number(node.querySelector('duration')?.textContent || 0);
            timeQ = Math.max(0, timeQ - durDiv * qPerDiv);
            continue;
          }
          if (node.tagName === 'forward') {
            const durDiv = Number(node.querySelector('duration')?.textContent || 0);
            timeQ += durDiv * qPerDiv;
            continue;
          }
          if (node.tagName !== 'note') continue;

          const isRest = node.querySelector('rest') !== null;
          const isChordFollower = node.querySelector('chord') !== null;
          const durDiv = Number(node.querySelector('duration')?.textContent || 0);
          const durQ = durDiv * qPerDiv;

          if (!isRest) {
            const step = node.querySelector("step")?.textContent;
            const alter = Number(node.querySelector("alter")?.textContent || 0);
            const oct = Number(node.querySelector("octave")?.textContent);
            if (step && Number.isFinite(oct)) {
              const midi = 12*(oct+1) + stepToSemitone[step] + alter;
              const qs = timeQ;
              const qe = qs + durQ;
              if (qe > qs) out.push({ p:midi, qs, qe });
            }
          }
          if (!isChordFollower) timeQ += durQ;
        }
      }
    }
    // merge parts, sort
    out.sort((a,b)=>a.qs - b.qs);
    notes = out;
    totalQ = notes.length ? Math.max(...notes.map(n=>n.qe)) : 0;
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
          if (bpmSlider) bpmSlider.value = String(detected);
          if (bpmVal) bpmVal.textContent = String(detected);
          log('⏱ Tempo aus MusicXML:', detected, 'BPM');
        } else {
          log('⏱ Kein Tempo in XML gefunden – Standard bleibt', currentBPM(), 'BPM');
        }
      } else {
        log('⏱ Tempo via URL festgelegt:', currentBPM(), 'BPM (überschreibt XML)');
      }

      await renderXML(txt);
      await parseXMLtoQuarters(txt);

      playBtn.disabled=stopBtn.disabled=!notes.length;
      drawRoll();
    }catch(e){ 
      log('XML load error: '+(e?.message||e)); 
    }
  }

  // Startup
  setTimeout(()=>{ log('HTTP-Served?', location.protocol.startsWith('http') ? 'ja' : 'nein'); },0);
  loadFromURL();
});
