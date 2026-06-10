/* ============================================================
   TwangAI – Client-side logic
   - Score ring animation
   - File analysis via REST
   - Live mic analysis via WebSocket + Web Audio API
   - Canvas charts: timeline + spectrum
   ============================================================ */

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws = null;

// ── State ─────────────────────────────────────────────────────────────────────
let audioCtx = null;
let mediaStream = null;
let scriptProcessor = null;
let micRunning = false;
let scoreHistory = [];
const MAX_HISTORY = 60;

// ── Utility ───────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getTwangLabel(score) {
  if (score < 20) return 'Voce Neutră';
  if (score < 35) return 'Ușor Twang';
  if (score < 55) return 'Twang Moderat';
  if (score < 70) return 'Twang Clar';
  if (score < 85) return 'Twang Puternic';
  return 'Twang Maxim 🔥';
}

function getTwangColor(score) {
  if (score < 30) return '#64748b';
  if (score < 50) return '#22d3ee';
  if (score < 70) return '#a78bfa';
  if (score < 85) return '#ec4899';
  return '#f97316';
}

// ── Score Ring ────────────────────────────────────────────────────────────────
const CIRCUMFERENCE = 2 * Math.PI * 95; // r=95

function setScoreRing(score) {
  const arc = document.getElementById('scoreArc');
  const numEl = document.getElementById('mainScore');
  const badge = document.getElementById('scoreBadge');

  const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
  arc.style.strokeDashoffset = offset;

  numEl.textContent = Math.round(score);
  badge.textContent = getTwangLabel(score);

  const color = getTwangColor(score);
  badge.style.color = color;
  badge.style.borderColor = color + '40';
  badge.style.background = color + '15';

  // Animate number
  numEl.style.transition = 'all 0.3s';
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('filePanel').classList.toggle('active', tab === 'file');
  document.getElementById('filePanel').classList.toggle('hidden', tab !== 'file');
  document.getElementById('micPanel').classList.toggle('active', tab === 'mic');
  document.getElementById('micPanel').classList.toggle('hidden', tab !== 'mic');

  document.getElementById('tabFile').classList.toggle('active', tab === 'file');
  document.getElementById('tabMic').classList.toggle('active', tab === 'mic');

  if (tab === 'file' && micRunning) stopMic();
}

// ── File Analysis ─────────────────────────────────────────────────────────────
async function analyzeFile() {
  const btn = document.getElementById('analyzeBtn');
  const btnText = document.getElementById('analyzeBtnText');
  const spinner = document.getElementById('analyzeSpinner');
  const results = document.getElementById('fileResults');

  btn.disabled = true;
  btnText.textContent = 'Analizez...';
  spinner.classList.remove('hidden');
  results.classList.add('hidden');

  try {
    const res = await fetch('/api/analyze-file');
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    // Update hero score with avg
    setScoreRing(data.avgScore);

    // Stats
    document.getElementById('statAvg').textContent = data.avgScore;
    document.getElementById('statMax').textContent = data.maxScore;
    document.getElementById('statOnset').textContent = data.onsetTime.toFixed(2) + 's';
    document.getElementById('statFrames').textContent = data.totalFrames;

    results.classList.remove('hidden');

    // Draw timeline
    drawTimeline(data.results);

  } catch (e) {
    alert('Eroare: ' + e.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Analizează din Nou';
    spinner.classList.add('hidden');
  }
}

// ── Timeline Chart ────────────────────────────────────────────────────────────
function drawTimeline(results) {
  const canvas = document.getElementById('timelineChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 40;
  const H = 140;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);

  if (!results || results.length === 0) return;

  const scores = results.map(r => r.score);
  const maxT = results[results.length - 1].time;
  const minT = results[0].time;
  const tRange = maxT - minT || 1;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = H - (i / 4) * H;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '10px Inter';
    ctx.fillText((i * 25).toString(), 4, y - 2);
  }

  // Smooth line using bezier
  const pts = results.map(r => ({
    x: ((r.time - minT) / tRange) * (W - 20) + 10,
    y: H - (r.score / 100) * (H - 10) - 5,
  }));

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(167,139,250,0.3)');
  grad.addColorStop(1, 'rgba(167,139,250,0)');

  ctx.beginPath();
  ctx.moveTo(pts[0].x, H);
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cp1x = (pts[i - 1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cp1x, pts[i - 1].y, cp1x, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.lineTo(pts[pts.length - 1].x, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cp1x = (pts[i - 1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cp1x, pts[i - 1].y, cp1x, pts[i].y, pts[i].x, pts[i].y);
  }
  const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
  lineGrad.addColorStop(0, '#a78bfa');
  lineGrad.addColorStop(0.5, '#ec4899');
  lineGrad.addColorStop(1, '#f97316');
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Time labels
  const tLabelCount = 5;
  for (let i = 0; i <= tLabelCount; i++) {
    const t = minT + (i / tLabelCount) * tRange;
    const x = (i / tLabelCount) * (W - 20) + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(t.toFixed(1) + 's', x, H - 2);
  }
}

// ── Mic Analysis ──────────────────────────────────────────────────────────────
async function startMic() {
  if (micRunning) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert('Nu pot accesa microfonul: ' + e.message);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
  const source = audioCtx.createMediaStreamSource(mediaStream);

  // Use ScriptProcessor (legacy, works everywhere without worker)
  scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioCtx.destination);

  // WebSocket
  ws = new WebSocket(`${wsProtocol}//${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    micRunning = true;
    updateMicUI(true);
    console.log('WS connected');
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'analysis') {
      handleLiveAnalysis(msg);
    } else if (msg.type === 'silence') {
      setMicStatus('silence');
    }
  };

  ws.onclose = () => { micRunning = false; updateMicUI(false); };

  scriptProcessor.onaudioprocess = (e) => {
    if (!micRunning || ws.readyState !== WebSocket.OPEN) return;
    const inputData = e.inputBuffer.getChannelData(0);
    const f32 = new Float32Array(inputData);
    ws.send(f32.buffer);
  };

  // Start spectrum animation
  animateSpectrum();
}

function stopMic() {
  micRunning = false;
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (ws) { ws.close(); ws = null; }
  updateMicUI(false);
  scoreHistory = [];
}

function updateMicUI(running) {
  document.getElementById('micStartBtn').classList.toggle('hidden', running);
  document.getElementById('micStopBtn').classList.toggle('hidden', !running);
  document.getElementById('liveComponents').classList.toggle('hidden', !running);
  setMicStatus(running ? 'active' : 'idle');
  if (!running) {
    document.getElementById('micStatusText').textContent = 'Microfon oprit';
  }
}

function setMicStatus(status) {
  const ind = document.getElementById('micIndicator');
  ind.className = 'mic-indicator ' + status;
  const textMap = { idle: 'Microfon oprit', active: 'Ascultă...', silence: 'Silențiu detectat' };
  document.getElementById('micStatusText').textContent = textMap[status] || '';
}

// ── Live Analysis Handler ─────────────────────────────────────────────────────
let lastMags = null;

function handleLiveAnalysis(msg) {
  setMicStatus('active');
  setScoreRing(msg.score);
  lastMags = msg.mags;

  // Update component bars
  const c = msg.components;
  updateBar('barTwang', 'valTwang', c.twangBand);
  updateBar('barF1', 'valF1', c.f1Elevation);
  updateBar('barMid', 'valMid', c.midConcentration);
  updateBar('barBrill', 'valBrill', c.brilliance);

  // F1 freq
  document.getElementById('f1Val').textContent = msg.f1Freq;

  // History
  scoreHistory.push(msg.score);
  if (scoreHistory.length > MAX_HISTORY) scoreHistory.shift();
}

function updateBar(barId, valId, value) {
  document.getElementById(barId).style.width = clamp(value, 0, 100) + '%';
  document.getElementById(valId).textContent = Math.round(value);
}

// ── Spectrum Canvas ───────────────────────────────────────────────────────────
let spectrumAnimId = null;

function animateSpectrum() {
  const canvas = document.getElementById('spectrumCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 48;
  const H = 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  function draw() {
    if (!micRunning) return;
    spectrumAnimId = requestAnimationFrame(draw);

    ctx.clearRect(0, 0, W, H);

    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = (i / 4) * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    if (!lastMags) {
      // Idle animation: random noise bars
      for (let i = 0; i < 80; i++) {
        const h = Math.random() * 8 + 2;
        const x = (i / 80) * W;
        const bw = W / 80 - 1;
        ctx.fillStyle = 'rgba(167,139,250,0.15)';
        ctx.fillRect(x, H - h, bw, h);
      }
      return;
    }

    const bins = lastMags.length;
    const barW = Math.max(1, W / bins - 0.5);
    const maxMag = Math.max(...lastMags) || 1;

    for (let i = 0; i < bins; i++) {
      const h = (lastMags[i] / maxMag) * (H - 8);
      if (h < 1) continue;
      const x = (i / bins) * W;
      const freq = (i / bins) * 22050;

      // Color by frequency region
      let color;
      if (freq < 1000) color = '#22d3ee';
      else if (freq < 2000) color = '#a78bfa';
      else if (freq < 4000) color = '#ec4899';
      else color = '#f97316';

      // Gradient bar
      const grad = ctx.createLinearGradient(0, H - h, 0, H);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '20');
      ctx.fillStyle = grad;
      ctx.fillRect(x, H - h, barW, h);
    }

    // Overlay twang band indicator
    const twangLo = (2000 / 22050) * W;
    const twangHi = (4000 / 22050) * W;
    ctx.fillStyle = 'rgba(236,72,153,0.06)';
    ctx.fillRect(twangLo, 0, twangHi - twangLo, H);
    ctx.strokeStyle = 'rgba(236,72,153,0.3)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(twangLo, 0); ctx.lineTo(twangLo, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(twangHi, 0); ctx.lineTo(twangHi, H); ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle = 'rgba(236,72,153,0.5)';
    ctx.font = '9px Inter';
    ctx.fillText('Twang Band', twangLo + 4, 12);
  }

  draw();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Set ring circumference
  const arc = document.getElementById('scoreArc');
  arc.style.strokeDasharray = CIRCUMFERENCE;
  arc.style.strokeDashoffset = CIRCUMFERENCE;

  // Resize timeline on window resize
  window.addEventListener('resize', () => {
    const results = document.getElementById('fileResults');
    if (!results.classList.contains('hidden')) {
      // redraw if data available
    }
  });
});
