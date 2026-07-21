const $ = (id) => document.getElementById(id);

const frequencyEl = $("frequency");
const noteEl = $("note");
const directionEl = $("direction");
const levelEl = $("level");
const statusEl = $("status");
const minEl = $("minFreq");
const avgEl = $("avgFreq");
const maxEl = $("maxFreq");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const resetBtn = $("resetBtn");

let audioContext = null;
let analyser = null;
let stream = null;
let buffer = null;
let rafId = null;
let isRunning = false;
let readings = [];
let recentStable = [];
let lastDisplayed = null;

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const SOLFEGE = ["Do", "Do♯", "Re", "Re♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"];

function frequencyToNote(freq) {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const index = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[index]}${octave}／${SOLFEGE[index]}`;
}

function classifyPitch(freq) {
  if (freq < 250) return "低音";
  if (freq < 600) return "中音";
  return "高音";
}

function updateStats() {
  if (!readings.length) {
    minEl.textContent = avgEl.textContent = maxEl.textContent = "--";
    return;
  }
  const min = Math.min(...readings);
  const max = Math.max(...readings);
  const avg = readings.reduce((a, b) => a + b, 0) / readings.length;
  minEl.textContent = Math.round(min);
  avgEl.textContent = Math.round(avg);
  maxEl.textContent = Math.round(max);
}

function resetDisplay() {
  readings = [];
  recentStable = [];
  lastDisplayed = null;
  frequencyEl.innerHTML = '-- <span>Hz</span>';
  noteEl.textContent = "等待聲音";
  directionEl.textContent = "●";
  levelEl.textContent = "尚未判斷";
  updateStats();
}

function autoCorrelate(data, sampleRate) {
  let rms = 0;
  for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / data.length);
  if (rms < 0.012) return -1;

  let start = 0;
  let end = data.length - 1;
  const threshold = 0.18;
  for (let i = 0; i < data.length / 2; i++) {
    if (Math.abs(data[i]) < threshold) { start = i; break; }
  }
  for (let i = 1; i < data.length / 2; i++) {
    if (Math.abs(data[data.length - i]) < threshold) { end = data.length - i; break; }
  }

  const sliced = data.slice(start, end);
  const size = sliced.length;
  const correlations = new Float32Array(size);
  for (let lag = 0; lag < size; lag++) {
    let sum = 0;
    for (let i = 0; i < size - lag; i++) sum += sliced[i] * sliced[i + lag];
    correlations[lag] = sum;
  }

  let dip = 0;
  while (dip + 1 < size && correlations[dip] > correlations[dip + 1]) dip++;

  let bestLag = -1;
  let bestValue = -Infinity;
  for (let lag = dip; lag < size; lag++) {
    if (correlations[lag] > bestValue) {
      bestValue = correlations[lag];
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return -1;

  let refinedLag = bestLag;
  if (bestLag > 0 && bestLag < size - 1) {
    const y1 = correlations[bestLag - 1];
    const y2 = correlations[bestLag];
    const y3 = correlations[bestLag + 1];
    const denom = 2 * (2 * y2 - y1 - y3);
    if (denom !== 0) refinedLag += (y3 - y1) / denom;
  }

  const frequency = sampleRate / refinedLag;
  if (frequency < 60 || frequency > 2000) return -1;
  return frequency;
}

function drawLoop() {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(buffer);
  const rawFreq = autoCorrelate(buffer, audioContext.sampleRate);

  if (rawFreq > 0) {
    recentStable.push(rawFreq);
    if (recentStable.length > 5) recentStable.shift();

    if (recentStable.length >= 3) {
      const sorted = [...recentStable].sort((a, b) => a - b);
      const stableFreq = sorted[Math.floor(sorted.length / 2)];

      if (lastDisplayed !== null) {
        const delta = stableFreq - lastDisplayed;
        if (Math.abs(delta) < 3) directionEl.textContent = "→";
        else directionEl.textContent = delta > 0 ? "↑" : "↓";
      } else {
        directionEl.textContent = "→";
      }

      lastDisplayed = stableFreq;
      readings.push(stableFreq);
      if (readings.length > 600) readings.shift();

      frequencyEl.innerHTML = `${Math.round(stableFreq)} <span>Hz</span>`;
      noteEl.textContent = frequencyToNote(stableFreq);
      levelEl.textContent = classifyPitch(stableFreq);
      statusEl.textContent = "正在測量";
      updateStats();
    }
  } else {
    statusEl.textContent = "請發出較清楚、持續的聲音";
  }

  rafId = requestAnimationFrame(drawLoop);
}

async function startMeasurement() {
  if (isRunning) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    buffer = new Float32Array(analyser.fftSize);
    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "正在測量";
    drawLoop();
  } catch (error) {
    console.error(error);
    statusEl.textContent = "無法使用麥克風，請在 Safari 設定中允許權限";
    alert("請允許此網站使用麥克風，再重新按「開始測量」。");
  }
}

async function stopMeasurement() {
  isRunning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach(track => track.stop());
  if (audioContext && audioContext.state !== "closed") await audioContext.close();

  stream = null;
  audioContext = null;
  analyser = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = readings.length ? "測量已停止" : "按「開始測量」，再發出一個持續的聲音";
}

startBtn.addEventListener("click", startMeasurement);
stopBtn.addEventListener("click", stopMeasurement);
resetBtn.addEventListener("click", resetDisplay);
window.addEventListener("pagehide", stopMeasurement);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
}
