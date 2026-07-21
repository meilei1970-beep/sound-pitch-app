const $ = (id) => document.getElementById(id);

const els = {
  frequency: $("frequency"), note: $("note"), direction: $("direction"), level: $("level"),
  status: $("status"), min: $("minFreq"), avg: $("avgFreq"), max: $("maxFreq"),
  tunerNote: $("tunerNote"), tunerSolfege: $("tunerSolfege"), tunerFreq: $("tunerFreq"),
  targetFreq: $("targetFreq"), needle: $("needle"), tuneMessage: $("tuneMessage"),
  tunerLabel: $("tunerLabel"),
  start: $("startBtn"), stop: $("stopBtn"), reset: $("resetBtn"),
  measureTab: $("measureTab"), tunerTab: $("tunerTab"),
  measurePanel: $("measurePanel"), tunerPanel: $("tunerPanel"),
  autoTuneMode: $("autoTuneMode"), targetTuneMode: $("targetTuneMode"),
  targetSelector: $("targetSelector"), targetNoteSelect: $("targetNoteSelect"),
  a4Select: $("a4Select")
};

let audioContext = null;
let analyser = null;
let stream = null;
let buffer = null;
let rafId = null;
let isRunning = false;
let mode = "measure";
let tunerMode = "auto";
let readings = [];
let recentStable = [];
let lastDisplayed = null;

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const SOLFEGE = ["Do", "Do♯", "Re", "Re♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"];

function getA4() {
  return Number(els.a4Select.value || 440);
}

function midiToInfo(midi) {
  const index = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const target = getA4() * Math.pow(2, (midi - 69) / 12);
  return { midi, index, octave, target, note: NOTE_NAMES[index], solfege: SOLFEGE[index] };
}

function getNearestNoteInfo(freq) {
  const exactMidi = 69 + 12 * Math.log2(freq / getA4());
  const midi = Math.round(exactMidi);
  const info = midiToInfo(midi);
  info.cents = 1200 * Math.log2(freq / info.target);
  return info;
}

function populateTargetNotes() {
  const previous = els.targetNoteSelect.value || "60";
  els.targetNoteSelect.innerHTML = "";
  // C3 至 C6，適合常見課堂樂器。
  for (let midi = 48; midi <= 84; midi++) {
    const info = midiToInfo(midi);
    const option = document.createElement("option");
    option.value = String(midi);
    option.textContent = `${info.note}${info.octave}／${info.solfege}　${info.target.toFixed(1)} Hz`;
    els.targetNoteSelect.appendChild(option);
  }
  els.targetNoteSelect.value = [...els.targetNoteSelect.options].some(o => o.value === previous) ? previous : "60";
}

function getSelectedTargetInfo() {
  return midiToInfo(Number(els.targetNoteSelect.value || 60));
}

function classifyPitch(freq) {
  if (freq < 250) return "低音";
  if (freq < 600) return "中音";
  return "高音";
}

function updateStats() {
  if (!readings.length) {
    els.min.textContent = els.avg.textContent = els.max.textContent = "--";
    return;
  }
  const min = Math.min(...readings);
  const max = Math.max(...readings);
  const avg = readings.reduce((a, b) => a + b, 0) / readings.length;
  els.min.textContent = Math.round(min);
  els.avg.textContent = Math.round(avg);
  els.max.textContent = Math.round(max);
}

function resetDisplay() {
  readings = [];
  recentStable = [];
  lastDisplayed = null;

  els.frequency.innerHTML = '-- <span>Hz</span>';
  els.note.textContent = "等待聲音";
  els.direction.textContent = "●";
  els.level.textContent = "尚未判斷";
  updateStats();

  els.tunerNote.textContent = "--";
  els.tunerSolfege.textContent = "等待聲音";
  els.tunerFreq.textContent = "-- Hz";
  els.targetFreq.textContent = "-- Hz";
  els.needle.style.left = "50%";
  els.tuneMessage.className = "tuneMessage neutral";
  els.tuneMessage.textContent = "請發出持續的單一聲音";

  if (tunerMode === "target") showSelectedTarget();
}

function setMode(nextMode) {
  mode = nextMode;
  const measure = mode === "measure";
  els.measurePanel.classList.toggle("hidden", !measure);
  els.tunerPanel.classList.toggle("hidden", measure);
  els.measureTab.classList.toggle("active", measure);
  els.tunerTab.classList.toggle("active", !measure);
  els.status.textContent = isRunning ? "正在測量" : "選擇功能後，按下開始";
}

function setTunerMode(nextMode) {
  tunerMode = nextMode;
  const isAuto = tunerMode === "auto";
  els.autoTuneMode.classList.toggle("active", isAuto);
  els.targetTuneMode.classList.toggle("active", !isAuto);
  els.targetSelector.classList.toggle("hidden", isAuto);
  els.tunerLabel.textContent = isAuto ? "最接近的音" : "指定的目標音";
  resetDisplay();
}

function showSelectedTarget() {
  const target = getSelectedTargetInfo();
  els.tunerNote.textContent = `${target.note}${target.octave}`;
  els.tunerSolfege.textContent = target.solfege;
  els.targetFreq.textContent = `${target.target.toFixed(1)} Hz`;
}

function autoCorrelate(data, sampleRate) {
  let rms = 0;
  for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / data.length);
  if (rms < 0.012) return -1;

  let start = 0, end = data.length - 1;
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

  let bestLag = -1, bestValue = -Infinity;
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
  return (frequency >= 60 && frequency <= 2000) ? frequency : -1;
}

function updateMeasure(freq) {
  const info = getNearestNoteInfo(freq);

  if (lastDisplayed !== null) {
    const delta = freq - lastDisplayed;
    els.direction.textContent = Math.abs(delta) < 3 ? "→" : (delta > 0 ? "↑" : "↓");
  } else {
    els.direction.textContent = "→";
  }

  lastDisplayed = freq;
  readings.push(freq);
  if (readings.length > 600) readings.shift();

  els.frequency.innerHTML = `${Math.round(freq)} <span>Hz</span>`;
  els.note.textContent = `${info.note}${info.octave}／${info.solfege}`;
  els.level.textContent = classifyPitch(freq);
  updateStats();
}

function updateTuner(freq) {
  let info;
  if (tunerMode === "auto") {
    info = getNearestNoteInfo(freq);
    els.tunerNote.textContent = `${info.note}${info.octave}`;
    els.tunerSolfege.textContent = info.solfege;
  } else {
    info = getSelectedTargetInfo();
    info.cents = 1200 * Math.log2(freq / info.target);
    els.tunerNote.textContent = `${info.note}${info.octave}`;
    els.tunerSolfege.textContent = info.solfege;
  }

  const clamped = Math.max(-50, Math.min(50, info.cents));
  els.needle.style.left = `${50 + clamped}%`;
  els.tunerFreq.textContent = `${freq.toFixed(1)} Hz`;
  els.targetFreq.textContent = `${info.target.toFixed(1)} Hz`;

  const abs = Math.abs(info.cents);
  if (tunerMode === "target" && abs > 100) {
    els.tuneMessage.className = "tuneMessage far";
    els.tuneMessage.textContent = info.cents < 0 ? "音差很多，請明顯調高" : "音差很多，請明顯調低";
  } else if (abs <= 5) {
    els.tuneMessage.className = "tuneMessage good";
    els.tuneMessage.textContent = "✓ 音準了";
  } else if (info.cents < 0) {
    els.tuneMessage.className = "tuneMessage low";
    els.tuneMessage.textContent = "↑ 音太低，請調高";
  } else {
    els.tuneMessage.className = "tuneMessage high";
    els.tuneMessage.textContent = "↓ 音太高，請調低";
  }
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
      const freq = sorted[Math.floor(sorted.length / 2)];

      els.status.textContent = "正在測量";
      if (mode === "measure") updateMeasure(freq);
      else updateTuner(freq);
    }
  } else {
    els.status.textContent = "請發出較清楚、持續的聲音";
  }

  rafId = requestAnimationFrame(drawLoop);
}

async function startMeasurement() {
  if (isRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    alert("此瀏覽器無法使用麥克風。請使用 Safari 或 Chrome，並確認網址為 HTTPS。");
    return;
  }

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
    els.start.disabled = true;
    els.stop.disabled = false;
    els.status.textContent = "正在測量";
    drawLoop();
  } catch (error) {
    console.error(error);
    els.status.textContent = "無法使用麥克風";
    alert("請允許此網站使用麥克風，再重新按「開始」。");
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
  els.start.disabled = false;
  els.stop.disabled = true;
  els.status.textContent = "已停止";
}

els.measureTab.addEventListener("click", () => setMode("measure"));
els.tunerTab.addEventListener("click", () => setMode("tuner"));
els.autoTuneMode.addEventListener("click", () => setTunerMode("auto"));
els.targetTuneMode.addEventListener("click", () => setTunerMode("target"));
els.targetNoteSelect.addEventListener("change", resetDisplay);
els.start.addEventListener("click", startMeasurement);
els.stop.addEventListener("click", stopMeasurement);
els.reset.addEventListener("click", resetDisplay);
els.a4Select.addEventListener("change", () => {
  populateTargetNotes();
  resetDisplay();
});
window.addEventListener("pagehide", stopMeasurement);

populateTargetNotes();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
}
