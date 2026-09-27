/**
 * main.js — 应用入口
 * 3D 魔方直接涂色 → Kociemba 求解 → 动画复原
 */
import { Visualizer } from './visualizer.js';
import { validateState, parseMoves, createEmptyState, createSolvedState, countColors, isComplete, COLOR_LIST, FACE_COLORS, FACES, CENTERS } from './cube-state.js';

// DOM
const colorPalette = document.getElementById('color-palette');
const threeCanvas = document.getElementById('three-canvas');
const solveBtn = document.getElementById('solve-btn');
const resetBtn = document.getElementById('reset-btn');
const randomBtn = document.getElementById('random-btn');
const solvedBtn = document.getElementById('solved-btn');
const resetViewBtn = document.getElementById('reset-view-btn');
const statusEl = document.getElementById('status');
const loadingBadge = document.getElementById('loading-badge');
const playbackControls = document.getElementById('playback-controls');
const playBtn = document.getElementById('play-btn');
const pauseBtn = document.getElementById('pause-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const speedSelect = document.getElementById('speed-select');
const solutionInfo = document.getElementById('solution-info');
const stepList = document.getElementById('step-list');
const modeTabs = document.getElementById('mode-tabs');
const tabScramble = document.getElementById('tab-scramble');
const tabSolve = document.getElementById('tab-solve');
const phaseTag = document.getElementById('phase-tag');
const methodSelect = document.getElementById('method-select');

// State
let visualizer = null;
let worker = null;
let solverReady = false;
let currentSolution = null;   // 当前激活阶段的步骤串
let selectedColor = null;
let cubeState = createEmptyState(); // 54-char string

// DOM 缓存（避免每次涂色重建）
let paletteBtns = [];
let stepItems = [];
let _lastStepListKey = '';

// 双阶段：打乱 (scramble) 与复原 (solve) 各自的步骤数据
let scrambleData = null;      // { moves: [], stepStates: [] }
let solveData = null;         // { moves: [], stepStates: [], moveCount, elapsed, phases }()
let activePhase = null;       // null | 'scramble' | 'solve'

// ─── 初始化 3D 魔方 ───
visualizer = new Visualizer(threeCanvas);
window.__viz = visualizer; // 调试用
visualizer.setInputMode(true);
visualizer.setCubeState(cubeState);

visualizer.onFacePaint = (faceletIdx) => {
  // 更新状态字符串
  cubeState = cubeState.substring(0, faceletIdx) + selectedColor + cubeState.substring(faceletIdx + 1);
  autoFillLastColor();
  refreshPalette();
  refreshStatus();
  checkPaintWarnings();
  // 手动涂色后播放会话失效（避免刷新后恢复旧步骤覆盖新涂色）
  invalidateSession();
  throttledSave();
};

/**
 * 涂色实时提醒：某种颜色超出 9 个时立即警告
 */
function checkPaintWarnings() {
  const counts = countColors(cubeState);
  for (const f of FACES) {
    if (counts[f] > 9) {
      showToast(`⚠ "${FACE_COLORS[f].name}"色已涂 ${counts[f]} 个（每种颜色只能有 9 个），请检查是否涂错`);
      return;
    }
  }
  // 已完整时做合法校验
  if (isComplete(cubeState)) {
    const v = validateState(cubeState);
    if (!v.valid && v.errors.length) {
      showToast(`⚠ ${v.errors[0]}`);
    }
  }
}

// 用户手动转层后同步状态
visualizer.onUserMove = () => {
  cubeState = visualizer.getCubeState();
  refreshPalette();
  refreshStatus();
  // 手动转层后播放会话失效，按纯涂色状态保存
  invalidateSession();
  throttledSave();
};

visualizer.onStepChange = () => { updateStepList(); updatePlaybackButtons(); throttledSave(); };
// onPlaybackComplete 由 defaultPlaybackComplete 统一设置（见下方）

// ─── 颜色面板 ───
function buildPalette() {
  colorPalette.innerHTML = '';
  paletteBtns = [];
  for (const item of COLOR_LIST) {
    const btn = document.createElement('button');
    btn.className = 'color-btn';
    btn.style.backgroundColor = item.hex;
    btn.innerHTML = `<span class="color-label">${item.name}</span><span class="color-count"></span>`;
    btn.addEventListener('click', () => {
      selectedColor = item.face;
      visualizer.setSelectedColor(selectedColor);
      refreshPalette();
    });
    colorPalette.appendChild(btn);
    paletteBtns.push({ btn, face: item.face });
  }
  refreshPalette();
}

function refreshPalette() {
  const counts = countColors(cubeState);
  for (const { btn, face } of paletteBtns) {
    const remaining = 9 - counts[face];
    const done = remaining <= 0;
    const sel = selectedColor === face;
    btn.className = `color-btn ${sel ? 'selected' : ''} ${done ? 'done' : ''}`;
    btn.querySelector('.color-count').textContent = done ? '✓' : remaining;
    btn.disabled = done;
  }
}

function refreshStatus() {
  // 加载表期间：求解按钮一律禁用
  if (!solverReady) {
    solveBtn.disabled = true;
  }
  const complete = isComplete(cubeState);
  if (complete) {
    const v = validateState(cubeState);
    if (v.valid) {
      statusEl.className = 'validation-status valid';
      statusEl.innerHTML = '<span>✓</span> 状态合法，可以求解';
      if (solverReady) solveBtn.disabled = false;
    } else {
      statusEl.className = 'validation-status invalid';
      statusEl.innerHTML = `<span>✗</span> ${v.errors[0]}`;
      solveBtn.disabled = true;
    }
  } else {
    const counts = countColors(cubeState);
    const filled = Object.values(counts).reduce((a,b) => a+b, 0);
    const remaining = 48 - (filled - 6);
    statusEl.className = 'validation-status incomplete';
    statusEl.innerHTML = `<span>○</span> 还需填写 ${Math.max(0, remaining)} 个色块`;
    solveBtn.disabled = true;
  }
}

function autoFillLastColor() {
  const counts = countColors(cubeState);
  const done = FACES.filter(f => counts[f] >= 9);
  if (done.length === 5) {
    const last = FACES.find(f => counts[f] < 9);
    if (!last) return;
    const need = 9 - counts[last];
    const empties = [];
    for (let i = 0; i < 54; i++) {
      if (!FACES.includes(cubeState[i]) && i !== CENTERS[last]) empties.push(i);
    }
    if (empties.length === need) {
      for (const idx of empties) {
        cubeState = cubeState.substring(0, idx) + last + cubeState.substring(idx + 1);
        visualizer.paintFacelet(idx, last);
      }
    }
  }
}

// ─── 求解 Worker ───
function initWorker() {
  worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  window.__worker = worker; // 调试用
  worker.onmessage = (e) => {
    const { type } = e.data;
    if (type === 'init_done') { solverReady = true; hideEngineLoading(); refreshStatus(); }
    else if (type === 'init_progress') { showEngineLoading(); }
    else if (type === 'init_error') { hideEngineLoading(); showToast('求解器初始化失败: ' + e.data.error); }
    else if (type === 'solve_done') { hideSolvingOverlay(); onSolutionReady(e.data.solution, e.data.moveCount, e.data.stepStates, e.data.rotation, e.data.phases, e.data.method); }
    else if (type === 'solve_error') { hideSolvingOverlay(); solveBtn.disabled = false; showToast('求解失败: ' + e.data.error); }
    else if (type === 'scramble_done') {
      onScrambleReady(e.data.facelets, e.data.scramble, e.data.stepStates);
    }
    else if (type === 'scramble_error') { showToast('生成打乱失败: ' + e.data.error); }
    else if (type === 'test_moves_done') { window.__testResults = e.data.results; }
    else if (type === 'test_moves_error') { console.error('test_moves error:', e.data.error); }
  };
  showEngineLoading();
  worker.postMessage({ type: 'init' });
}

// 求解计时
let solveStartTime = 0;

// ─── Loading Badge & Toast ───
// 初始化表：角落小角标，不阻塞涂色操作
function showEngineLoading() {
  if (loadingBadge) loadingBadge.style.display = 'flex';
}
function hideEngineLoading() {
  if (loadingBadge) loadingBadge.style.display = 'none';
}
// 求解中：全屏轻量遮罩（可点击穿透关闭？不行，防误触）
function showSolvingOverlay() {
  let ov = threeCanvas.querySelector('.loading-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'loading-overlay';
    ov.innerHTML = '<div class="spinner"></div>';
    threeCanvas.appendChild(ov);
  }
  ov.style.display = 'flex';
}
function hideSolvingOverlay() {
  const ov = threeCanvas.querySelector('.loading-overlay');
  if (ov) ov.style.display = 'none';
}
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ─── 按钮事件 ───
solveBtn.addEventListener('click', () => {
  if (!solverReady) { showToast('求解引擎正在初始化...'); return; }
  const v = validateState(cubeState);
  if (!v.valid) { showToast('状态不合法: ' + v.errors[0]); return; }

  // 切换到播放模式：重建 3D 立方体为打乱状态
  visualizer.setInputMode(false);
  visualizer.setSelectedColor(null);
  solveStartTime = performance.now();
  solveBtn.disabled = true;
  showSolvingOverlay();
  const method = methodSelect ? methodSelect.value : 'kociemba';
  saveState();
  worker.postMessage({ type: 'solve', data: { facelets: cubeState, method } });
});

resetBtn.addEventListener('click', () => {
  cubeState = createEmptyState();
  visualizer.setCubeState(cubeState);
  visualizer.setInputMode(true);
  invalidateSession();
  refreshPalette();
  refreshStatus();
  saveState();
});

// 置为已复原状态（作为涂色起点）
solvedBtn.addEventListener('click', () => {
  cubeState = createSolvedState();
  visualizer.setCubeState(cubeState);
  visualizer.setInputMode(true);
  invalidateSession();
  refreshPalette();
  refreshStatus();
  showToast('已置为复原状态');
  saveState();
});

// 恢复默认视角
resetViewBtn.addEventListener('click', () => {
  visualizer.resetCamera();
});

randomBtn.addEventListener('click', () => {
  if (!solverReady) {
    // 打乱本身不依赖求解表（用内置 Cube.scramble），但需要 cubejs 运行时
    showToast('求解引擎加载中…请稍候，马上就能打乱');
    return;
  }
  // 打乱步数范围（最少 25 步，由下拉框选择）
  const rangeEl = document.getElementById('scramble-range');
  const [minLen, maxLen] = (rangeEl ? rangeEl.value : '25-30').split('-').map(Number);
  saveState();
  worker.postMessage({ type: 'scramble', data: { minLen, maxLen } });
});

/**
 * 随机打乱：从复原状态动画过渡到打乱状态，并登记「打乱阶段」步骤
 */
function onScrambleReady(facelets, scramble, stepStates) {
  const moves = parseMoves(scramble.trim());
  const solvedState = createSolvedState();

  scrambleData = { moves, stepStates: stepStates || [solvedState], targetState: facelets };

  visualizer.setCubeState(solvedState);
  visualizer.setInputMode(false);
  visualizer.setSolution(moves, stepStates || null);
  activePhase = 'scramble';

  // 打乱动画完成后：登记状态，保留播放控制可用，切回可重播
  visualizer.onPlaybackComplete = () => {
    cubeState = facelets;
    visualizer.setInputMode(true);
    visualizer.onPlaybackComplete = defaultPlaybackComplete;
    refreshPalette();
    refreshStatus();
    showToast(`已随机打乱（${moves.length} 步），可点击「求解」或回看打乱步骤`);
    setPhaseTag('打乱完成');
    // 保持播放控制可见可重播
    playbackControls.style.display = 'flex';
    updatePlaybackButtons();
    // 保存打乱完成的最终态（cubeState 已更新为打乱态）
    saveState();
  };

  refreshPalette();
  refreshStatus();
  // 显示双标签：打乱/复原（复原此时还没有内容，占位提示）
  modeTabs.style.display = 'flex';
  setPhaseTag('打乱中…');
  switchPhase('scramble', true);  // keepCube=true：魔方已在上面装载
  setTimeout(() => visualizer.play(), 300);
  saveState();
}

/**
 * 切换阶段标签的显示（打乱/复原）
 */
function setPhaseTag(text) {
  if (text) {
    phaseTag.style.display = 'inline-block';
    phaseTag.textContent = text;
  } else {
    phaseTag.style.display = 'none';
  }
}

// 集中定义默认的 playbackComplete 处理器
const defaultPlaybackComplete = () => {
  // 播放结束后当前魔方状态即最终状态，同步回主状态（含刷新恢复后手动播完的情况）
  cubeState = visualizer.getCubeState();
  refreshPalette();
  refreshStatus();
  updatePlaybackButtons();
  const solved = createSolvedState();
  if (activePhase === 'solve' && cubeState === solved) {
    showToast('✓ 魔方已复原！');
  }
  throttledSave();
};
visualizer.onPlaybackComplete = defaultPlaybackComplete;

/**
 * 会话失效：手动涂色/转层/清空/复原后调用。
 * 播放数据与步骤序列已与当前魔方状态脱节，清除避免刷新恢复错乱。
 */
function invalidateSession() {
  activePhase = null;
  currentSolution = null;
  scrambleData = null;
  solveData = null;
  stepList.innerHTML = '<p class="empty-hint">在 3D 魔方上点击涂色后点击「求解」</p>';
  _lastStepListKey = '';
  stepItems = [];
  solutionInfo.innerHTML = '';
  playbackControls.style.display = 'none';
  modeTabs.style.display = 'none';
  setPhaseTag(null);
  updatePlaybackButtons();
}

// ─── 求解结果 ───
function onSolutionReady(solution, moveCount, stepStates, rotation, phases, method) {
  solveBtn.disabled = false;
  currentSolution = solution;
  const moves = parseMoves(solution);
  const elapsed = solveStartTime ? (performance.now() - solveStartTime) : 0;

  solveData = { moves, stepStates, moveCount, elapsed, rotation, phases, method };

  // 重建 3D 立方体为当前打乱状态
  visualizer.setCubeState(cubeState);
  visualizer.setSolution(moves, stepStates);
  activePhase = 'solve';

  playbackControls.style.display = 'flex';
  modeTabs.style.display = 'flex';
  updateSolutionInfo();
  switchPhase('solve', true);  // keepCube=true：魔方已在上面装载

  // 若有整体旋转（中层状态），先播朝向对齐再播解法
  const rotationMoves = rotation ? parseMoves(rotation) : null;
  if (rotationMoves && rotationMoves.length > 0) {
    setTimeout(() => visualizer.playIntroRotation(rotationMoves, () => {
      setTimeout(() => visualizer.play(), 200);
    }), 600);
  } else {
    setTimeout(() => visualizer.play(), 600);
  }
  saveState();
}

function updateSolutionInfo() {
  if (activePhase === 'solve' && solveData) {
    const { moveCount, elapsed, method, phases } = solveData;
    let html = `
      <div class="info-row"><span class="info-label">总步数</span><span class="info-value">${moveCount} 步</span></div>
      <div class="info-row"><span class="info-label">算法</span><span class="info-value">${method || 'Kociemba 两阶段法'}</span></div>
      <div class="info-row"><span class="info-label">计算耗时</span><span class="info-value">${elapsed < 1000 ? Math.round(elapsed) + ' ms' : (elapsed / 1000).toFixed(2) + ' s'}</span></div>
    `;
    if (phases && phases.length > 0) {
      html += '<div class="phase-list">';
      for (const p of phases) {
        html += `<div class="info-row"><span class="info-label">${p.name}</span><span class="info-value">${p.moves.length} 步</span></div>`;
      }
      html += '</div>';
    }
    solutionInfo.innerHTML = html;
  } else if (activePhase === 'scramble' && scrambleData) {
    solutionInfo.innerHTML = `
      <div class="info-row"><span class="info-label">打乱步数</span><span class="info-value">${scrambleData.moves.length} 步</span></div>
      <div class="info-row"><span class="info-label">当前阶段</span><span class="info-value">打乱</span></div>
      <div class="info-row"><span class="info-label">提示</span><span class="info-value">点击「求解」获得最优复原路径</span></div>
    `;
  } else {
    solutionInfo.innerHTML = '';
  }
}

/**
 * 切换打乱/复原阶段标签与步骤列表
 * 注意：初次播放打乱时不重置魔方（避免与 onScrambleReady 的装载冲突）
 */
function switchPhase(phase, keepCube = false) {
  activePhase = phase;
  tabScramble.classList.toggle('active', phase === 'scramble');
  tabSolve.classList.toggle('active', phase === 'solve');

  if (phase === 'scramble') {
    if (scrambleData) {
      currentSolution = scrambleData.moves.join(' ');
      if (!keepCube) {
        // 切回打乱标签：从复原状态重新装载
        const solvedState = createSolvedState();
        visualizer.setCubeState(solvedState);
        visualizer.setSolution(scrambleData.moves, scrambleData.stepStates);
        visualizer.setInputMode(false);
      }
      playbackControls.style.display = 'flex';
      setPhaseTag('打乱阶段');
    } else {
      currentSolution = null;
      stepList.innerHTML = '<p class="empty-hint">尚未打乱，点击「随机打乱」</p>';
      playbackControls.style.display = 'none';
      setPhaseTag(null);
    }
  } else if (phase === 'solve') {
    if (solveData) {
      currentSolution = solveData.moves.join(' ');
      if (!keepCube) {
        visualizer.setCubeState(solveData.stepStates[0]);
        visualizer.setSolution(solveData.moves, solveData.stepStates);
        visualizer.setInputMode(false);
      }
      playbackControls.style.display = 'flex';
      setPhaseTag('复原阶段');
    } else {
      currentSolution = null;
      stepList.innerHTML = '<p class="empty-hint">尚未求解，点击「求解」</p>';
      playbackControls.style.display = 'none';
      setPhaseTag(null);
    }
  }
  updateSolutionInfo();
  updateStepList();
  updatePlaybackButtons();
  saveState();
}

tabScramble.addEventListener('click', () => switchPhase('scramble'));
tabSolve.addEventListener('click', () => switchPhase('solve'));

function updateStepList() {
  if (!currentSolution) return;
  const moves = parseMoves(currentSolution);
  const cur = visualizer.getStepInfo().current - 1;

  // 仅在解法串变化时重建 DOM
  if (_lastStepListKey !== currentSolution) {
    _lastStepListKey = currentSolution;
    stepList.innerHTML = '';
    stepItems = [];
    const moves = parseMoves(currentSolution);
    // 阶段分隔线（层先法/桥式）
    const phases = (activePhase === 'solve' && solveData && solveData.phases) ? solveData.phases : null;
    if (phases && phases.length > 0) {
      let moveIdx = 0;
      for (const p of phases) {
        // 阶段标题
        const hdr = document.createElement('div');
        hdr.className = 'phase-header';
        hdr.textContent = `${p.name} (${p.moves.length}步)`;
        stepList.appendChild(hdr);
        // 阶段内的步骤
        for (let k = p.startStep; k < p.endStep; k++) {
          const item = document.createElement('span');
          item.className = 'step-item';
          item.innerHTML = `<span class="step-num">${k+1}</span>${moves[k]}`;
          const idx = k;
          item.addEventListener('click', () => visualizer.jumpToStep(idx));
          stepList.appendChild(item);
          stepItems.push(item);
        }
      }
    } else {
      moves.forEach((m, i) => {
        const item = document.createElement('span');
        item.className = 'step-item';
        item.innerHTML = `<span class="step-num">${i+1}</span>${m}`;
        item.addEventListener('click', () => visualizer.jumpToStep(i));
        stepList.appendChild(item);
        stepItems.push(item);
      });
    }
  }

  // 每次只更新 CSS 类
  for (let i = 0; i < stepItems.length; i++) {
    stepItems[i].className = 'step-item' + (i === cur ? ' current' : (i < cur ? ' done' : ''));
  }
}

// ─── 播放控制 ───
  // 重新从头播放当前阶段（播放按钮在播完后仍可点：从头开始）
  playBtn.addEventListener('click', () => {
    const info = visualizer.getStepInfo();
    if (info.isComplete) {
      // 已播完：重新从头开始
      switchPhase(activePhase || 'solve');
      setTimeout(() => visualizer.play(), 100);
    } else {
      visualizer.play();
    }
    updatePlaybackButtons();
  });
pauseBtn.addEventListener('click', () => { visualizer.pause(); updatePlaybackButtons(); });
prevBtn.addEventListener('click', () => { visualizer.pause(); visualizer.prevStep(); });
nextBtn.addEventListener('click', () => { visualizer.pause(); visualizer.nextStep(); });
speedSelect.addEventListener('change', e => {
  visualizer.setSpeed(parseFloat(e.target.value));
  saveState();
});

// 解法 / 打乱范围选择变化即保存（刷新后恢复）
if (methodSelect) methodSelect.addEventListener('change', () => saveState());
const scrambleRangeEl = document.getElementById('scramble-range');
if (scrambleRangeEl) scrambleRangeEl.addEventListener('change', () => saveState());

function updatePlaybackButtons() {
  const info = visualizer.getStepInfo();
  // 动画进行中不禁用按钮（操作会排队）：只是视觉上禁用态移除
  prevBtn.disabled = info.current <= 1;
  nextBtn.disabled = info.isComplete;
  playBtn.disabled = false;
  playBtn.textContent = visualizer.isPlaying ? '播放中' : '播放';
}

// ─── 页面状态持久化（localStorage）：刷新后恢复魔方/步骤/播放进度 ───
const STORAGE_KEY = 'rubik-solver-state-v1';
let _saveTimer = 0;

function saveState() {
  const data = {
    v: 1,
    savedAt: Date.now(),
    method: methodSelect ? methodSelect.value : 'kociemba',
    scrambleRange: (document.getElementById('scramble-range') || {}).value || '25-30',
    speed: speedSelect ? speedSelect.value : '1',
    cubeState,
    activePhase,
    inputMode: visualizer.inputMode,
    scramble: scrambleData ? {
      moves: scrambleData.moves,
      stepStates: scrambleData.stepStates,
      targetState: scrambleData.targetState,
    } : null,
    solve: solveData ? {
      moves: solveData.moves,
      stepStates: solveData.stepStates,
      moveCount: solveData.moveCount,
      elapsed: solveData.elapsed,
      rotation: solveData.rotation,
      phases: solveData.phases,
      method: solveData.method,
    } : null,
    currentStep: visualizer.currentStep,
    camera: {
      x: visualizer.camera.position.x,
      y: visualizer.camera.position.y,
      z: visualizer.camera.position.z,
      tx: visualizer._target.x,
      ty: visualizer._target.y,
      tz: visualizer._target.z,
    },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // 隐私模式 / 配额满：静默失败，不影响使用
  }
}

/** 节流版保存：播放步进等高频场景用 */
function throttledSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = 0; saveState(); }, 300);
}

/** 刷新后恢复页面状态；无有效缓存则静默返回 */
function restoreState() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) { return; }
  if (!raw) return;
  let d;
  try { d = JSON.parse(raw); } catch (_) { return; }
  if (!d || typeof d.cubeState !== 'string' || d.cubeState.length !== 54) return;

  // UI 选择
  if (methodSelect && d.method) methodSelect.value = d.method;
  const rangeEl = document.getElementById('scramble-range');
  if (rangeEl && d.scrambleRange) rangeEl.value = d.scrambleRange;
  if (speedSelect && d.speed) {
    speedSelect.value = d.speed;
    visualizer.setSpeed(parseFloat(d.speed));
  }

  // 数据恢复（校验结构，防旧版本/损坏缓存）
  cubeState = d.cubeState;
  if (d.scramble && Array.isArray(d.scramble.moves)) scrambleData = d.scramble;
  if (d.solve && Array.isArray(d.solve.moves)) solveData = d.solve;

  visualizer.setCubeState(cubeState);
  visualizer.setInputMode(d.inputMode !== false);

  const hasSession =
    (d.activePhase === 'scramble' || d.activePhase === 'solve') &&
    ((d.activePhase === 'scramble' && scrambleData) || (d.activePhase === 'solve' && solveData));

  if (hasSession) {
    activePhase = d.activePhase;
    const m = activePhase === 'solve' ? solveData : scrambleData;
    // 从会话初始态（stepStates[0]）重建魔方，再按真实播放路径物理快进。
    // 不能只改贴纸颜色：层动画旋转的是 cubelet 物理姿态，贴纸直改会与之脱节，
    // 导致后续步骤转到错误的块、最终魔方错乱。
    const initState = (m.stepStates && m.stepStates.length) ? m.stepStates[0] : cubeState;
    visualizer.setCubeState(initState);
    visualizer.setSolution(m.moves, m.stepStates);
    playbackControls.style.display = 'flex';
    modeTabs.style.display = 'flex';
    // 注：stepStates[0] 已是 worker 朝向归一后的状态（rotation 已包含在内），
    // 直接重建到位即可；再叠加 intro rotation 会多转一遍导致后续步骤错乱
    const idx = typeof d.currentStep === 'number'
      ? Math.max(0, Math.min(d.currentStep, m.moves.length - 1))
      : -1;
    if (idx >= 0) visualizer.applyMovesInstant(idx);
    // 同步主状态为当前步对应的魔方状态（与渲染一致，求解/状态判定不落后）
    cubeState = (idx >= 0 && m.stepStates && m.stepStates[idx]) ? m.stepStates[idx] : cubeState;
    switchPhase(activePhase, true); // keepCube=true：不动魔方，只重建面板/步骤
  } else {
    // 纯涂色 / 手动状态
    currentSolution = null;
    stepList.innerHTML = '<p class="empty-hint">在 3D 魔方上点击涂色后点击「求解」</p>';
    _lastStepListKey = '';
    stepItems = [];
    solutionInfo.innerHTML = '';
    playbackControls.style.display = 'none';
    modeTabs.style.display = 'none';
    setPhaseTag(null);
  }

  // 视角恢复（容错：旧缓存可能没有）
  if (d.camera) {
    try {
      visualizer.camera.position.set(d.camera.x, d.camera.y, d.camera.z);
      visualizer._target.set(d.camera.tx, d.camera.ty, d.camera.tz);
      visualizer.controls.update();
      visualizer._dirty = true;
    } catch (_) {}
  }

  refreshPalette();
  refreshStatus();
  updatePlaybackButtons();
  showToast('已恢复上次刷新时的状态');
}

// ─── 启动 ───
buildPalette();
refreshStatus();
restoreState();
// 视角变化即保存（刷新后恢复视角）；controls.update/阻尼期间高频触发，用节流兜住
visualizer.controls.addEventListener('change', throttledSave);
initWorker();
