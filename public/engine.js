const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const paint = () => new Promise(resolve => requestAnimationFrame(resolve));
const precision = ms => Math.round(ms * 100) / 100;

function present(stage, stimulus, text, kind, framed = false, size = '') {
  stage.classList.toggle('framed', framed);
  stimulus.dataset.kind = kind;
  stimulus.className = 'stimulus' + (size ? ' ' + size : '');
  stimulus.textContent = text;
}

async function fixation(stage, stimulus, frameMs) {
  present(stage, stimulus, '', '', true);
  if (frameMs) await wait(frameMs);
  const frames = [['fix-small', 75], ['fix-medium', 75], ['fix-large', 75], ['fix-medium', 75], ['fix-small', 200]];
  for (const [size, ms] of frames) {
    present(stage, stimulus, '+', 'fix', true, size);
    await wait(ms);
  }
}

async function capture({ stage, stimulus, keys, text, kind, stopText, delay, windowMs, framed }) {
  await paint();
  const onset = performance.now();
  let cueMs = null;
  let cueFrame;
  let frameBefore = onset;
  let interrupted = document.hidden || !document.hasFocus();
  present(stage, stimulus, text, kind, framed);
  return new Promise(resolve => {
    function markInterruption() { interrupted = true; }
    function finish(key, elapsed) {
      clearTimeout(deadline);
      cancelAnimationFrame(cueFrame);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('visibilitychange', markInterruption);
      window.removeEventListener('blur', markInterruption);
      if (key !== null && cueMs !== null && elapsed < cueMs) cueMs = null;
      present(stage, stimulus, '', '', framed);
      resolve({
        key, rt: elapsed === null ? null : Math.min(precision(elapsed), windowMs - 0.01),
        cueMs: cueMs === null ? null : Math.min(precision(cueMs), windowMs - 0.01), interrupted,
      });
    }
    function keydown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const key = event.code === 'Space' ? 'Space' : event.key.toLowerCase();
      if (!keys.includes(key)) return;
      event.preventDefault();
      if (event.repeat) return;
      const received = performance.now() - onset;
      const elapsed = event.timeStamp - onset;
      if (received - elapsed > 50) interrupted = true;
      if (elapsed >= 0 && elapsed < windowMs) finish(key, elapsed);
    }
    function stopFrame() {
      const now = performance.now();
      const elapsed = now - onset;
      if (now - frameBefore > 50) interrupted = true;
      frameBefore = now;
      if (elapsed >= windowMs) return;
      if (elapsed >= delay) {
        cueMs = elapsed;
        present(stage, stimulus, stopText, 'stop', framed);
      } else {
        cueFrame = requestAnimationFrame(stopFrame);
      }
    }
    const deadline = setTimeout(() => {
      if (performance.now() - onset > windowMs + 50) interrupted = true;
      finish(null, null);
    }, windowMs);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('visibilitychange', markInterruption);
    window.addEventListener('blur', markInterruption);
    if (delay !== null) cueFrame = requestAnimationFrame(stopFrame);
  });
}

export const keyLabel = key => key === 'Space' ? 'barra de espaços' : key.toUpperCase();

export async function runBlock(type, config, block, stage, indicator) {
  const stimulus = stage.querySelector('.stimulus');
  const stopTask = type === 'stop';
  const baseline = block.block === 'baseline';
  const keys = stopTask ? [config.leftKey, config.rightKey] : [config.responseKey];
  const entries = [];
  let consecutive = 0;
  let baselineSum = 0;
  let baselineHits = 0;
  for (const trial of block.trials) {
    indicator.textContent = baseline
      ? `Ensaio ${trial.index + 1} · até ${config.baselineLimit}`
      : `Ensaio ${trial.index + 1} de ${block.trials.length}`;
    if (stopTask) await fixation(stage, stimulus, config.frameMs);
    const noGo = trial.condition === 'nogo';
    const expected = stopTask ? config[trial.direction === 'left' ? 'leftKey' : 'rightKey'] : config.responseKey;
    const text = stopTask ? config[trial.direction === 'left' ? 'leftCue' : 'rightCue'] : noGo ? config.noGoCue : config.goCue;
    const result = await capture({
      stage, stimulus, keys, text, kind: noGo ? 'nogo' : 'go', stopText: config.stopCue,
      delay: trial.delay, windowMs: config.windowMs, framed: stopTask,
    });
    entries.push({ block: block.block, index: trial.index, ...result });

    let message = '';
    let feedback = 0;
    if (!stopTask) {
      if (noGo && result.key !== null) message = 'Não devia premir a tecla.';
      if (!noGo && result.key === null) message = 'Devia premir a tecla.';
      feedback = config.feedbackMs;
    } else if (trial.condition === 'stop' && result.cueMs !== null && result.key !== null) {
      message = 'Não devia premir a tecla.';
      feedback = 1250;
    } else if (trial.condition !== 'stop' && result.key === null) {
      message = 'Devia premir a tecla.';
      feedback = 1250;
    } else if (result.key !== null && result.key !== expected) {
      message = 'Tecla incorreta.';
      feedback = 2000;
    }
    if (message && feedback) {
      present(stage, stimulus, message, 'feedback', stopTask);
      await wait(feedback);
    }
    present(stage, stimulus, '', '', stopTask);
    await wait(config.gapMs);
    if (baseline) {
      if (result.key === expected) {
        consecutive++;
        baselineSum += result.rt;
        baselineHits++;
      } else consecutive = 0;
      if (consecutive >= config.baselineStreak) break;
    }
  }
  return { entries, baselineMean: baselineHits ? baselineSum / baselineHits : null };
}
