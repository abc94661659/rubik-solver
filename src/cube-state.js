/**
 * cube-state.js
 * 魔方状态模型：颜色常量、facelet 映射、状态校验
 */

// 6 个面的标识符
export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

// 面到颜色名的映射（标准西式配色）
export const FACE_COLORS = {
  U: { name: '白', hex: '#FFFFFF' },
  D: { name: '黄', hex: '#FFD500' },
  F: { name: '绿', hex: '#009B48' },
  B: { name: '蓝', hex: '#0046AD' },
  L: { name: '橙', hex: '#FF5900' },
  R: { name: '红', hex: '#B71239' },
};

// 颜色面板（供 UI 使用），按 U/R/F/D/L/B 排列
export const COLOR_LIST = FACES.map(f => ({
  face: f,
  name: FACE_COLORS[f].name,
  hex: FACE_COLORS[f].hex,
}));

/**
 * 创建初始状态（已复原的魔方）
 * 返回 54 字符串，每个面 9 个相同字母
 */
export function createSolvedState() {
  return 'UUUUUUUUU' + 'RRRRRRRRR' + 'FFFFFFFFF' + 'DDDDDDDDD' + 'LLLLLLLLL' + 'BBBBBBBBB';
}

/**
 * 创建空状态（只有中心块，其余待填）
 * 中心块索引：U=4, R=13, F=22, D=31, L=40, B=49
 */
export function createEmptyState() {
  // 用 '?' 占位保持 54 长度（空字符串 join 后长度会塌缩，导致索引错位）
  const arr = new Array(54).fill('?');
  arr[4] = 'U';
  arr[13] = 'R';
  arr[22] = 'F';
  arr[31] = 'D';
  arr[40] = 'L';
  arr[49] = 'B';
  return arr.join('');
}

// 中心块索引
export const CENTERS = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };

/**
 * 统计每种颜色已填写数量（忽略 '?' 占位符）
 */
export function countColors(state) {
  const counts = {};
  for (const f of FACES) counts[f] = 0;
  for (let i = 0; i < 54; i++) {
    if (state[i] && FACES.includes(state[i])) {
      counts[state[i]]++;
    }
  }
  return counts;
}

/**
 * 检查是否所有色块都填完了
 */
export function isComplete(state) {
  for (let i = 0; i < 54; i++) {
    if (!FACES.includes(state[i])) return false;
  }
  return true;
}

/**
 * 校验魔方状态的合法性
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateState(state) {
  const errors = [];

  // 1. 检查是否完整
  if (!isComplete(state)) {
    const empty = countEmpty(state);
    errors.push(`还有 ${empty} 个色块未填写`);
    return { valid: false, errors };
  }

  // 2. 每种颜色必须恰好 9 个
  const counts = countColors(state);
  for (const f of FACES) {
    if (counts[f] !== 9) {
      errors.push(`${FACE_COLORS[f].name}色有 ${counts[f]} 个，应为 9 个`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // 3. 详细的角块/棱块合法性检查交给 cubejs 求解时验证
  // 前端只做基本校验（颜色数量），避免映射错误导致误报
  return { valid: true, errors: [] };
}

function countEmpty(state) {
  let count = 0;
  for (let i = 0; i < 54; i++) {
    if (!FACES.includes(state[i])) count++;
  }
  return count;
}

/**
 * 解析解法步骤串为单独的步骤数组
 * "R U2 F' L D2" → ["R", "U2", "F'", "L", "D2"]
 */
export function parseMoves(movesStr) {
  return movesStr.trim().split(/\s+/).filter(m => m.length > 0);
}
