/**
 * solver-worker.js
 * 在 Web Worker 中运行 cubejs Kociemba 两阶段求解器
 *
 * cubejs 使用 CommonJS + IIFE `.call(this)` 模式，与 Vite ESM 不兼容。
 * 这里通过 ?raw 导入源码 + new Function() 在正确的上下文中执行。
 *
 * 查找表持久化：Kociemba initSolver() 生成查找表需要秒级计算，
 * 首次生成后序列化存入 IndexedDB；之后刷新页面直接恢复（毫秒级）。
 * cubejs 升级或表结构变化时，修改 TABLES_KEY 即可让旧缓存自动失效重建。
 */
import cubeSource from '../node_modules/cubejs/lib/cube.js?raw';
import solveSource from '../node_modules/cubejs/lib/solve.js?raw';
import { solveLBL, solveRoux } from './phase-solvers.js';

let Cube = null;
let initialized = false;

// ═══ 引擎查找表持久化（IndexedDB）══════════════════════════════
const TABLES_DB_NAME = 'rubik-solver-tables';
const TABLES_STORE = 'tables';
const TABLES_KEY = 'kociemba-tables-v1'; // 表结构版本：cubejs 升级时递增使旧缓存失效

// 表形状常量（与 cubejs solve.js 内部常量严格一致，反序列化时逐表校验）
const MOVE_TABLE_SHAPES = {
  // name: [rows, cols] —— moveTables[name][index][move]
  parity: [2, 18],          // 内置小表
  twist: [2187, 18],        // N_TWIST
  flip: [2048, 18],         // N_FLIP
  FRtoBR: [11880, 18],      // N_FRtoBR
  URFtoDLF: [20160, 18],    // N_URFtoDLF
  URtoDF: [20160, 18],      // N_URtoDF（相位2）
  URtoUL: [1320, 18],       // N_URtoUL
  UBtoDF: [1320, 18],       // N_UBtoDF
  mergeURtoDF: [336, 336],
};

const PRUNE_TABLE_SLOTS = {
  // name: 32 位槽位数（8 个坐标值打包进一个槽，长度 = ceil(size/8)）
  sliceTwist: Math.ceil(495 * 2187 / 8),
  sliceFlip: Math.ceil(495 * 2048 / 8),
  sliceURFtoDLFParity: Math.ceil(24 * 20160 * 2 / 8),
  sliceURtoDFParity: Math.ceil(24 * 20160 * 2 / 8),
};

/** 打开缓存库；不可用（隐私模式/无 IndexedDB）时返回 null，回退为每次生成 */
function openTablesDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let settled = false;
    let req;
    const done = (val) => {
      if (settled) { if (val) val.close(); return; } // 已超时放弃：关闭迟到的连接
      settled = true;
      resolve(val);
    };
    try { req = indexedDB.open(TABLES_DB_NAME, 1); }
    catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TABLES_STORE)) {
        req.result.createObjectStore(TABLES_STORE);
      }
    };
    req.onsuccess = () => done(req.result);
    req.onerror = () => done(null);
    req.onblocked = () => done(null); // 旧版本连接被其他标签页占用：直接回退生成
  });
}

function readTables(db) {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(TABLES_STORE, 'readonly')
        .objectStore(TABLES_STORE).get(TABLES_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

function writeTables(db, payload) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(TABLES_STORE, 'readwrite');
      tx.objectStore(TABLES_STORE).put(payload, TABLES_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('tables write failed'));
      tx.onabort = () => reject(tx.error || new Error('tables write aborted'));
    } catch (e) { reject(e); }
  });
}

/** Cube 内存表 → 可结构化克隆的二进制载荷 */
function serializeTables() {
  const moveTables = {};
  for (const [name, [rows, cols]] of Object.entries(MOVE_TABLE_SHAPES)) {
    const flat = new Uint16Array(rows * cols); // 所有表值均 < 65536
    const src = Cube.moveTables[name];
    for (let i = 0; i < rows; i++) flat.set(src[i], i * cols);
    moveTables[name] = flat;
  }
  const pruneTables = {};
  for (const [name, slots] of Object.entries(PRUNE_TABLE_SLOTS)) {
    const src = Cube.pruningTables[name];
    const u32 = new Uint32Array(slots);
    for (let i = 0; i < slots; i++) u32[i] = src[i];
    pruneTables[name] = u32;
  }
  return { key: TABLES_KEY, moveTables, pruneTables };
}

/** 载荷 → Cube 内存表；任何校验失败返回 false（视为坏缓存，重建） */
function deserializeIntoCube(data) {
  try {
    if (!data || data.key !== TABLES_KEY) return false;
    const { moveTables: mt, pruneTables: pt } = data;
    if (!mt || !pt) return false;
    for (const [name, [rows, cols]] of Object.entries(MOVE_TABLE_SHAPES)) {
      const t = mt[name];
      if (!(t instanceof Uint16Array) || t.length !== rows * cols) return false;
    }
    for (const [name, slots] of Object.entries(PRUNE_TABLE_SLOTS)) {
      const t = pt[name];
      if (!(t instanceof Uint32Array) || t.length !== slots) return false;
    }
    // moveTables 重建为行视图（保持 [index][move] 二维访问；行间共享底层 buffer）
    for (const [name, [rows, cols]] of Object.entries(MOVE_TABLE_SHAPES)) {
      const flat = mt[name];
      const rowsArr = new Array(rows);
      for (let i = 0; i < rows; i++) rowsArr[i] = flat.subarray(i * cols, (i + 1) * cols);
      Cube.moveTables[name] = rowsArr;
    }
    // pruningTables 直接用 Uint32Array（solve.js 位运算读写均兼容）
    for (const name of Object.keys(PRUNE_TABLE_SLOTS)) {
      Cube.pruningTables[name] = pt[name];
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** 引擎初始化：优先恢复缓存，未命中才生成并持久化 */
async function initEngine() {
  Cube = loadCube();
  const db = await openTablesDB();
  let fromCache = false;
  if (db) {
    try {
      const cached = await readTables(db);
      fromCache = deserializeIntoCube(cached);
    } catch (e) { fromCache = false; }
  }
  if (!fromCache) {
    Cube.initSolver();
    if (db) {
      try { await writeTables(db, serializeTables()); }
      catch (e) { /* 持久化失败不影响本次会话使用 */ }
    }
  }
  if (db) db.close();
  ORIENTS = buildOrientations();
  initialized = true;
  self.postMessage({ type: 'init_done', cached: fromCache });
}

// ─── 24 朝向归一（用于中层 M/E/S 状态求解）───
const CENTER_IDX = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };

function centersStandard(s) {
  return s[4] === 'U' && s[13] === 'R' && s[22] === 'F' &&
         s[31] === 'D' && s[40] === 'L' && s[49] === 'B';
}

let ORIENTS = null;

/**
 * 枚举 24 个整体旋转朝向（x/y/z 组合），用中心排列去重
 * 每个朝向是一个 move 序列，如 ['x', "y'"]
 */
function buildOrientations() {
  const seen = new Map();
  // 6 个"朝上面"选择 × 4 个 y 轴旋转 = 24 个唯一朝向
  const bases = [[], ['x'], ['x2'], ["x'"], ['z'], ["z'"]];
  const yRotations = [[], ['y'], ['y2'], ["y'"]];

  for (const base of bases) {
    for (const yr of yRotations) {
      const seq = [...base, ...yr];
      const c = new Cube();
      if (seq.length) c.move(seq.join(' '));
      const s = c.asString();
      const sig = ['U','R','F','D','L','B'].map(f => s[CENTER_IDX[f]]).join('');
      if (!seen.has(sig)) {
        seen.set(sig, seq);
      }
    }
  }
  return [...seen.values()];
}

function loadCube() {
  if (Cube) return Cube;

  const context = {};
  const moduleObj = { exports: {} };

  // 1. 加载 cube.js
  // 源码结构: (function() { ... module.exports = Cube ... }).call(this)
  // 提供 module 参数使其走 module.exports 分支
  const cubeFn = new Function('module', 'exports', cubeSource);
  cubeFn.call(context, moduleObj, moduleObj.exports);

  Cube = moduleObj.exports;
  if (!Cube) {
    // 回退: 尝试 this.Cube
    Cube = context.Cube;
  }
  if (!Cube) {
    throw new Error('Failed to load Cube from cube.js');
  }

  // 2. 加载 solve.js
  // 源码第5行: Cube = this.Cube || require('./cube')
  // 设置 context.Cube 使其走 this.Cube 分支
  context.Cube = Cube;
  const solveFn = new Function('module', 'exports', 'require', solveSource);
  const requireFn = (path) => {
    if (path === './cube') return Cube;
    throw new Error('Cannot require ' + path);
  };
  solveFn.call(context, moduleObj, moduleObj.exports, requireFn);

  return Cube;
}

self.onmessage = function(e) {
  const { type, data } = e.data;

  if (type === 'init') {
    if (!initialized) {
      self.postMessage({ type: 'init_progress', message: '正在生成查找表...' });
      initEngine().catch((err) => {
        self.postMessage({ type: 'init_error', error: err.message + '\n' + err.stack });
      });
    } else {
      self.postMessage({ type: 'init_done' });
    }
  } else if (type === 'solve') {
    if (!initialized) {
      self.postMessage({ type: 'solve_error', error: '求解器尚未初始化' });
      return;
    }
    try {
      const stateStr = data.facelets;
      const method = data.method || 'kociemba';

      // 检查中心块是否标准（M/E/S 状态需要朝向归一）
      let rotation = null;
      let solveState = stateStr;

      if (!centersStandard(stateStr)) {
        let foundSeq = null;
        for (const seq of ORIENTS) {
          const c0 = Cube.fromString(stateStr);
          if (seq.length) c0.move(seq.join(' '));
          if (centersStandard(c0.asString())) {
            foundSeq = seq;
            solveState = c0.asString();
            break;
          }
        }
        if (!foundSeq) {
          self.postMessage({ type: 'solve_error', error: '无法找到朝向归一（可能不是合法魔方状态）' });
          return;
        }
        rotation = foundSeq.length ? foundSeq.join(' ') : null;
      }

      let sol, moveCount, stepStates, phases = null, methodName, timings = null;

      if (method === 'lbl' || method === 'roux') {
        // 层先法 / 桥式：分阶段求解（排列在求解器内部自动初始化）
        const result = method === 'lbl' ? solveLBL(solveState) : solveRoux(solveState);
        sol = result.solution;
        moveCount = result.moveCount;
        stepStates = result.stepStates;
        phases = result.phases;
        timings = result.timings || null;
        methodName = method === 'lbl' ? '层先法' : '桥式';
      } else {
        // Kociemba 两阶段
        const cube = Cube.fromString(solveState);
        sol = cube.solve();
        const moves = sol.trim().split(/\s+/);
        moveCount = moves.length;
        stepStates = [solveState];
        const stepCube = Cube.fromString(solveState);
        for (const m of moves) {
          stepCube.move(m);
          stepStates.push(stepCube.asString());
        }
        methodName = 'Kociemba 两阶段法';
      }

      self.postMessage({
        type: 'solve_done',
        solution: sol,
        moveCount: moveCount,
        stepStates: stepStates,
        rotation: rotation,
        phases: phases,
        timings: timings,
        method: methodName,
      });
    } catch (err) {
      self.postMessage({ type: 'solve_error', error: err.message });
    }
  } else if (type === 'test_moves') {
    // 调试用：从 solved 状态依次应用给定 moves，返回每个 move 后的状态
    if (!initialized) {
      self.postMessage({ type: 'test_moves_error', error: '求解器尚未初始化' });
      return;
    }
    try {
      const solved = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
      const results = {};
      const allMoves = data.moves;
      for (const m of allMoves) {
        const c = Cube.fromString(solved);
        c.move(m);
        results[m] = c.asString();
      }
      self.postMessage({ type: 'test_moves_done', results });
    } catch (err) {
      self.postMessage({ type: 'test_moves_error', error: err.message });
    }
  } else if (type === 'scramble') {
    if (!initialized) {
      self.postMessage({ type: 'scramble_error', error: '求解器尚未初始化' });
      return;
    }
    try {
      // 随机打乱：步数范围由 UI 指定（默认 25~30，最少 25 步，
      // 长于最差复原解 ~23 步，保证打乱步骤 > 复原步骤）
      const d = data || {};
      const minLen = Math.max(25, d.minLen || 25);
      const maxLen = Math.max(minLen, d.maxLen || minLen + 5);
      const BASE_MOVES = ['R', 'R2', "R'", 'L', 'L2', "L'", 'U', 'U2', "U'", 'D', 'D2', "D'", 'F', 'F2', "F'", 'B', 'B2', "B'",
        'M', 'M2', "M'", 'E', 'E2', "E'", 'S', 'S2', "S'"];
      const targetLen = minLen + Math.floor(Math.random() * (maxLen - minLen + 1));
      const moves = [];
      let lastFace = '';
      let lastFace2 = '';
      while (moves.length < targetLen) {
        const m = BASE_MOVES[Math.floor(Math.random() * BASE_MOVES.length)];
        const face = m[0];
        // 避免同面连续、避免 ABA 三连（会抵消一部分）
        if (face === lastFace) continue;
        if (face === lastFace2 && lastFace === moves[moves.length - 1]?.[0]) continue;
        moves.push(m);
        lastFace2 = lastFace;
        lastFace = face;
      }

      const cube = new Cube();
      const stepStates = [cube.asString()];
      for (const m of moves) {
        cube.move(m);
        stepStates.push(cube.asString());
      }
      const scramble = moves.join(' ');
      self.postMessage({
        type: 'scramble_done',
        scramble: scramble,
        facelets: stepStates[stepStates.length - 1],
        stepStates: stepStates,
      });
    } catch (err) {
      self.postMessage({ type: 'scramble_error', error: err.message });
    }
  }
};
