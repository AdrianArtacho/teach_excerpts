/* app.js — Visualizer logic */
const log = (...a) => {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent += a.join(' ') + '\n';
  el.scrollTop = el.scrollHeight;
};

document.addEventListener('DOMContentLoaded', async () => {
  // ---------- URL params ----------
  const params = new URLSearchParams(location.search);

  // Title flag
  const titleFlag = params.get('title');
  if (titleFlag) {
    const titleText = document.getElementById('titleText');
    if (titleText) titleText.textContent = titleFlag;
  }

  // Hide log flag
  if (params.get('hideLog') === '1') {
    const logBlock = document.getElementById('status');
    if (logBlock) logBlock.style.display = 'none';
    const logHeading = document.querySelector('h3');
    if (logHeading) logHeading.style.display = 'none';
  }

  // Loop default flag
  const loopCb = document.getElementById('loop');
  if (loopCb && params.get('loop') === '1') {
    loopCb.checked = true;
  }

  // BPM flag
  let scoreBPM = 100;
  const bpmSlider = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  if (params.get('bpm')) {
    scoreBPM = Number(params.get('bpm'));
    bpmSlider.value = String(scoreBPM);
    bpmVal.textContent = String(scoreBPM);
  }

  // Transpose visual flag
  const transposeVis = parseInt(params.get('transposeVis') || "0", 10);

  // ---------- UI ----------
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const testBtn = document.getElementById('testTone');
  const panicBtn = document.getElementById('panic');
  const kb = document.getElementById('kb');
  const rollCv = document.getElementById('roll');
  const ctx = rollCv.getContext('2d');
  const osmdDiv = document.getElementById('osmd');
  osmdDiv.innerHTML = ""; // clear placeholder

  if (window.customElements?.whenDefined) {
    try { await customElements.whenDefined('all-around-keyboard'); } catch {}
  }

  // ---------- State ----------
  let notes = [];   // parsed from XML
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
  testBtn.addEventListener('click', () => {
    audioInit();
    audio.ctx.resume?.().then(()=>{
      log('Test resume state=' + audio.ctx.state);
      const v = mkVoice(440, 0.2);
      v.osc.start();
      v.osc.stop(audio.ctx.currentTime + 0.3);
    });
  });
  panicBtn.addEventListener('click', ()=>{ allNotesOff(); log('⏹ Panic: all voices stopped.'); });

  // ---------- Keyboard handling ----------
  const MIDI_BASE_FOR_LAYOUT = 24;
  function midiFromKbEvent(e) {
    let m = e?.detail?.midi ?? e?.detail?.note ?? e?.detail;
    if (typeof m === 'number' && Number.isFinite(m)) return Math.round(m);
    const idx = e?.detail?.index ?? e?.detail?.keyIndex ?? e?.index;
    if (typeof idx === 'number' && Number.isFinite(idx)) return Math.round(MIDI_BASE_FOR_LAYOUT + idx);
    return null;
  }
  const isValidMidi = m => Number.isInteger(m) && m >= 0 && m <= 127;

  // Manual keys: apply inverse transpose for sound
  kb.addEventListener('noteon', e => {
    const m = midiFromKbEvent(e);
    if (isValidMidi(m)) noteOn(m - transposeVis, 0.7);
  });
  ['noteoff','noteOff','keyrelease'].forEach(ev=>{
    kb.addEventListener(ev, e => {
      const m = midiFromKbEvent(e);
      if (isValidMidi(m)) noteOff(m - transposeVis);
    });
  });
  kb.addEventListener('keypress', e => {
    const m = midiFromKbEvent(e);
    if (isValidMidi(m)) noteOn(m - transposeVis, 0.7);
  });

  // Lighting helpers (apply transpose)
  function lightMidi(m){ 
    const visMidi = m + transposeVis;
    const idx = visMidi - MIDI_BASE_FOR_LAYOUT;
    if (typeof kb.keysLight==='function') kb.keysLight([idx]);
  }
  function dimMidi(m){   
    const visMidi = m + transposeVis;
    const idx = visMidi - MIDI_BASE_FOR_LAYOUT;
    if (typeof kb.keysDim==='function') kb.keysDim([idx]);
  }

  // ---------- Piano roll ----------
  function drawRoll(){
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
    if(total<=0) return; const pad=6;
    const x=pad+(rollCv.width-2*pad)*(Math.min(t,total)/total);
    ctx.strokeStyle='#e74c3c'; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,rollCv.height); ctx.stroke();
  }

  // ---------- Scheduling ----------
  function clearLightingTimers(andDim=false){
    for (const id of lightTimers) clearTimeout(id);
    lightTimers.length = 0;
    if (andDim && typeof kb.keysDim==='function') kb.keysDim([...Array(88).keys()]);
  }
  function scheduleNotesAtTempo(){
    const scale = scoreBPM / Number(bpmSlider.value); 
    const startBase = audio.ctx.currentTime + 0.03;
    for (const n of notes) {
      const s = n.s * scale;
      const d = (n.e - n.s) * scale;
      if (d <= 0) continue;
      // audio
      const v = mkVoice(midiToFreq(n.p), 0.22);
      v.osc.start(startBase + s);
      v.gain.gain.setTargetAtTime(0.0001, startBase + s + d, 0.02);
      v.osc.stop(startBase + s + d + 0.03);
      scheduled.push(v);
      // lights
      lightTimers.push(setTimeout(()=>lightMidi(n.p), (startBase+s-audio.ctx.currentTime)*1000));
      lightTimers.push(setTimeout(()=>dimMidi(n.p), (startBase+s+d-audio.ctx.currentTime)*1000));
    }
  }

  function start(){
    if(!notes.length||playing) return;
    audioInit(); audio.ctx.resume?.();
    playing=true; startedAt=performance.now()/1000; t0=0;
    scheduleNotesAtTempo();
    rafId=requestAnimationFrame(tick);
  }
  function stop(){
    playing=false; if(rafId) cancelAnimationFrame(rafId); rafId=null; t0=0;
    clearLightingTimers(true); allNotesOff(); drawRoll();
  }
  function tick(){
    const t = t0 + (performance.now()/1000 - startedAt) * (Number(bpmSlider.value)/scoreBPM);
    if(total>0 && t>=total) { if(loopCb.checked){ start(); } else { stop(); return; } }
    drawRoll(); drawPlayhead(Math.min(t,total));
    rafId=requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  // ---------- OSMD ----------
  let osmd=null;
  async function renderXML(text){
    if(!osmd) osmd=new opensheetmusicdisplay.OpenSheetMusicDisplay('osmd',{drawingParameters:'compact'});
    await osmd.load(text); await osmd.render();
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
    notes=collected; total=Math.max(...notes.map(n=>n.e),0);
  }

  // ---------- URL loader ----------
  async function loadFromURL(){
    const xmlUrl=params.get('xml');
    if(!xmlUrl) return;
    try{
      const res=await fetch(xmlUrl);
      const txt=await res.text();
      await renderXML(txt);
      await parseXML(txt);
      playBtn.disabled=stopBtn.disabled=!notes.length;
      drawRoll();
    }catch(e){ log('XML load error: '+e.message); }
  }

  loadFromURL();
});
