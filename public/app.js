/* ============================================================
   TwangAI – Client-side logic (100% Browser Processing)
   - FFT Engine in pure Javascript
   - Voice Onset Detection in pure Javascript
   - Audio conversion in browser using ffmpeg.wasm
   - Live mic analysis using Web Audio API (ScriptProcessor)
   - Premium Glassmorphism UI & Canvas Animations
   ============================================================ */

// ── State & Config ───────────────────────────────────────────────────────────
const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;
const HOP_SIZE = 512;

let audioCtx = null;
let mediaStream = null;
let scriptProcessor = null;
let micRunning = false;
let scoreHistory = [];
const MAX_HISTORY = 60;
let lastMags = null;

// ── Twang Analysis Engine (Pure JS) ───────────────────────────────────────────

function computeFFT(samples) {
  const N = FFT_SIZE;
  const real = new Float64Array(N);
  const imag = new Float64Array(N);
  for (let i = 0; i < N && i < samples.length; i++) {
    // Hann window
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    real[i] = samples[i] * w;
  }
  fftInPlace(real, imag, N);
  const mags = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mags;
}

function fftInPlace(re, im, N) {
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function freqToBin(freq, sampleRate, fftSize) {
  return Math.round((freq / sampleRate) * fftSize);
}

function bandEnergy(mags, fLow, fHigh, sampleRate) {
  const N = mags.length * 2;
  const lo = freqToBin(fLow, sampleRate, N);
  const hi = freqToBin(fHigh, sampleRate, N);
  let energy = 0;
  for (let i = lo; i <= hi && i < mags.length; i++) {
    energy += mags[i] * mags[i];
  }
  return energy;
}

function peakFreqInBand(mags, fLow, fHigh, sampleRate) {
  const N = mags.length * 2;
  const lo = freqToBin(fLow, sampleRate, N);
  const hi = freqToBin(fHigh, sampleRate, N);
  let maxMag = 0, maxBin = lo;
  for (let i = lo; i <= hi && i < mags.length; i++) {
    if (mags[i] > maxMag) {
      maxMag = mags[i];
      maxBin = i;
    }
  }
  return (maxBin / N) * sampleRate;
}

function isVoiceActive(samples, threshold = 0.008) {
  let rms = 0;
  for (let s of samples) rms += s * s;
  return Math.sqrt(rms / samples.length) > threshold;
}

function analyzeTwang(samples, sampleRate = SAMPLE_RATE) {
  const mags = computeFFT(samples);
  const totalEnergy = bandEnergy(mags, 80, 8000, sampleRate);
  if (totalEnergy < 1e-10) return null;

  const twangScore = Math.min(100, (bandEnergy(mags, 2000, 4000, sampleRate) / totalEnergy) * 600);
  const f1Freq = peakFreqInBand(mags, 400, 1200, sampleRate);
  const f1Score = Math.min(100, Math.max(0, ((f1Freq - 400) / 800) * 100));
  const midScore = Math.min(100, (bandEnergy(mags, 1000, 2500, sampleRate) / totalEnergy) * 350);
  const lowEnergy = bandEnergy(mags, 80, 1000, sampleRate);
  const brillianceScore = Math.min(100, (lowEnergy > 0 ? bandEnergy(mags, 3000, 6000, sampleRate) / lowEnergy : 0) * 300);

  const composite = twangScore * 0.40 + f1Score * 0.25 + midScore * 0.20 + brillianceScore * 0.15;

  return {
    score: Math.round(composite * 10) / 10,
    components: {
      twangBand: Math.round(twangScore * 10) / 10,
      f1Elevation: Math.round(f1Score * 10) / 10,
      midConcentration: Math.round(midScore * 10) / 10,
      brilliance: Math.round(brillianceScore * 10) / 10,
    },
    f1Freq: Math.round(f1Freq),
    spectralBands: {
      sub:  bandEnergy(mags, 80, 300, sampleRate) / totalEnergy,
      low:  bandEnergy(mags, 300, 800, sampleRate) / totalEnergy,
      mid:  bandEnergy(mags, 800, 2000, sampleRate) / totalEnergy,
      high: bandEnergy(mags, 2000, 4000, sampleRate) / totalEnergy,
      air:  bandEnergy(mags, 4000, 8000, sampleRate) / totalEnergy,
    },
    mags: Array.from(mags).slice(0, 512),
  };
}

function detectVoiceOnset(samples, sampleRate, windowMs = 50, thresholdMultiplier = 3) {
  const windowSize = Math.round(sampleRate * windowMs / 1000);
  
  const rmsValues = [];
  for (let i = 0; i + windowSize < samples.length; i += windowSize) {
    let rms = 0;
    for (let j = 0; j < windowSize; j++) rms += samples[i + j] ** 2;
    rmsValues.push(Math.sqrt(rms / windowSize));
  }

  const baselineWindows = Math.ceil(500 / windowMs);
  const baseline = rmsValues.slice(0, baselineWindows).reduce((a, b) => a + b, 0) / baselineWindows;
  const threshold = baseline * thresholdMultiplier + 0.005;

  for (let i = baselineWindows; i < rmsValues.length - 2; i++) {
    if (rmsValues[i] > threshold && rmsValues[i+1] > threshold && rmsValues[i+2] > threshold) {
      return i * windowSize;
    }
  }
  return 0;
}

// ── UI Utilities ──────────────────────────────────────────────────────────────

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

// ── File Analysis (ffmpeg.wasm in Browser) ────────────────────────────────────
let ffmpegInstance = null;

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  const { createFFmpeg } = FFmpeg;
  ffmpegInstance = createFFmpeg({
    corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    log: false
  });
  await ffmpegInstance.load();
  return ffmpegInstance;
}

async function analyzeFile() {
  const btn = document.getElementById('analyzeBtn');
  const btnText = document.getElementById('analyzeBtnText');
  const spinner = document.getElementById('analyzeSpinner');
  const results = document.getElementById('fileResults');

  btn.disabled = true;
  btnText.textContent = 'Inițializare WASM...';
  spinner.classList.remove('hidden');
  results.classList.add('hidden');

  try {
    // 1. Get FFmpeg WebAssembly instance
    const ffmpeg = await getFFmpeg();

    // 2. Fetch the audio file
    btnText.textContent = 'Descărcare audio...';
    const response = await fetch('/audio/sample.mp4');
    if (!response.ok) throw new Error('Nu s-a putut încărca sample.mp4 de pe server.');
    const arrayBuffer = await response.arrayBuffer();

    // 3. Process the file client-side using ffmpeg.wasm
    btnText.textContent = 'Conversie WASM...';
    ffmpeg.FS('writeFile', 'input.mp4', new Uint8Array(arrayBuffer));
    await ffmpeg.run('-i', 'input.mp4', '-ac', '1', '-ar', '44100', '-f', 'wav', '-acodec', 'pcm_s16le', 'output.wav');

    // 4. Read the converted WAV bytes
    const wavData = ffmpeg.FS('readFile', 'output.wav');

    // 5. Decode using browser's AudioContext (Web Audio API)
    btnText.textContent = 'Decodare audio...';
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await tempCtx.decodeAudioData(wavData.buffer.slice(0));
    const samples = audioBuf.getChannelData(0);
    const sampleRate = audioBuf.sampleRate;

    // 6. Voice onset detection
    btnText.textContent = 'Detecție debut...';
    const onsetSample = detectVoiceOnset(samples, sampleRate);
    const onsetTime = onsetSample / sampleRate;

    // 7. Perform frame-by-frame analysis
    btnText.textContent = 'Analiză twang...';
    const frameResults = [];
    const effectiveSamples = samples.slice(onsetSample);

    for (let i = 0; i + FFT_SIZE < effectiveSamples.length; i += HOP_SIZE) {
      const frame = effectiveSamples.slice(i, i + FFT_SIZE);
      
      // Only process voiced frames
      if (!isVoiceActive(frame, 0.008)) continue;

      const analysis = analyzeTwang(frame, sampleRate);
      if (analysis) {
        frameResults.push({
          time: (onsetSample + i) / sampleRate,
          score: analysis.score,
          components: analysis.components,
          f1Freq: analysis.f1Freq
        });
      }
    }

    if (frameResults.length === 0) {
      throw new Error('Nu s-a detectat voce activă în fișier.');
    }

    // 8. Calculate aggregate metrics
    const scores = frameResults.map(r => r.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const maxScore = Math.max(...scores);
    const avgRounded = Math.round(avgScore * 10) / 10;
    const maxRounded = Math.round(maxScore * 10) / 10;

    // 9. Update UI with results
    setScoreRing(avgRounded);

    document.getElementById('statAvg').textContent = avgRounded;
    document.getElementById('statMax').textContent = maxRounded;
    document.getElementById('statOnset').textContent = onsetTime.toFixed(2) + 's';
    document.getElementById('statFrames').textContent = frameResults.length;

    results.classList.remove('hidden');

    // Draw timeline chart
    drawTimeline(frameResults);

  } catch (e) {
    console.error(e);
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

// ── Mic Analysis (100% Client-side Web Audio API) ─────────────────────────────
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

  scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioCtx.destination);

  micRunning = true;
  updateMicUI(true);
  console.log('🎤 Live mic analysis started client-side');

  let buffer = [];

  scriptProcessor.onaudioprocess = (e) => {
    if (!micRunning) return;
    const inputData = e.inputBuffer.getChannelData(0);
    
    // push samples to local buffer
    buffer.push(...inputData);

    // Process in FFT_SIZE chunks (without overlap, matching original WS logic)
    while (buffer.length >= FFT_SIZE) {
      const frame = new Float32Array(buffer.splice(0, FFT_SIZE));
      
      if (!isVoiceActive(frame, 0.008)) {
        setMicStatus('silence');
        // Clear/zero mags when silent so the spectrum canvas visualizer goes flat
        lastMags = new Float32Array(512);
        continue;
      }

      const analysis = analyzeTwang(frame, SAMPLE_RATE);
      if (analysis) {
        handleLiveAnalysis(analysis);
      }
    }
  };

  // Start spectrum animation
  animateSpectrum();
}

function stopMic() {
  micRunning = false;
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  updateMicUI(false);
  scoreHistory = [];
  lastMags = null;
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
  if (ind) {
    ind.className = 'mic-indicator ' + status;
  }
  const textMap = { idle: 'Microfon oprit', active: 'Ascultă...', silence: 'Silențiu detectat' };
  const statusText = document.getElementById('micStatusText');
  if (statusText) {
    statusText.textContent = textMap[status] || '';
  }
}

// ── Live Analysis Handler ─────────────────────────────────────────────────────

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
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  if (bar) bar.style.width = clamp(value, 0, 100) + '%';
  if (val) val.textContent = Math.round(value);
}

// ── Spectrum Canvas ───────────────────────────────────────────────────────────
let spectrumAnimId = null;

function animateSpectrum() {
  const canvas = document.getElementById('spectrumCanvas');
  if (!canvas) return;
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
  if (arc) {
    arc.style.strokeDasharray = CIRCUMFERENCE;
    arc.style.strokeDashoffset = CIRCUMFERENCE;
  }

  // Pre-load FFmpeg in background so it's ready when user clicks "Analizează Fișierul"
  getFFmpeg().catch(err => console.warn('FFmpeg pre-load warning:', err));
});
