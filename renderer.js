const canvas = document.querySelector('#visualizer');
const ctx = canvas.getContext('2d');
const status = document.querySelector('#status');
const widgetEl = document.querySelector('#widget');
const compactBars = document.querySelector('#compactBars');
const trackTitle = document.querySelector('#trackTitle');
const cover = document.querySelector('#cover');
const art = document.querySelector('.art');
const trackCopy = document.querySelector('#trackCopy');
const playPause = document.querySelector('#playPause');
const morphIcon = document.querySelector('#morphIcon');
const asciiDisplay = document.querySelector('#asciiDisplay');
const asciiRotator = document.querySelector('#asciiRotator');
const outputToggle = document.querySelector('#outputToggle');
let visualizerType = 'bars';
let timeData;
let isPlaying = false;
let morphPoints = null;
let asciiTimer;
let asciiColumns = 12;
let currentAsciiUrl = '';
let currentAsciiSettings;
let asciiTargetWidth = 76;
let asciiTargetHeight = 43;
let asciiGeneration = 0;
let analyser, data, running = false, captureStream, connecting = false;
let spotifyAudioActive = false;
let visualizerGain = 0;
let pendingTrackDirection = 'next';
let displayedTrackKey = '';
let trackTransitionGeneration = 0;
let bassAnalyser, bassData, bassFirstBin, bassLastBin, audioContext;
let drawFrame;
let bassAverage = 0, bassPrevious = 0, bassReady = false;
let bassTimestamp = 0, lastBassBeat = -Infinity;
let coverPulseStart = -Infinity;
let bassSensitivity = 50;
let bassMethod = true, spectralMethod = true, rhythmMethod = true;
let spectralPrevious, spectralLastBin;
let fluxAverage = [0, 0, 0];
let rhythmHistory = [], rhythmPeriod = 0, rhythmAnchor = 0;
let predictedRhythmBeat = 0;
let beatDetector = 'aubiojs';
let aubioModule, aubioTempo, beatProcessor;
let aubioNeedsReset = true;
const aubioReady = Promise.resolve().then(() => {
  if (typeof aubio !== 'function') throw new Error('aubiojs script unavailable');
  return aubio();
}).then(module => { aubioModule = module; return module; }).catch(error => {
  console.error('aubiojs initialization failed:', error);
  art.title = 'aubiojs не загрузился. Выберите «Бас» в настройках.';
  return null;
});

function disposeAubio() {
  if (beatProcessor) { beatProcessor.onaudioprocess = null; beatProcessor.disconnect(); beatProcessor = null; }
  if (aubioTempo) { aubioTempo.delete(); aubioTempo = null; }
  aubioNeedsReset = true;
}

function connectBeatProcessor(source, audio) {
  // Process consecutive PCM samples rather than repeated FFT snapshots from animation frames.
  beatProcessor = audio.createScriptProcessor(1024, 2, 1);
  const mono = new Float32Array(512);
  beatProcessor.onaudioprocess = event => {
    if (!running || beatDetector !== 'aubiojs' || !spotifyAudioActive || !bassSensitivity || widgetEl.classList.contains('compact')) {
      aubioNeedsReset = true;
      return;
    }
    if (aubioNeedsReset) {
      if (aubioTempo) aubioTempo.delete();
      aubioTempo = new aubioModule.Tempo(4096, 512, audio.sampleRate);
      aubioNeedsReset = false;
    }
    const left = event.inputBuffer.getChannelData(0);
    const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
    for (let offset = 0; offset < left.length; offset += 512) {
      let power = 0;
      const gain = 2 ** ((bassSensitivity - 50) / 25);
      for (let i = 0; i < 512; i++) {
        const value = (left[offset + i] + right[offset + i]) * .5;
        power += value * value;
        mono[i] = value * gain;
      }
      const beat = aubioTempo.do(mono);
      const now = performance.now();
      if (beat > 0 && Math.sqrt(power / 512) > .002 / gain && now - lastBassBeat >= 180) {
        lastBassBeat = coverPulseStart = now;
      }
    }
  };
  source.connect(beatProcessor);
  // The output stays zero: keep the analysis callback alive without replaying captured audio.
  beatProcessor.connect(audio.destination);
}

function followBassPattern(now, energy, thresholdFactor) {
  if (!rhythmMethod || !bassMethod || !rhythmPeriod) return false;
  // Coast for one missing beat only, and only while bass is still audible.
  if (now - rhythmAnchor > rhythmPeriod * 1.6) {
    rhythmPeriod = 0;
    rhythmHistory = [];
    predictedRhythmBeat = 0;
    return false;
  }
  if (energy < .002 * thresholdFactor) return false;
  const expected = rhythmAnchor + rhythmPeriod;
  if (now < expected + 45 || now - expected > 100 || predictedRhythmBeat === rhythmAnchor) return false;
  predictedRhythmBeat = rhythmAnchor;
  return true;
}

function confirmRhythm(now) {
  // Learn phase and tempo from real attacks; predicted beats never train the tracker.
  if (rhythmHistory.length && now - rhythmHistory.at(-1) < 180) return false;
  if (rhythmHistory.length && now - rhythmHistory.at(-1) > 2000) {
    rhythmHistory = [];
    rhythmPeriod = 0;
  }
  rhythmHistory.push(now);
  rhythmHistory = rhythmHistory.filter(time => now - time <= 6000).slice(-16);
  if (rhythmPeriod) {
    const distance = now - rhythmAnchor;
    const beats = Math.round(distance / rhythmPeriod);
    if (beats >= 1 && Math.abs(distance - beats * rhythmPeriod) <= Math.min(85, rhythmPeriod * .16)) {
      rhythmPeriod += (distance / beats - rhythmPeriod) * .15;
      rhythmAnchor = now;
      return true;
    }
    if (distance < rhythmPeriod * 3) return false;
    rhythmPeriod = 0;
  }
  // Prefer a repeating interval supported by at least four attacks.
  for (let i = rhythmHistory.length - 2; i >= 0; i--) {
    const period = now - rhythmHistory[i];
    if (period < 300 || period > 1000) continue;
    let matches = 1;
    for (let j = i; j >= 0; j--) {
      const distance = now - rhythmHistory[j];
      const beats = Math.round(distance / period);
      if (Math.abs(distance - beats * period) <= Math.min(70, period * .12)) matches++;
    }
    if (matches >= 4) { rhythmPeriod = period; rhythmAnchor = now; break; }
  }
  return true;
}

function resetCoverPulse() {
  aubioNeedsReset = true;
  bassAverage = bassPrevious = 0;
  bassReady = false;
  bassTimestamp = 0;
  lastBassBeat = coverPulseStart = -Infinity;
  fluxAverage = [0, 0, 0];
  if (spectralPrevious) spectralPrevious.fill(0);
  rhythmHistory = [];
  rhythmPeriod = rhythmAnchor = 0;
  predictedRhythmBeat = 0;
  art.style.setProperty('--cover-scale', '1');
}

function updateCoverPulse(now) {
  if (beatDetector === 'aubiojs') {
    if (!running || !spotifyAudioActive || !bassSensitivity || widgetEl.classList.contains('compact')) {
      resetCoverPulse();
      return;
    }
    const remaining = Math.max(0, 1 - (now - coverPulseStart) / 180);
    art.style.setProperty('--cover-scale', String(1 + .03 * remaining ** 2));
    return;
  }
  if (!bassAnalyser || !spotifyAudioActive || bassSensitivity === 0 ||
      (!bassMethod && !spectralMethod) || widgetEl.classList.contains('compact')) {
    resetCoverPulse();
    return;
  }
  bassAnalyser.getFloatFrequencyData(bassData);
  let power = 0;
  for (let i = bassFirstBin; i <= bassLastBin; i++) power += 10 ** (bassData[i] / 10);
  const energy = Math.sqrt(power / (bassLastBin - bassFirstBin + 1));
  const elapsed = bassReady ? Math.max(0, now - bassTimestamp) : 0;
  const flux = [0, 0, 0], levels = [0, 0, 0], counts = [0, 0, 0];
  const binHz = audioContext.sampleRate / bassAnalyser.fftSize;
  for (let i = bassFirstBin; i <= spectralLastBin; i++) {
    const band = i * binHz < 180 ? 0 : i * binHz < 2000 ? 1 : 2;
    const magnitude = Math.log1p(100 * 10 ** (bassData[i] / 20));
    flux[band] += Math.max(0, magnitude - spectralPrevious[i]);
    levels[band] += magnitude;
    counts[band]++;
    spectralPrevious[i] = magnitude;
  }
  for (let band = 0; band < 3; band++) {
    flux[band] /= Math.max(1, counts[band]);
    levels[band] /= Math.max(1, counts[band]);
  }
  // Learn the initial level without treating capture startup as a beat.
  if (!bassReady || elapsed > 250) {
    bassAverage = bassPrevious = energy;
    fluxAverage = [...flux];
    rhythmHistory = [];
    rhythmPeriod = 0;
    predictedRhythmBeat = 0;
    bassReady = true;
  } else {
    const rise = energy - bassPrevious;
    const thresholdFactor = 2 ** ((50 - bassSensitivity) / 25);
    const nearExpectedBeat = rhythmMethod && rhythmPeriod &&
      Math.abs(now - rhythmAnchor - rhythmPeriod) <= Math.min(85, rhythmPeriod * .16);
    const bassThreshold = thresholdFactor * (nearExpectedBeat ? .45 : 1);
    const bassHit = bassMethod && energy > .008 * bassThreshold && energy > bassAverage * (1 + .35 * bassThreshold) &&
        rise > Math.max(.003 * bassThreshold, bassAverage * .12 * bassThreshold);
    const spectralHit = spectralMethod && flux.some((value, band) =>
      levels[band] > .08 * thresholdFactor && value > Math.max(.018 * thresholdFactor, fluxAverage[band] * (1 + 1.5 * thresholdFactor)));
    // Spectral attacks must not shift a rhythm learned from the bass.
    if (rhythmMethod && (bassHit || (!bassMethod && spectralHit))) confirmRhythm(now);
    const predictedHit = followBassPattern(now, energy, thresholdFactor);
    // A clear real attack always wins, including when the song changes its rhythm.
    if ((bassHit || spectralHit || predictedHit) && now - lastBassBeat >= 180) {
      lastBassBeat = coverPulseStart = now;
    }
    bassAverage += (energy - bassAverage) * (1 - Math.exp(-elapsed / 450));
    bassPrevious = energy;
    for (let band = 0; band < 3; band++) fluxAverage[band] += (flux[band] - fluxAverage[band]) * (1 - Math.exp(-elapsed / 700));
  }
  bassTimestamp = now;
  const remaining = Math.max(0, 1 - (now - coverPulseStart) / 180);
  art.style.setProperty('--cover-scale', String(1 + .03 * remaining ** 2));
}

for (let i = 0; i < 12; i++) compactBars.append(document.createElement('i'));

async function connectAudio() {
  if (connecting) return;
  connecting = true;
  running = false;
  cancelAnimationFrame(drawFrame);
  resetCoverPulse();
  status.textContent = 'Подключаем системный звук…';
  try {
    disposeAubio();
    if (captureStream) captureStream.getTracks().forEach(track => track.stop());
    if (audioContext) await audioContext.close();
    captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // Видеотрек намеренно остаётся активным: Chromium связывает с ним loopback-аудио.
    if (!captureStream.getAudioTracks().length) throw new Error('Windows не вернула аудиопоток');
    const audio = new AudioContext();
    audioContext = audio;
    await audio.resume();
    const source = audio.createMediaStreamSource(captureStream);
    if (await aubioReady) connectBeatProcessor(source, audio);
    analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .82;
    source.connect(analyser);
    bassAnalyser = audio.createAnalyser();
    bassAnalyser.fftSize = 2048;
    bassAnalyser.smoothingTimeConstant = .15;
    source.connect(bassAnalyser);
    bassData = new Float32Array(bassAnalyser.frequencyBinCount);
    const binHz = audio.sampleRate / bassAnalyser.fftSize;
    bassFirstBin = Math.max(1, Math.ceil(40 / binHz));
    bassLastBin = Math.min(bassData.length - 1, Math.floor(180 / binHz));
    spectralLastBin = Math.min(bassData.length - 1, Math.floor(10000 / binHz));
    spectralPrevious = new Float32Array(bassData.length);
    const connectedStream = captureStream;
    captureStream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (captureStream !== connectedStream) return;
      running = false;
      cancelAnimationFrame(drawFrame);
      resetCoverPulse();
      disposeAubio();
      status.textContent = 'Подключить звук ещё раз';
    }, { once: true }));
    data = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    if (status.textContent.includes('Подключ')) status.textContent = 'Включите музыку в Spotify';
    console.log(`Audio capture connected: ${captureStream.getAudioTracks()[0].label || 'loopback'}`);
    running = true;
    draw(performance.now());
  } catch (error) {
    console.error('Audio capture failed:', error);
    status.textContent = `Подключить звук ещё раз`;
  } finally {
    connecting = false;
  }
}

function draw(now) {
  if (!running) return;
  drawFrame = requestAnimationFrame(draw);
  updateCoverPulse(now);
  analyser.getByteFrequencyData(data);
  const targetGain = spotifyAudioActive ? 1 : 0;
  visualizerGain += (targetGain - visualizerGain) * (targetGain ? .12 : .18);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const colors = getComputedStyle(document.documentElement);
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, colors.getPropertyValue('--accent1').trim());
  gradient.addColorStop(1, colors.getPropertyValue('--accent2').trim());
  ctx.fillStyle = ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  if (visualizerType === 'wave') {
    analyser.getByteTimeDomainData(timeData);
    ctx.beginPath();
    for (let i = 0; i < timeData.length; i++) {
      const x = i / (timeData.length - 1) * canvas.width;
      const y = 27 + (timeData[i] - 128) / 128 * 25 * visualizerGain;
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
  const bars = 34, gap = 1.2, width = (canvas.width - gap * 33) / bars;
  for (let i = 0; i < bars; i++) {
    const index = Math.floor(Math.pow(i / bars, 1.45) * Math.min(data.length - 1, 90));
    const value = data[index] / 255 * visualizerGain;
    const h = Math.max(3, value * 48);
    ctx.beginPath();
    if (visualizerType === 'dots') {
      for (let y = 51; y >= 54 - h; y -= 6) {
        ctx.moveTo(i * (width + gap) + width, y);
        ctx.arc(i * (width + gap) + width / 2, y, width / 2, 0, Math.PI * 2);
      }
    } else ctx.roundRect(i * (width + gap), visualizerType === 'mirror' ? 27 - h / 2 : 54 - h, width, h, 2);
    ctx.fill();
  }
  }
  [...compactBars.children].forEach((bar, i) => {
    const value = data[2 + i * 3] / 255 * visualizerGain;
    bar.style.height = `${Math.max(4, value * 24)}px`;
  });
}

const playShape = [[30,20],[54,35],[54,65],[30,80],[54,35],[78,50],[78,50],[54,65]];
const pauseShape = [[29,22],[43,22],[43,78],[29,78],[57,22],[71,22],[71,78],[57,78]];

function iconPath(points) {
  return `M${points[0]} ${points[1]} L${points[2]} ${points[3]} L${points[4]} ${points[5]} L${points[6]} ${points[7]} Z M${points[8]} ${points[9]} L${points[10]} ${points[11]} L${points[12]} ${points[13]} L${points[14]} ${points[15]} Z`;
}

function animatePlaybackIcon(playing, immediate = false) {
  playPause.classList.toggle('is-playing', playing);
  const target = (playing ? pauseShape : playShape).flat();
  if (!morphPoints || immediate) {
    morphPoints = target;
    morphIcon.setAttribute('d', iconPath(target));
    return;
  }
  const start = [...morphPoints], started = performance.now(), duration = 360;
  function frame(now) {
    const raw = Math.min(1, (now - started) / duration);
    const t = 1 - Math.pow(1 - raw, 3);
    morphPoints = start.map((v, i) => v + (target[i] - v) * t);
    morphIcon.setAttribute('d', iconPath(morphPoints));
    if (raw < 1) requestAnimationFrame(frame); else morphPoints = target;
  }
  requestAnimationFrame(frame);
}

function applyCoverColors() {
  try {
    const sample = document.createElement('canvas');
    sample.width = sample.height = 24;
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    sampleCtx.drawImage(cover, 0, 0, 24, 24);
    const pixels = sampleCtx.getImageData(0, 0, 24, 24).data;
    const colors = [];
    const neutralLevels = [];
    for (let i = 0; i < pixels.length; i += 16) {
      if (pixels[i+3] < 35) continue;
      const r=pixels[i], g=pixels[i+1], b=pixels[i+2];
      const max=Math.max(r,g,b), min=Math.min(r,g,b), saturation=max-min;
      neutralLevels.push(Math.round(r*.299 + g*.587 + b*.114));
      if (max > 45 && max < 245 && saturation > 22) colors.push({r,g,b,score:saturation + max*.25});
    }
    colors.sort((a,b) => b.score-a.score);
    let first, second;
    if (colors.length) {
      first = colors[0];
      second = colors.find(c => Math.abs(c.r-first.r)+Math.abs(c.g-first.g)+Math.abs(c.b-first.b)>90) || {r:first.r*.55,g:first.g*.55,b:first.b*.55};
    } else if (neutralLevels.length) {
      // Монохромные обложки получают серую палитру; тёмные оттенки
      // осветляем, чтобы кнопки и спектр оставались видны на карточке.
      neutralLevels.sort((a,b) => a-b);
      const light = Math.max(160, Math.min(235, neutralLevels[Math.floor((neutralLevels.length-1)*.8)]));
      const dark = Math.max(85, Math.min(light-45, neutralLevels[Math.floor((neutralLevels.length-1)*.2)]));
      first = {r:light,g:light,b:light};
      second = {r:dark,g:dark,b:dark};
    } else {
      first = {r:30,g:215,b:96};
      second = {r:16,g:118,b:52};
    }
    const root = document.documentElement.style;
    root.setProperty('--accent1', `rgb(${first.r},${first.g},${first.b})`);
    root.setProperty('--accent2', `rgb(${second.r|0},${second.g|0},${second.b|0})`);
    root.setProperty('--accent-rgb', `${first.r},${first.g},${first.b}`);
  } catch (error) { console.warn('Cover color extraction failed:', error); }
}

function mediaAction(action, button) {
  if (action === 'next' || action === 'previous') pendingTrackDirection = action;
  window.widget.mediaControl(action);
  button.classList.remove('pulse');
  void button.offsetWidth;
  button.classList.add('pulse');
  setTimeout(() => button.classList.remove('pulse'), 380);
}

function setAsciiImage(url) {
  const generation = ++asciiGeneration;
  currentAsciiUrl = url;
  clearInterval(asciiTimer);
  asciiDisplay.classList.remove('original-image');
  if (url && currentAsciiSettings?.displayMode === 'image') {
    const original = new Image();
    original.alt = '';
    asciiDisplay.replaceChildren();
    original.onload = () => { if (generation !== asciiGeneration) return; asciiDisplay.classList.add('original-image'); asciiDisplay.replaceChildren(original); updateAsciiScale(); };
    original.src = url;
    return;
  }
  if (!url) {
    asciiDisplay.textContent = '  ♪  \n♫   ♫\n  ♪  ';
    requestAnimationFrame(updateAsciiScale);
    return;
  }
  const image = new Image();
  image.src = url;
  const renderAscii = () => {
    if (generation !== asciiGeneration) return;
    if (!image.naturalWidth) return;
    const width = asciiColumns, height = Math.max(3, Math.round(asciiColumns / 2));
    const sample = document.createElement('canvas');
    sample.width = width; sample.height = height;
    const context = sample.getContext('2d', { willReadFrequently:true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const chars = ' .·:+*#%@';
    let output = '';
    const fragment = document.createDocumentFragment();
    for (let y=0; y<height; y++) {
      for (let x=0; x<width; x++) {
        const i=(y*width+x)*4;
        if (pixels[i+3] < 35) { output += ' '; fragment.append(document.createTextNode(' ')); continue; }
        const light=(pixels[i]*.299+pixels[i+1]*.587+pixels[i+2]*.114)/255;
        const character=chars[Math.min(chars.length-1, Math.floor(light*chars.length))];
        output += character;
        if (currentAsciiSettings?.displayMode === 'colorAscii') {
          const span = document.createElement('span');
          span.textContent = character;
          span.style.color = 'rgb(' + pixels[i] + ',' + pixels[i+1] + ',' + pixels[i+2] + ')';
          span.style.opacity = pixels[i+3] / 255;
          fragment.append(span);
        }
      }
      output += y === height-1 ? '' : '\n';
      if (y < height-1) fragment.append(document.createTextNode('\n'));
    }
    if (currentAsciiSettings?.displayMode === 'colorAscii') asciiDisplay.replaceChildren(fragment);
    else asciiDisplay.textContent = output;
    requestAnimationFrame(updateAsciiScale);
  };
  image.onload = () => {
    if (generation !== asciiGeneration) return;
    renderAscii();
    asciiTimer = setInterval(renderAscii, 180);
  };
}

function updateAsciiScale() {
  const naturalWidth = Math.max(1, asciiDisplay.offsetWidth);
  const naturalHeight = Math.max(1, asciiDisplay.offsetHeight);
  const root = document.documentElement.style;
  root.setProperty('--ascii-scale-x', asciiTargetWidth / naturalWidth);
  root.setProperty('--ascii-scale-y', asciiTargetHeight / naturalHeight);
}

function applyAsciiSettings(value) {
  const modeChanged = currentAsciiSettings?.displayMode !== value.displayMode;
  currentAsciiSettings = value;
  const root = document.documentElement.style;
  root.setProperty('--ascii-x', `${value.x}px`);
  root.setProperty('--ascii-y', `${value.y}px`);
  asciiTargetWidth = value.width;
  asciiTargetHeight = value.height;
  root.setProperty('--ascii-width', `${value.width}px`);
  root.setProperty('--ascii-height', `${value.height}px`);
  root.setProperty('--ascii-opacity', value.opacity / 100);
  root.setProperty('--ascii-origin-x', `${value.originX}%`);
  root.setProperty('--ascii-origin-y', `${value.originY}%`);
  root.setProperty('--ascii-rotation', `${value.rotation}deg`);
  root.setProperty('--ascii-negative-rotation', `${-value.rotation}deg`);
  asciiRotator.classList.toggle('full-spin', value.full360);
  asciiRotator.style.animationDuration = `${value.speed}s`;
  asciiRotator.style.animationTimingFunction = `steps(${value.frames}, end)`;
  asciiStage.classList.toggle('is-hidden', value.hidden);
  updatePivotMarker(value);
  requestAnimationFrame(updateAsciiScale);
  if (modeChanged || asciiColumns !== value.symbols) {
    asciiColumns = value.symbols;
    setAsciiImage(currentAsciiUrl);
  }
}

function updatePivotMarker(value) {
  const pivotX=value.x + 38 - value.width/2 + value.width*value.originX/100;
  const pivotY=value.y + 21.5 - value.height/2 + value.height*value.originY/100;
  const root=document.documentElement.style;
  root.setProperty('--pivot-x',`${pivotX}px`);
  root.setProperty('--pivot-y',`${pivotY}px`);
}

const asciiStage = document.querySelector('.ascii-stage');
asciiStage.addEventListener('pointerdown', event => {
  if (!widgetEl.classList.contains('ascii-editing')) return;
  event.preventDefault(); event.stopPropagation();
  asciiStage.setPointerCapture(event.pointerId);
  const startX=event.clientX, startY=event.clientY;
  const originX=currentAsciiSettings?.x ?? 276, originY=currentAsciiSettings?.y ?? 3;
  const move = moveEvent => {
    const x=Math.max(0,Math.min(widgetEl.clientWidth-asciiStage.offsetWidth,originX+moveEvent.clientX-startX));
    const y=Math.max(0,Math.min(widgetEl.clientHeight-asciiStage.offsetHeight,originY+moveEvent.clientY-startY));
    document.documentElement.style.setProperty('--ascii-x',`${x}px`);
    document.documentElement.style.setProperty('--ascii-y',`${y}px`);
    currentAsciiSettings={...currentAsciiSettings,x,y};
    updatePivotMarker(currentAsciiSettings);
  };
  const finish = async () => {
    asciiStage.removeEventListener('pointermove',move);
    asciiStage.removeEventListener('pointerup',finish);
    asciiStage.removeEventListener('pointercancel',finish);
    applyAsciiSettings(await window.widget.updateAsciiSettings({x:currentAsciiSettings.x,y:currentAsciiSettings.y}));
  };
  asciiStage.addEventListener('pointermove',move);
  asciiStage.addEventListener('pointerup',finish);
  asciiStage.addEventListener('pointercancel',finish);
});

function toggleCompact() { widgetEl.classList.toggle('compact'); resetCoverPulse(); }
document.querySelector('#compact').onclick = e => { e.stopPropagation(); toggleCompact(); };
document.querySelector('#settings').onclick = e => { e.stopPropagation(); window.widget.openSettings(); };
document.querySelector('#close').onclick = e => { e.stopPropagation(); window.widget.close(); };
document.querySelector('#compactBars').onclick = e => { e.stopPropagation(); toggleCompact(); };
document.querySelector('#compactClose').onclick = e => { e.stopPropagation(); window.widget.close(); };
document.querySelector('#previous').onclick = e => { e.stopPropagation(); mediaAction('previous', e.currentTarget); };
document.querySelector('#next').onclick = e => { e.stopPropagation(); mediaAction('next', e.currentTarget); };
playPause.onclick = e => {
  e.stopPropagation();
  isPlaying = !isPlaying;
  animatePlaybackIcon(isPlaying);
  window.widget.mediaControl('playpause');
};
function applyAudioOutput(output) {
  const speakers = output?.kind === 'speakers';
  outputToggle.classList.toggle('is-speakers', speakers);
  outputToggle.title = output?.name ? `Аудиовыход: ${output.name}` : 'Переключить аудиовыход';
  outputToggle.setAttribute('aria-label', outputToggle.title);
}
outputToggle.onclick = async e => {
  e.stopPropagation();
  if (outputToggle.disabled) return;
  outputToggle.disabled = true;
  outputToggle.classList.add('switching');
  try { applyAudioOutput(await window.widget.audioOutput('toggle')); }
  catch (error) {
    console.error('Audio output switch failed:', error);
    outputToggle.title = 'Не удалось переключить: проверьте подключение наушников и колонок';
    outputToggle.setAttribute('aria-label', outputToggle.title);
    outputToggle.classList.add('output-error');
    setTimeout(() => outputToggle.classList.remove('output-error'), 1800);
  }
  finally {
    setTimeout(() => outputToggle.classList.remove('switching'), 430);
    outputToggle.disabled = false;
  }
};
outputToggle.addEventListener('mouseenter', () => {
  if (!outputToggle.disabled) window.widget.audioOutput('get').then(applyAudioOutput).catch(() => {});
});
window.widget.audioOutput('get').then(applyAudioOutput).catch(error => console.warn('Audio output detection failed:', error));
status.onclick = e => { e.stopPropagation(); connectAudio(); };
window.widget.onToggleCompact(toggleCompact);
function applyWidgetSettings(value) {
  widgetEl.classList.toggle('cover-wiggle', value.coverWiggle === true);
  beatDetector = value.beatDetector;
  bassSensitivity = value.bassSensitivity;
  bassMethod = value.bassMethod;
  spectralMethod = value.spectralMethod;
  rhythmMethod = value.rhythmMethod;
  resetCoverPulse();
}
window.widget.onWidgetSettings(applyWidgetSettings);
window.widget.getWidgetSettings().then(applyWidgetSettings);
window.widget.onVisualizerSettings(value => { visualizerType = value.type; });
window.widget.getVisualizerSettings().then(value => { visualizerType = value.type; });
window.widget.onAsciiImage(setAsciiImage);
window.widget.getAsciiImage().then(setAsciiImage);
window.widget.onAsciiSettings(applyAsciiSettings);
window.widget.getAsciiSettings().then(applyAsciiSettings);
window.widget.onAsciiEditMode(enabled => widgetEl.classList.toggle('ascii-editing', enabled));
function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function setTrackContent(track, generation) {
  if (!track) {
    trackTitle.textContent = 'Ожидаю трек…';
    status.textContent = 'Включите музыку в Spotify';
    cover.onload = null;
    cover.onerror = null;
    cover.classList.remove('loaded');
    cover.removeAttribute('src');
    document.title = 'Spotify Visualizer';
    return;
  }
  trackTitle.textContent = track.title;
  status.textContent = track.artist || 'Spotify';
  document.title = `${track.title}${track.artist ? ` — ${track.artist}` : ''}`;
  if (track.cover) {
    cover.onload = () => {
      if (generation !== trackTransitionGeneration) return;
      cover.classList.add('loaded');
      applyCoverColors();
    };
    cover.onerror = () => generation === trackTransitionGeneration && cover.classList.remove('loaded');
    cover.classList.remove('loaded');
    cover.src = track.cover;
  } else {
    cover.onload = null;
    cover.onerror = null;
    cover.classList.remove('loaded');
    cover.removeAttribute('src');
  }
}

async function displayTrack(track) {
  const generation = ++trackTransitionGeneration;
  const nextKey = track ? `${track.title}\u0000${track.artist || ''}` : '';
  const isTrackChange = nextKey !== displayedTrackKey;
  spotifyAudioActive = Boolean(track?.playing);
  if (isTrackChange || !spotifyAudioActive) resetCoverPulse();
  isPlaying = spotifyAudioActive;
  animatePlaybackIcon(isPlaying);

  if (!isTrackChange) {
    setTrackContent(track, generation);
    return;
  }

  const direction = pendingTrackDirection;
  pendingTrackDirection = 'next';
  if (displayedTrackKey) {
    art.classList.add(`track-exit-${direction}`);
    trackCopy.classList.add(`track-exit-${direction}`);
    await wait(180);
    if (generation !== trackTransitionGeneration) return;
  }

  art.className = 'art';
  trackCopy.className = 'track-copy';
  setTrackContent(track, generation);
  displayedTrackKey = nextKey;
  if (nextKey) {
    art.classList.add(`track-enter-${direction}`);
    trackCopy.classList.add(`track-enter-${direction}`);
    await wait(430);
    if (generation !== trackTransitionGeneration) return;
    art.className = 'art';
    trackCopy.className = 'track-copy';
  }
}

window.widget.onTrackUpdate(track => {
  spotifyAudioActive = Boolean(track?.playing);
  if (!track) {
    displayTrack(null);
  } else {
    displayTrack(track);
  }
});
animatePlaybackIcon(false, true);
connectAudio();
