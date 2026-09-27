/**
 * phase-solvers.js
 * 层先法 (LBL) 与桥式 (Roux) 分阶段求解器 — v2 全量重写
 *
 * v1 有两处致命缺陷（均已在本版修复）：
 *   1) v1 用"标记颜色法"从 Cube.fromString 提取移动排列。cubejs 的 fromString
 *      内部按块级颜色对精确匹配解析，标记后的非法状态（如 UF 棱变 [R,F] 与
 *      FR 棘撞色、角块出现双 U 色）导致解析结果损坏 → 排列系统性错误 → BFS 永远找不到解。
 *      v2 改为纯几何法：54 个面块坐标 + 坐标旋转矩阵直接生成排列（见 buildMovePerms），
 *      并用 cubejs 在合法状态上交叉验证。
 *   2) v1 各阶段 BFS 的 check/hash 只覆盖本阶段目标块，返回的解会破坏已解部分
 *      （如底面角阶段的解弄乱底面十字），拖到末层才发现无法复原。
 *      v2 遵循 C 集合原则：每步 BFS 的 check 与 hash 覆盖同一块集合
 *      （已解块 + 目标块）。数学保证：关心块集合演化封闭 ⇒ 剪枝安全；
 *      check 含已解块 ⇒ 返回解不破坏已解部分。
 *
 * 分层策略：
 *   - 底层/中层/桥：逐块块级 BFS（visited 大小被块集状态数封顶，可控）
 *   - 末层（OLL/PLL/CMLL/LSE）：抽象状态 BFS（动作 = 保已解部分的标准算法序列，
 *     状态空间只含关心块，毫秒级求解）
 */

// ════════════════════════════════════════
//  常量与块表
// ════════════════════════════════════════

export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const CHARS = 'URFDLB'; // 面索引 0-5 对应的色
const CODE = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };

// 棱块槽位 → [面块1索引, 面块2索引]（Kociemba facelet 布局，已验证自洽）
const EDGE_SLOTS = [
  [7, 19],   // 0: UF
  [5, 10],   // 1: UR
  [1, 46],   // 2: UB
  [3, 37],   // 3: UL
  [28, 25],  // 4: DF
  [32, 16],  // 5: DR
  [34, 52],  // 6: DB
  [30, 43],  // 7: DL
  [23, 12],  // 8: FR
  [21, 41],  // 9: FL
  [14, 48],  // 10: BR
  [39, 50],  // 11: BL
];

// 角块槽位 → [面块1, 面块2, 面块3]
// 顺序必须手性一致（顺时针序，与 cubejs cornerFacelet 相同），
// 否则循环移位匹配失败（如 URB 应为 [U,B,R] 而非 [U,R,B]）
const CORNER_SLOTS = [
  [8, 9, 20],     // 0: UFR [U,R,F]
  [2, 45, 11],    // 1: URB [U,B,R]
  [0, 36, 47],    // 2: UBL [U,L,B]
  [6, 18, 38],    // 3: ULF [U,F,L]
  [29, 26, 15],   // 4: DFR [D,F,R]
  [35, 17, 51],   // 5: DRB [D,R,B]
  [33, 53, 42],   // 6: DBL [D,B,L]
  [27, 44, 24],   // 7: DLF [D,L,F]
];

// 中心面块索引
const CENTER_IDX = [4, 13, 22, 31, 40, 49];

// 各槽位的标准颜色（字符）
const EDGE_COLORS = EDGE_SLOTS.map(([a, b]) => [SOLVED[a], SOLVED[b]]);
const CORNER_COLORS = CORNER_SLOTS.map(([a, b, c]) => [SOLVED[a], SOLVED[b], SOLVED[c]]);
// 编码后的颜色（BFS 内部用数字比较）
const EDGE_CC = EDGE_COLORS.map(p => p.map(c => CODE[c]));
const CORNER_CC = CORNER_COLORS.map(p => p.map(c => CODE[c]));

// 块定义工厂。编码约定：
//   棱值   v = slot*2 + flip        (slot = v>>1, flip = v&1)
//   角值   v = slot*3 + twist       (slot = (v/3)|0, twist = v%3)
//   中心值 v = 所在面索引 0-5
const blkE = slot => ({ t: 'e', c: EDGE_CC[slot], home: slot * 2 });
const blkC = slot => ({ t: 'c', c: CORNER_CC[slot], home: slot * 3 });
const blkM = face => ({ t: 'm', c: face, home: face }); // face: 0-5 面索引即色码

const face3 = f => [f, f + '2', f + "'"];
const ALL_MOVES = ['U', 'D', 'F', 'B', 'R', 'L'].flatMap(face3);
const U_MOVES = ['U', 'U2', "U'"];

// ════════════════════════════════════════
//  几何法生成移动排列
// ════════════════════════════════════════

// 面定义：[面字符, 中心(=法线), 从面外看的右方向, 从面外看的下方向]
const FACE_DEFS = [
  ['U', [0, 1, 0], [1, 0, 0], [0, 0, 1]],
  ['R', [1, 0, 0], [0, 0, -1], [0, -1, 0]],
  ['F', [0, 0, 1], [1, 0, 0], [0, -1, 0]],
  ['D', [0, -1, 0], [1, 0, 0], [0, 0, -1]],
  ['L', [-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  ['B', [0, 0, -1], [-1, 0, 0], [0, -1, 0]],
];

// 面顺时针（从面外看）旋转 = 绕面法线轴 -90°
const ROT = {
  U: p => [-p[2], p[1], p[0]],
  D: p => [p[2], p[1], -p[0]],
  R: p => [p[0], p[2], -p[1]],
  L: p => [p[0], -p[2], p[1]],
  F: p => [p[1], -p[0], p[2]],
  B: p => [-p[1], p[0], p[2]],
};

/** 构建 54 个面块的几何坐标（cubie 位置 + 贴纸法线） */
function buildGeometry() {
  const pos = new Array(54), nrm = new Array(54), lookup = new Map();
  for (let f = 0; f < 6; f++) {
    const [, center, right, down] = FACE_DEFS[f];
    const up = down.map(v => -v);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const idx = f * 9 + row * 3 + col;
        const p = [
          center[0] + up[0] * (1 - row) + right[0] * (col - 1),
          center[1] + up[1] * (1 - row) + right[1] * (col - 1),
          center[2] + up[2] * (1 - row) + right[2] * (col - 1),
        ];
        pos[idx] = p;
        nrm[idx] = center; // 法线 = 中心方向
        lookup.set(p.join(',') + '|' + center.join(','), idx);
      }
    }
  }
  return { pos, nrm, lookup };
}

/** 排列复合：先 p1 后 p2 的等效排列 */
function composePerm(p1, p2) {
  const out = new Uint8Array(54);
  for (let j = 0; j < 54; j++) out[j] = p1[p2[j]];
  return out;
}

/**
 * 生成全部移动排列。
 * perm 语义：newState[j] = oldState[perm[j]]
 */
function buildMovePerms() {
  const { pos, nrm, lookup } = buildGeometry();
  const perms = {};

  // faceSpec: [名称, 转轴索引, 层值(=null 表示整体旋转), 旋转函数]
  const faceSpecs = [
    ...FACE_DEFS.map(([fc, center]) => {
      const axis = center[0] !== 0 ? 0 : center[1] !== 0 ? 1 : 2;
      return [fc, axis, center[axis], ROT[fc]];
    }),
    // 中层转动：M 跟 L 向(x=0)、E 跟 D 向(y=0)、S 跟 F 向(z=0)
    ['M', 0, 0, ROT.L],
    ['E', 1, 0, ROT.D],
    ['S', 2, 0, ROT.F],
    // 整体旋转：x 跟 R 向 / y 跟 U 向 / z 跟 F 向
    ['x', 0, null, ROT.R],
    ['y', 1, null, ROT.U],
    ['z', 2, null, ROT.F],
  ];

  for (const [name, axis, layer, rot] of faceSpecs) {
    const cw = new Uint8Array(54); // CW 的 perm
    for (let i = 0; i < 54; i++) {
      let dst = i;
      if (layer === null || pos[i][axis] === layer) {
        const np = rot(pos[i]), nn = rot(nrm[i]);
        dst = lookup.get(np.join(',') + '|' + nn.join(','));
        if (dst === undefined) throw new Error(`几何排列生成失败: ${name} @${i}`);
      }
      cw[i] = dst;
    }
    // map[i] = i 的新位置 → perm[j] = i (where map[i]=j)
    const permCW = new Uint8Array(54);
    for (let i = 0; i < 54; i++) permCW[cw[i]] = i;
    perms[name] = permCW;
    perms[name + '2'] = composePerm(permCW, permCW);
    perms[name + "'"] = composePerm(permCW, composePerm(permCW, permCW));
  }
  return perms;
}

let MOVE_PERMS = null;

/** 初始化移动排列（参数仅为兼容旧签名，内部几何自足无需 Cube） */
export function initMovePerms() {
  if (!MOVE_PERMS) MOVE_PERMS = buildMovePerms();
  return MOVE_PERMS;
}

// ════════════════════════════════════════
//  状态编解码与快速应用
// ════════════════════════════════════════

function encode(s) {
  const a = new Uint8Array(54);
  for (let i = 0; i < 54; i++) a[i] = CODE[s[i]];
  return a;
}

function decode(a) {
  let s = '';
  for (let i = 0; i < 54; i++) s += CHARS[a[i]];
  return s;
}

function applyArr(state, move) {
  const p = MOVE_PERMS[move];
  const out = new Uint8Array(54);
  for (let i = 0; i < 54; i++) out[i] = state[p[i]];
  return out;
}

/** 对字符串状态应用单步移动 */
export function applyMove(stateStr, move) {
  return decode(applyArr(encode(stateStr), move));
}

/** 提取块集状态：返回与 blocks 等长的编码值数组（查表版，按 blocks 集合缓存提取器） */
const _extractorCache = new Map();

/** 预构建"槽位颜色组合 → (块索引, 朝向)"映射，提取时扫一遍槽位即可得全部块值 */
function makeBlockExtractor(blocks) {
  const cacheKey = blocks.map(b => b.t + b.home).join('|');
  if (_extractorCache.has(cacheKey)) return _extractorCache.get(cacheKey);

  const n = blocks.length; // 快照长度：调用方可能传入持续累积的可变数组（solveRoux 桥阶段），闭包必须固定

  // 棱：色对 key = c1*6+c2 → { bi, flip }（两种序 = 是否翻转）
  const edgeMap = new Map();
  const cornerMap = new Map(); // 角：色三 key = c1*36+c2*6+c3 → { bi, twist }（3 个循环移位）
  const centerMap = new Map(); // 中心：色 → bi

  blocks.forEach((b, bi) => {
    if (b.t === 'e') {
      const [c1, c2] = b.c;
      edgeMap.set(c1 * 6 + c2, { bi, flip: 0 });
      edgeMap.set(c2 * 6 + c1, { bi, flip: 1 });
    } else if (b.t === 'c') {
      const [c1, c2, c3] = b.c;
      cornerMap.set(c1 * 36 + c2 * 6 + c3, { bi, twist: 0 });
      cornerMap.set(c2 * 36 + c3 * 6 + c1, { bi, twist: 1 });
      cornerMap.set(c3 * 36 + c1 * 6 + c2, { bi, twist: 2 });
    } else {
      centerMap.set(b.c, bi);
    }
  });

  const nE = EDGE_SLOTS.length, nC = CORNER_SLOTS.length;
  const extract = (state) => {
    const out = new Array(n).fill(-1);
    for (let i = 0; i < nE; i++) {
      const e = edgeMap.get(state[EDGE_SLOTS[i][0]] * 6 + state[EDGE_SLOTS[i][1]]);
      if (e !== undefined) out[e.bi] = i * 2 + e.flip;
    }
    for (let i = 0; i < nC; i++) {
      const [f1, f2, f3] = CORNER_SLOTS[i];
      const e = cornerMap.get(state[f1] * 36 + state[f2] * 6 + state[f3]);
      if (e !== undefined) out[e.bi] = i * 3 + e.twist;
    }
    if (centerMap.size) {
      for (let f = 0; f < 6; f++) {
        const bi = centerMap.get(state[CENTER_IDX[f]]);
        if (bi !== undefined) out[bi] = f;
      }
    }
    return out;
  };
  _extractorCache.set(cacheKey, extract);
  return extract;
}

function blockStates(state, blocks) {
  return makeBlockExtractor(blocks)(state);
}

// ════════════════════════════════════════
//  通用块级 BFS（C 集合原则）+ IDA* 快速路径
// ════════════════════════════════════════

/** 目标：blocks 全部处于各自标准位（home） */
const allHome = blocks => st => {
  for (let i = 0; i < blocks.length; i++) if (st[i] !== blocks[i].home) return false;
  return true;
};

function moveInverse(m) {
  if (m.endsWith('2')) return m;
  return m.endsWith("'") ? m[0] : m + "'";
}

// 块距离表缓存：key = 移动集 + 块集
const _distCache = new Map();

/**
 * 预计算每个块从任意状态到 home 的最短步数（受限移动集内）。
 * 移动集必须含逆（face3/U-M 系天然满足），否则返回 null（调用方回退 BFS）。
 * 返回 dists[bi][v]，未初始化为 -1（受限移动集下可能有态不可达 home）。
 */
function blockDistTables(blocks, moves) {
  const mk = moves.slice().sort().join(' ') + '::' + blocks.map(b => b.t + b.home).join('|');
  if (_distCache.has(mk)) return _distCache.get(mk);

  for (const m of moves) {
    if (!moves.includes(moveInverse(m))) {
      _distCache.set(mk, null); // 不含逆：距离不对称，IDA* 启发不可用
      return null;
    }
  }

  const acts = moves.map(m => makeAction(m, m));
  const tables = blocks.map((b) => {
    const size = b.t === 'm' ? 6 : 24; // 棱 12槽×2翻 / 角 8槽×3扭 / 中心 6 面
    const dist = new Int8Array(size).fill(-1);
    dist[b.home] = 0;
    const q = [b.home];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      if (b.t === 'e') {
        const s0 = v >> 1, f0 = v & 1;
        for (const a of acts) {
          const w = a.Pe[s0] * 2 + (f0 ^ a.Fe[s0]);
          if (dist[w] < 0) { dist[w] = dist[v] + 1; q.push(w); }
        }
        continue;
      } else if (b.t === 'c') {
        const s0 = (v / 3) | 0, f0 = v % 3;
        for (const a of acts) {
          const w = a.Pc[s0] * 3 + ((f0 + a.Tc[s0]) % 3);
          if (dist[w] < 0) { dist[w] = dist[v] + 1; q.push(w); }
        }
        continue;
      } else {
        for (const a of acts) {
          const w = a.Pm[v];
          if (dist[w] < 0) { dist[w] = dist[v] + 1; q.push(w); }
        }
        continue;
      }
    }
    return dist;
  });
  _distCache.set(mk, tables);
  return tables;
}

/**
 * IDA*：启发 h = max(各块到 home 的最短步数)。
 * 单块空间内一步移动至多让一块距离减 1，h 可采纳 ⇒ 搜索结果保持最短。
 * 仅适用于 homeGoal（isDone = allHome）调用点——其他目标（如"取出到顶层"）
 * 的 h 会高估真实距离，不可采纳，必须走 BFS。
 */
function idaStarSearch(s0, st0, blocks, moves, isDone, dists, maxNodes) {
  const n = blocks.length;
  const path = [];
  let nodes = 0;

  const h = (st) => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const d = dists[i][st[i]];
      if (d < 0) return Infinity; // 该块在受限移动集下无法回到 home：整支剪掉
      if (d > m) m = d;
    }
    return m;
  };

  const dfs = (g, bound, s, st, lastFace, hVal) => {
    if (isDone(st)) return true;
    if (++nodes > maxNodes) return false; // 超保护上限：整体失败，由调用方回退
    for (const mv of moves) {
      if (mv[0] === lastFace) continue;
      const ns = applyArr(s, mv);
      const nst = blockStates(ns, blocks);
      const nh = h(nst);
      if (nh === Infinity || g + 1 + nh > bound) continue; // 生成时剪枝，不入栈
      path.push(mv);
      if (dfs(g + 1, bound, ns, nst, mv[0], nh)) return true;
      path.pop();
    }
    return false;
  };

  const h0 = h(st0);
  for (let bound = h0; bound <= 18; bound++) {
    nodes = 0;
    if (dfs(0, bound, s0, st0, '', h0)) return path.slice();
    if (nodes > maxNodes) return null;
  }
  return null;
}

/**
 * 块级 BFS：在 moves 允许的移动中找最短序列。
 *  - check 与 hash 天然覆盖同一块集（blockStates），满足 C 集合原则
 *  - isDone(st)：基于块状态数组的目标判定
 *  - homeGoal=true 且移动集含逆时走 IDA* 快速路径（启发剪枝，节点数数量级下降，
 *    解仍最短）；否则回退宽度优先 BFS（行为与旧版一致）
 * 返回 moves 数组，失败返回 null
 */
function solveBlocksBFS(startStr, blocks, moves, isDone, maxNodes = 1_500_000, homeGoal = false) {
  const s0 = encode(startStr);
  const st0 = blockStates(s0, blocks);
  if (st0.includes(-1)) throw new Error('非法魔方状态：块缺失');
  if (isDone(st0)) return [];

  if (homeGoal) {
    const dists = blockDistTables(blocks, moves);
    if (dists) {
      const fast = idaStarSearch(s0, st0, blocks, moves, isDone, dists, maxNodes);
      if (fast) return fast;
      // IDA* 未命中（理论上仅在保护上限触发时发生）：回退 BFS 兜底
    }
  }

  const visited = new Set([packKey(st0)]);
  const queue = [{ s: s0, p: -1, m: null }];
  let head = 0, nodes = 0;

  while (head < queue.length && nodes < maxNodes) {
    const cur = queue[head];
    const lastFace = cur.m ? cur.m[0] : '';
    for (const mv of moves) {
      if (mv[0] === lastFace) continue;
      const ns = applyArr(cur.s, mv);
      nodes++;
      const st = blockStates(ns, blocks);
      if (isDone(st)) {
        const seq = [mv];
        let n = cur;
        while (n.p >= 0) { seq.unshift(n.m); n = queue[n.p]; }
        return seq;
      }
      const h = packKey(st);
      if (!visited.has(h)) {
        visited.add(h);
        queue.push({ s: ns, p: head, m: mv });
      }
    }
    head++;
  }
  return null;
}

// ════════════════════════════════════════
//  抽象状态 BFS（末层专用，动作 = 保已解部分的标准算法）
// ════════════════════════════════════════

// 内部函数导出（供测试脚本使用）
export const _internal = { makeAction, abstractBFS, absBFSBidirHome, applyActionToState, blockStates, encode, decode, allHome, blkE, blkC, blkM, U_MOVES };

/** makeAction 结果缓存：固定算法（Sune/T-perm/基础 move 等）每次求解
 *  都会重建，key = 规范化 move 序列串，重复构建是纯浪费 */
const _actionCache = new Map();

/**
 * 从 SOLVED 预计算一个动作序列对全部块的置换效果。
 * Pe/Fe: 棱的槽位映射与翻转增量；Pc/Tc: 角的槽位映射与扭转增量；Pm: 中心面映射。
 */
function makeAction(name, moves) {
  const seq = Array.isArray(moves) ? moves : moves.split(/\s+/);
  const cacheKey = seq.join(' ');
  if (_actionCache.has(cacheKey)) return _actionCache.get(cacheKey);
  let s = encode(SOLVED);
  for (const m of seq) s = applyArr(s, m);

  const Pe = new Int8Array(12), Fe = new Int8Array(12);
  const Pc = new Int8Array(8), Tc = new Int8Array(8);
  const Pm = new Int8Array(6);

  for (let i = 0; i < 12; i++) {
    const st = blockStates(s, [blkE(i)]);
    Pe[i] = st[0] >> 1; Fe[i] = st[0] & 1;
  }
  for (let i = 0; i < 8; i++) {
    const st = blockStates(s, [blkC(i)]);
    Pc[i] = (st[0] / 3) | 0; Tc[i] = st[0] % 3;
  }
  for (let i = 0; i < 6; i++) {
    const st = blockStates(s, [blkM(i)]);
    Pm[i] = st[0];
  }
  const action = { name, moves: seq, Pe, Fe, Pc, Tc, Pm };
  _actionCache.set(cacheKey, action);
  return action;
}

/** 将动作效果应用到抽象状态（blockStates 编码数组） */
function applyActionToState(st, blocks, act) {
  const out = new Array(st.length);
  for (let i = 0; i < st.length; i++) {
    const b = blocks[i];
    if (b.t === 'e') {
      const s0 = st[i] >> 1, f0 = st[i] & 1;
      out[i] = act.Pe[s0] * 2 + (f0 ^ act.Fe[s0]);
    } else if (b.t === 'c') {
      const s0 = (st[i] / 3) | 0, t0 = st[i] % 3;
      out[i] = act.Pc[s0] * 3 + ((t0 + act.Tc[s0]) % 3);
    } else {
      out[i] = act.Pm[st[i]];
    }
  }
  return out;
}

/**
 * 块状态数组 → 紧凑去重键：每块值 ≤23（棱/角）或 ≤5（中心），5bit 一段。
 * ≤10 块拼成一个安全整数（≤50bit，Number 精度内）用 Set<number> 哈希；
 * 更长时分段（每段 ≤10 块），段间用 '|' join——远快于逐数字 join。
 */
function packKey(st) {
  const n = st.length;
  if (n <= 10) {
    let k = 0;
    for (let i = 0; i < n; i++) k = k * 32 + st[i];
    return k;
  }
  const parts = [];
  for (let i = 0; i < n; i += 10) {
    let k = 0;
    const end = Math.min(i + 10, n);
    for (let j = i; j < end; j++) k = k * 32 + st[j];
    parts.push(k);
  }
  return parts.join('|');
}

/**
 * 抽象 BFS：状态 = 关心块的 blockStates 编码，动作 = makeAction 预计算的算法。
 * 动作本身保已解部分，因此抽象空间只需关心目标块。
 * 返回展开后的 moves 数组，失败返回 null。
 */
function abstractBFS(startStr, blocks, actions, isDone, maxDepth = 6) {
  const s0 = encode(startStr);
  const st0 = blockStates(s0, blocks);
  if (st0.includes(-1)) throw new Error('非法魔方状态：块缺失');
  if (isDone(st0)) return [];

  const visited = new Set([packKey(st0)]);
  const queue = [{ st: st0, d: 0, path: [] }];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.d >= maxDepth) continue;
    for (const act of actions) {
      const nst = applyActionToState(cur.st, blocks, act);
      const npath = [...cur.path, act];
      if (isDone(nst)) return npath.flatMap(a => a.moves);
      const h = packKey(nst);
      if (!visited.has(h)) {
        visited.add(h);
        queue.push({ st: nst, d: cur.d + 1, path: npath });
      }
    }
  }
  return null;
}

/**
 * 双向抽象 BFS（目标态唯一 = 全部块 home 的场景）。
 * 前向从起点、后向从目标态逐层交替扩展，相遇拼接路径。
 * 深目标搜索（如 LSE 4c、桥块插入，解可达十几步）的扩展量从
 * "全空间逐层"降为两侧各半深度的乘积级，快几个数量级。
 * 动作须为单个基础 move（含逆），返回展开后的 moves 数组，失败返回 null。
 * maxNodes：两侧累计生成节点上限（防不可达样本下对向扩展无界膨胀），
 * 默认 Infinity 不限制（LSE 4c 解深场景正常远小于此）。
 */
function absBFSBidirHome(startStr, blocks, actions, maxNodes = Infinity) {
  const s0 = encode(startStr);
  const st0 = blockStates(s0, blocks);
  if (st0.includes(-1)) throw new Error('非法魔方状态：块缺失');
  const goal = blocks.map(b => b.home);
  const kStart = packKey(st0);
  if (kStart === packKey(goal)) return [];

  // 逆动作（挂 fwd 引用便于拼接时映射回正向）
  const invActs = actions.map(a => {
    const mv = a.moves[0];
    if (a.moves.length !== 1) throw new Error('absBFSBidirHome 仅支持单 move 动作: ' + a.moves.join(' '));
    const inv = makeAction(a.name + '~', moveInverse(mv));
    inv.fwd = a;
    return inv;
  });

  const fwdMap = new Map([[kStart, []]]);           // key → 前向路径（正动作数组）
  const bwdMap = new Map([[packKey(goal), []]]);    // key → 后向路径（逆动作数组）
  let fLayer = [{ st: st0, path: [] }];
  let bLayer = [{ st: goal, path: [] }];
  let nodes = 0;
  let aborted = false;

  const expand = (layer, visited, other, acts, isFwd) => {
    const next = [];
    for (const node of layer) {
      for (const act of acts) {
        const nst = applyActionToState(node.st, blocks, act);
        const k = packKey(nst);
        if (visited.has(k)) continue;
        const path = [...node.path, act];
        visited.set(k, path);
        if (++nodes > maxNodes) { aborted = true; return null; }
        const hit = other.get(k);
        if (hit !== undefined) {
          if (isFwd) {
            // 前向到 n，后向记录了 goal→n 的逆动作序列：倒序映射回正动作即 n→goal
            return [...path, ...hit.map(ia => ia.fwd).reverse()];
          } else {
            // 后向到 n（n 经正动作 act.fwd 可达 node.st 再到 goal）
            const toGoal = [...node.path.map(ia => ia.fwd).reverse()];
            return [...hit, act.fwd, ...toGoal];
          }
        }
        next.push({ st: nst, path });
      }
    }
    layer.length = 0;
    layer.push(...next);
    return null;
  };

  // 逐层交替扩展（优先扩节点较少的一侧保持平衡），任一侧耗尽即不可达
  while (fLayer.length && bLayer.length && !aborted) {
    const doFwd = fLayer.length <= bLayer.length;
    const sol = doFwd
      ? expand(fLayer, fwdMap, bwdMap, actions, true)
      : expand(bLayer, bwdMap, fwdMap, invActs, false);
    if (sol) return sol.flatMap(a => a.moves);
  }
  return null;
}

// ════════════════════════════════════════
//  共用求解骨架
// ════════════════════════════════════════

function makeSolver(stateStr, method) {
  initMovePerms();
  let cur = stateStr;
  const allMoves = [];
  const stepStates = [stateStr];
  const phases = [];
  const timings = []; // 各阶段耗时（毫秒），诊断性能用

  const stage = (name) => {
    const startStep = allMoves.length;
    const t0 = performance.now();
    return {
      add(moves) {
        for (const m of moves) {
          cur = applyMove(cur, m);
          allMoves.push(m);
          stepStates.push(cur);
        }
      },
      end() {
        timings.push({ name, ms: Math.round(performance.now() - t0) });
        phases.push({ name, startStep, endStep: allMoves.length, moves: allMoves.slice(startStep) });
      },
    };
  };

  const must = (sol, msg) => {
    if (!sol) throw new Error(`阶段「${msg}」求解失败`);
    return sol;
  };

  const finish = () => {
    if (cur !== SOLVED) {
      throw new Error(`内部校验失败：求解结果不是复原状态\n得到: ${cur}`);
    }
    return { solution: allMoves.join(' '), moveCount: allMoves.length, stepStates, phases, timings, method };
  };

  return { get cur() { return cur; }, stage, must, finish, solveBFS: solveBlocksBFS, absBFS: abstractBFS, absBFSBidir: absBFSBidirHome };
}

/** 块的两面字母（不含 U/D 色的面），用于限制移动集 */
function blockFaces(colors) {
  return colors.filter(c => c !== 'U' && c !== 'D');
}

// ════════════════════════════════════════
//  层先法 (LBL) — 7 阶段
// ════════════════════════════════════════

export function solveLBL(stateStr, _Cube) {
  const S = makeSolver(stateStr, 'lbl');
  const D_EDGE = [4, 5, 6, 7];   // DF DR DB DL
  const D_CORNER = [4, 5, 6, 7]; // DFR DRB DBL DLF
  const M_EDGE = [8, 9, 10, 11]; // FR FL BR BL

  // ── P1 底面十字：逐棱插入 ──
  {
    const s = S.stage('底面十字');
    const acts18 = ALL_MOVES.map(m => makeAction(m, m)); // 全 18 基础 move（makeAction 已缓存）
    for (let i = 0; i < 4; i++) {
      const blocks = D_EDGE.slice(0, i + 1).map(blkE);
      // 双向抽象 BFS 快路径（全 home 目标、解浅两侧各半），失败回退 IDA* 块级路径
      s.add(S.must(
        S.absBFSBidir(S.cur, blocks, acts18, 1_000_000)
        || S.solveBFS(S.cur, blocks, ALL_MOVES, allHome(blocks), 400_000, true),
        '底面十字'));
    }
    s.end();
  }

  // ── P2 底面角块：逐角（取出 → 插入 两段） ──
  {
    const s = S.stage('底面角块');
    const eBlocks = D_EDGE.map(blkE);
    for (let i = 0; i < 4; i++) {
      const target = D_CORNER[i];
      const cBlocks = D_CORNER.slice(0, i + 1).map(blkC);
      const blocks = [...eBlocks, ...cBlocks];
      const ci = blocks.length - 1;
      const st = blockStates(encode(S.cur), blocks);
      const slot = (st[ci] / 3) | 0;

      if (slot >= 4) {
        // 本角卡在底层（错位或错向）→ 先取出到顶层
        const faces = blockFaces(CORNER_COLORS[slot]);
        const mv1 = [...U_MOVES, ...face3(faces[0]), ...face3(faces[1])];
        const keep = st => {
          for (let k = 0; k < blocks.length - 1; k++) if (st[k] !== blocks[k].home) return false;
          return ((st[ci] / 3) | 0) < 4;
        };
        s.add(S.must(
          S.absBFS(S.cur, blocks, mv1.map(m => makeAction(m, m)), keep, 7)
          || S.solveBFS(S.cur, blocks, mv1, keep, 300_000),
          '底面角块(取出)'));
      }
      const faces2 = blockFaces(CORNER_COLORS[target]);
      const mv2 = [...U_MOVES, ...faces2.flatMap(f => face3(f))];
      s.add(S.must(
        S.absBFSBidir(S.cur, blocks, mv2.map(m => makeAction(m, m)), 1_000_000)
        || S.solveBFS(S.cur, blocks, mv2, allHome(blocks), 600_000, true),
        '底面角块'));
    }
    s.end();
  }

  // ── P3 中层棱块：逐棱（中层卡住则先取出；抽象算法插入） ──
  {
    const s = S.stage('中层棱块');
    const base = [...D_EDGE.map(blkE), ...D_CORNER.map(blkC)];
    for (let i = 0; i < 4; i++) {
      const target = M_EDGE[i];
      const mBlocks = M_EDGE.slice(0, i + 1).map(blkE);
      const blocks = [...base, ...mBlocks];
      const bi = blocks.length - 1;

      const st = blockStates(encode(S.cur), blocks);
      const slot = st[bi] >> 1;
      if (slot >= 8 && st[bi] !== blocks[bi].home) {
        // 卡在中层（错位/翻转）→ 取出到顶层（U 棘可能被换进中层，后续逐棱时自然换出）
        const faces = blockFaces(EDGE_COLORS[slot]);
        const mv1 = [...U_MOVES, ...face3(faces[0]), ...face3(faces[1])];
        const keep = st => {
          for (let k = 0; k < blocks.length - 1; k++) if (st[k] !== blocks[k].home) return false;
          return (st[bi] >> 1) < 4;
        };
        s.add(S.must(
          S.absBFS(S.cur, blocks, mv1.map(m => makeAction(m, m)), keep, 7)
          || S.solveBFS(S.cur, blocks, mv1, keep, 600_000),
          '中层棱块(取出)'));
      }
      // 抽象插入：4 个标准中层算法（FR/FL 直接插入，BR/BL 为 y2 共轭重写版）。
      // C 集合 = 已解中层棱 + 本棱：插入算法的净效果会把目标槽的原棱换出
      // （如右插把 FR 位棱换到 UB），若 FR 已解而被 BFS 无感破坏，就会漏出
      // 已解棱错位的中间态。因此 isDone 要求全部（含已解棱）都在位。
      const meBlocks = [...mBlocks];
      const acts = [
        makeAction('U', 'U'), makeAction('U2', 'U2'), makeAction("U'", "U'"),
        makeAction('右插', "U R U' R' U' F' U F"),   // UF 棱 → FR
        makeAction('左插', "U' L' U L U F U' F'"),   // UF 棱 → FL
        makeAction('BR插', "U' R' U R U B U' B'"),   // UB 棱 → BR（= y2·左插·y2）
        makeAction('BL插', "U L U' L' U' B' U B"),   // UB 棱 → BL（= y2·右插·y2）
      ];
      let sol = S.absBFS(S.cur, meBlocks, acts, allHome(meBlocks), 7);
      if (!sol) {
        sol = S.solveBFS(S.cur, blocks, ALL_MOVES, allHome(blocks), 1_500_000, true);
      }
      s.add(S.must(sol, '中层棱块'));
    }
    s.end();
  }

  // ── P4 顶面十字（OLL edge，抽象） ──
  // P3 结束时 4 个 U 棘必然全在 U 层（12 棘中 8 个在底层/中层）
  {
    const s = S.stage('顶面十字');
    const blocks = [0, 1, 2, 3].map(blkE); // UF UR UB UL
    const acts = [
      ...U_MOVES.map(m => makeAction(m, m)),
      makeAction('算法A', "F R U R' U' F'"),
      makeAction('算法B', "F U R U' R' F'"),
    ];
    const up = st => st.every(v => (v >> 1) < 4 && (v & 1) === 0);
    s.add(S.must(S.absBFS(S.cur, blocks, acts, up, 5), '顶面十字'));
    s.end();
  }

  // ── P5 顶面颜色（OCLL，抽象） ──
  {
    const s = S.stage('顶面颜色');
    const blocks = [0, 1, 2, 3].map(blkC);
    const acts = [
      ...U_MOVES.map(m => makeAction(m, m)),
      makeAction('Sune', "R U R' U R U2 R'"),
      makeAction('Antisune', "R U2 R' U' R U' R'"),
      makeAction('H', "R U R' U R U' R' U R U2 R'"),
      makeAction('Pi', "R U2 R2 U' R2 U' R2 U2 R"),
    ];
    const up = st => st.every(v => v % 3 === 0);
    s.add(S.must(S.absBFS(S.cur, blocks, acts, up, 6), '顶面颜色'));
    s.end();
  }

  // ── P6 顶角位置（PLL corner，抽象） ──
  {
    const s = S.stage('顶角位置');
    const blocks = [0, 1, 2, 3].map(blkC);
    const acts = [
      ...U_MOVES.map(m => makeAction(m, m)),
      makeAction('T-perm', "R U R' U' R' F R2 U' R' U' R U R' F'"),
      makeAction('Y-perm', "F R U' R' U' R U R' F' R U R' U' R' F R F'"),
    ];
    s.add(S.must(S.absBFS(S.cur, blocks, acts, allHome(blocks), 5), '顶角位置'));
    s.end();
  }

  // ── P7 顶棱位置（PLL edge，抽象；不用单独 U 以免破坏角） ──
  // 注意：Ua 与 Ub 互逆，仅二者只能生成 3 阶循环群；加入 U 共轭变体
  // （U·Ua·U' 等，净效果保角）后生成整个 A4，覆盖全部 12 种偶排列
  {
    const s = S.stage('顶棱位置');
    const blocks = [0, 1, 2, 3].map(blkE);
    const acts = [
      makeAction('Ua', "R U' R U R U R U' R' U' R2"),
      makeAction('Ub', "R2 U R U R' U' R' U' R' U R'"),
      makeAction('Ua-v1', "U R U' R U R U R U' R' U' R2 U'"),
      makeAction('Ua-v2', "U2 R U' R U R U R U' R' U' R2 U2"),
      makeAction('Ua-v3', "U' R U' R U R U R U' R' U' R2 U"),
    ];
    s.add(S.must(S.absBFS(S.cur, blocks, acts, allHome(blocks), 4), '顶棱位置'));
    s.end();
  }

  return S.finish();
}

// ════════════════════════════════════════
//  桥式 (Roux) — 4 阶段
// ════════════════════════════════════════

/** Roux EO 判定：LSE 棘的 U/D 色贴纸在 U/D/F/B 面 = 好 */
function isLSEEdgeGood(v) {
  const slot = v >> 1, flip = v & 1;
  const idx = EDGE_SLOTS[slot][flip]; // flip=0 → 首色(UD 色)在第一面
  const face = (idx / 9) | 0;
  return face === 0 || face === 2 || face === 3 || face === 5;
}

/**
 * 桥块两段式求解（取出 → 插入），左桥右桥共用。
 * 已解块全部纳入 C 集合保证保持；插入移动集必须含翻棱面
 * （U/D/R/L 均不翻棱，DR/DL 等槽的目标棱若翻转，需要 F/B 参与才能翻正）。
 */
function solveBridgePiece(S, stageObj, blocks, bi, insertFaces, name) {
  const b = blocks[bi];
  const st0 = blockStates(encode(S.cur), blocks);
  const slot = b.t === 'e' ? (st0[bi] >> 1) : ((st0[bi] / 3) | 0);
  const solvedHome = st0[bi] === b.home;
  const inTop = slot < 4;

  if (!solvedHome && !inTop) {
    // 取出段：目标 = 本块到顶层 + 已解保持（翻转状态由插入段处理）
    const curFaces = b.t === 'e' ? blockFaces(EDGE_COLORS[slot]) : blockFaces(CORNER_COLORS[slot]);
    const mv1 = [...U_MOVES, ...curFaces.flatMap(f => face3(f))];
    const keep = st => {
      for (let k = 0; k < blocks.length - 1; k++) if (st[k] !== blocks[k].home) return false;
      const sv = st[bi];
      return b.t === 'e' ? (sv >> 1) < 4 : ((sv / 3) | 0) < 4;
    };
    // 抽象 BFS 快路径：转移 O(块数) 查表远快于块级 54 面置换 + 槽位提取。
    // keep 目标浅（解 ≤6 步），maxDepth=7 覆盖正常解且不可达时快速失败回退
    let outSol = S.absBFS(S.cur, blocks, mv1.map(m => makeAction(m, m)), keep, 7);
    if (!outSol) outSol = S.solveBFS(S.cur, blocks, mv1, keep, 600_000);
    if (!outSol) outSol = S.solveBFS(S.cur, blocks, ALL_MOVES, keep, 900_000);
    stageObj.add(S.must(outSol, name + '(取出)'));
  }
  // 插入段：目标 = 全部 home。双向抽象 BFS 快路径（起点/目标对向扩展、
  // 相遇拼接，深解扩展量两侧各半），1M 节点保护防不可达膨胀；
  // 失败回退 IDA* 块级路径（启发剪枝）→ 宽 BFS 兜底
  const mv2 = [...U_MOVES, ...insertFaces.flatMap(f => face3(f))];
  let sol = S.absBFSBidir(S.cur, blocks, mv2.map(m => makeAction(m, m)), 1_000_000);
  if (!sol) sol = S.solveBFS(S.cur, blocks, mv2, allHome(blocks), 1_200_000, true);
  if (!sol) sol = S.solveBFS(S.cur, blocks, ALL_MOVES, allHome(blocks), 2_000_000, true);
  stageObj.add(S.must(sol, name));
}

// Roux 桥定义（1×2×3 结构）：3 棱 + 2 角
// 注意 BL/BR 棱属于桥，漏掉它们会让 LSE 棘卡在中层（M/U 动作无法触及）
const LEFT_BRIDGE = [
  { b: () => blkE(7),  faces: ['L', 'F'] },  // DL 棱（D 槽过滤后仅 L，补 F 提供翻棱能力）
  { b: () => blkE(9),  faces: ['F', 'L'] },  // FL 棱
  { b: () => blkE(11), faces: ['B', 'L'] },  // BL 棱
  { b: () => blkC(7),  faces: ['L', 'F'] },  // DLF 角
  { b: () => blkC(6),  faces: ['B', 'L'] },  // DBL 角
];
const RIGHT_BRIDGE = [
  { b: () => blkE(5),  faces: ['R', 'F'] },  // DR 棱（补 F 翻棱）
  { b: () => blkE(8),  faces: ['F', 'R'] },  // FR 棱
  { b: () => blkE(10), faces: ['B', 'R'] },  // BR 棱
  { b: () => blkC(4),  faces: ['F', 'R'] },  // DFR 角
  { b: () => blkC(5),  faces: ['R', 'B'] },  // DRB 角
];

export function solveRoux(stateStr, _Cube) {
  const S = makeSolver(stateStr, 'roux');

  // ── P1 左桥：DL → FL → BL → DLF → DBL ──
  {
    const s = S.stage('左桥');
    const blocks = [];
    for (const def of LEFT_BRIDGE) {
      blocks.push(def.b());
      solveBridgePiece(S, s, blocks, blocks.length - 1, def.faces, '左桥');
    }
    s.end();
  }

  // ── P2 右桥：DR → FR → BR → DFR → DRB（保持左桥） ──
  {
    const s = S.stage('右桥');
    const blocks = LEFT_BRIDGE.map(d => d.b());
    for (const def of RIGHT_BRIDGE) {
      blocks.push(def.b());
      solveBridgePiece(S, s, blocks, blocks.length - 1, def.faces, '右桥');
    }
    s.end();
  }

  // ── P3 CMLL：一次解顶层角（朝向+位置，抽象） ──
  {
    const s = S.stage('CMLL');
    const blocks = [0, 1, 2, 3].map(blkC);
    const acts = [
      ...U_MOVES.map(m => makeAction(m, m)),
      makeAction('Sune', "R U R' U R U2 R'"),
      makeAction('Antisune', "R U2 R' U' R U' R'"),
      makeAction('H', "R U R' U R U' R' U R U2 R'"),
      makeAction('Pi', "R U2 R2 U' R2 U' R2 U2 R"),
      makeAction('T-perm', "R U R' U' R' F R2 U' R' U' R U R' F'"),
      makeAction('Y-perm', "F R U' R' U' R U R' F' R U R' U' R' F R F'"),
    ];
    s.add(S.must(S.absBFS(S.cur, blocks, acts, allHome(blocks), 6), 'CMLL'));
    s.end();
  }

  // ── P4 LSE（Last Six Edges，抽象 BFS，M/U 系动作保桥保角） ──
  // 抽象状态必须含 4 个 U 角：U 动作会转动顶层角，若角不在状态里，
  // BFS 无法感知 CMLL 成果被破坏（内部校验才会发现）。含角后目标
  // 要求角复位，动作效果自动约束 U 的净轮换。
  // 中心块追踪：其归位是 LSE 目标的一部分；M 动作循环中心色。
  // 桥块不入追踪集合（<U,M> 数学上触不到桥，恒为 home 零区分度）。
  //
  // 求解策略：分段（4a EO → 4b UL/UR → 4c 剩余排列），前两段目标浅、
  // 抽象 BFS 毫秒级；4c 解可深达十几步（4b 的 M 净效果留下任意中心
  // 偏移），用双向抽象 BFS 从起点/目标态对向扩展、相遇拼接，
  // 扩展量降到两侧各半深度，避免单向逐层展开整个可达空间。
  // 4c 失败回退块级 BFS 兜底。
  {
    const s = S.stage('LSE');
    const lseEdges = [0, 1, 2, 3, 4, 6].map(blkE); // UF UR UB UL DF DB
    const corners = [0, 1, 2, 3].map(blkC);       // UFR URB UBL ULF（保持）
    const centers = [0, 1, 2, 3, 4, 5].map(blkM);
    const blocks = [...lseEdges, ...corners, ...centers];
    const acts = [
      ...U_MOVES.map(m => makeAction(m, m)),
      makeAction('M', 'M'), makeAction('M2', 'M2'), makeAction("M'", "M'"),
    ];
    const CE = 6;       // blocks 内角的起始索引
    const cornersHome = st => {
      for (let k = 0; k < 4; k++) if (st[CE + k] !== corners[k].home) return false;
      return true;
    };

    // 4a EO：6 棘全好 + 角保持（EO 目标浅，抽象 BFS 秒解）
    {
      const goal = st => {
        for (let k = 0; k < 6; k++) if (!isLSEEdgeGood(st[k])) return false;
        return cornersHome(st);
      };
      s.add(S.must(S.absBFS(S.cur, blocks, acts, goal, 10), 'LSE·棱朝向'));
    }
    // 4b UL/UR 归位（保持 EO + 角）
    {
      const ul = 3, ur = 1; // blocks 内索引：UF0 UR1 UB2 UL3 DF4 DB5
      const goal = st => {
        for (let k = 0; k < 6; k++) if (!isLSEEdgeGood(st[k])) return false;
        if (st[ul] !== lseEdges[ul].home || st[ur] !== lseEdges[ur].home) return false;
        return cornersHome(st);
      };
      s.add(S.must(S.absBFS(S.cur, blocks, acts, goal, 10), 'LSE·UL与UR'));
    }
    // 4c 剩余棱排列 + 中心复原 + 角保持
    // 双向抽象 BFS：前向从当前态、后向从目标态（全 home）对向扩展、
    // 中途相遇拼接。4c 的解可深达十几步（4b 的 M 净效果留下任意中心
    // 偏移），单向 BFS 需逐层展开整个可达空间；双向把扩展量降到两侧
    // 各半深度的乘积级。失败回退块级 BFS 兜底。
    {
      let sol = S.absBFSBidir(S.cur, blocks, acts);
      if (!sol) {
        const mv = ['U', 'U2', "U'", 'M', 'M2', "M'"];
        sol = S.solveBFS(S.cur, blocks, mv, allHome(blocks), 3_000_000);
      }
      s.add(S.must(sol, 'LSE·中层棱'));
    }
    s.end();
  }

  return S.finish();
}
