/**
 * visualizer.js
 * Three.js 3D 魔方 — 涂色输入 + 动画播放 + 手动转层
 */
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { FACE_COLORS, FACES } from './cube-state.js';

const CUBELET_SIZE = 0.94;
const EMPTY_COLOR = 0x3a3a52;

const HEX_TO_FACE = {};
for (const f of FACES) {
  HEX_TO_FACE[FACE_COLORS[f].hex.toLowerCase()] = f;
}

// ── GPU 能力检测 + 自适应画质分级 ──
// 通过 WebGL renderer 字符串 + 硬件并发数 + 触摸检测综合判断设备等级
function detectQuality() {
  // 尝试读取 GPU 型号
  let gpuTier = 'high';
  let webglAvailable = true;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      webglAvailable = false;
      return { tier: 'fallback', antialias: false, dpr: 1, edges: false, fpsCap: 30, maxCanvasPixels: 0, webgl: false };
    }

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    const cores = navigator.hardwareConcurrency || 4;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const mem = navigator.deviceMemory || 4;  // Chrome only, GB

    // 判定规则：
    //   low  : 软件 renderer (SwiftShader) / 移动端低配 / ≤2核 / ≤2GB
    //   mid  : 集成显卡 / 移动端中配 / 4核 / 4GB
    //   high : 独立显卡 / 桌面端高配 / ≥8核
    if (/SwiftShader|llvmpipe|Microsoft Basic/i.test(renderer)) {
      gpuTier = 'low';
    } else if (isMobile || cores <= 4 || mem <= 3) {
      gpuTier = isMobile && (cores <= 4 || mem <= 3) ? 'low' : 'mid';
    } else if (/Intel|HD Graphics|UHD/i.test(renderer)) {
      gpuTier = 'mid';
    } else {
      gpuTier = 'high';
    }
  } catch { gpuTier = 'mid'; }

  // Canvas 分辨率硬封顶：低端设备即使 DPR=1，大屏仍可能产生过多像素
  // 限制最终渲染像素数，超出则降低 DPR
  const profiles = {
    high: { tier: 'high', antialias: true,  dpr: Math.min(window.devicePixelRatio, 2),   edges: true,  fpsCap: 0, maxCanvasPixels: 0,        webgl: true },
    mid:  { tier: 'mid',  antialias: false, dpr: Math.min(window.devicePixelRatio, 1.5), edges: true,  fpsCap: 0, maxCanvasPixels: 1500000,  webgl: true },
    low:  { tier: 'low',  antialias: false, dpr: 1,                                       edges: false, fpsCap: 30, maxCanvasPixels: 750000,   webgl: true },
  };
  return profiles[gpuTier];
}

const QUALITY = detectQuality();

// 根据 Canvas 实际尺寸和 maxCanvasPixels 限制，动态调整 DPR
function clampDpr(baseDpr, w, h, maxPixels) {
  if (maxPixels <= 0) return baseDpr;
  const actualPixels = w * h * baseDpr * baseDpr;
  if (actualPixels <= maxPixels) return baseDpr;
  // 逐步降级 DPR 直到满足
  let dpr = baseDpr;
  while (dpr > 0.5 && w * h * dpr * dpr > maxPixels) {
    dpr -= 0.25;
  }
  return Math.max(0.5, dpr);
}

// ── 共享 GPU 资源（全量重建时不释放，永驻生命周期）──
// 162 个 Material → 7 个共享；27 个 Geometry → 1 个共享；27 个 EdgesGeometry/Material → 1 个共享
const SHARED_BOX_GEO = new THREE.BoxGeometry(CUBELET_SIZE, CUBELET_SIZE, CUBELET_SIZE);
const SHARED_EDGES_GEO = new THREE.EdgesGeometry(SHARED_BOX_GEO);
const SHARED_EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x0a0a12 });
SHARED_BOX_GEO._shared = true;
SHARED_EDGES_GEO._shared = true;
SHARED_EDGE_MAT._shared = true;

const SHARED_MATS = {};
for (const f of FACES) {
  SHARED_MATS[f] = new THREE.MeshBasicMaterial({ color: new THREE.Color(FACE_COLORS[f].hex) });
  SHARED_MATS[f]._shared = true;
}
SHARED_MATS['?'] = new THREE.MeshBasicMaterial({ color: EMPTY_COLOR });
SHARED_MATS['?']._shared = true;

// 复用常量，避免每次 getCubeState 创建新对象
const WORLD_DIRS = [
  { dir: 'right',  vec: new THREE.Vector3( 1, 0, 0), test: p => p.x === 1 },
  { dir: 'left',   vec: new THREE.Vector3(-1, 0, 0), test: p => p.x === -1 },
  { dir: 'up',     vec: new THREE.Vector3( 0, 1, 0), test: p => p.y === 1 },
  { dir: 'down',   vec: new THREE.Vector3( 0,-1, 0), test: p => p.y === -1 },
  { dir: 'front',  vec: new THREE.Vector3( 0, 0, 1), test: p => p.z === 1 },
  { dir: 'back',   vec: new THREE.Vector3( 0, 0,-1), test: p => p.z === -1 },
];

// 材质索引: [+X right=0, -X left=1, +Y up=2, -Y down=3, +Z front=4, -Z back=5]
const FACE_DIR_TO_MAT = { right: 0, left: 1, up: 2, down: 3, front: 4, back: 5 };
const MAT_TO_DIR = ['right', 'left', 'up', 'down', 'front', 'back'];

// Move → rotation parameters（方向已经过 cubejs 实测验证）
// layerAxis: 'all' 表示整体旋转（x/y/z），所有 cubelet 参与旋转
const MOVE_PARAMS = {
  'R':  { axis: 'x', dir: -1, layerAxis: 'x', layerVal:  1 },
  "R'": { axis: 'x', dir:  1, layerAxis: 'x', layerVal:  1 },
  'R2': { axis: 'x', dir: -2, layerAxis: 'x', layerVal:  1 },
  'L':  { axis: 'x', dir:  1, layerAxis: 'x', layerVal: -1 },
  "L'": { axis: 'x', dir: -1, layerAxis: 'x', layerVal: -1 },
  'L2': { axis: 'x', dir:  2, layerAxis: 'x', layerVal: -1 },
  'U':  { axis: 'y', dir: -1, layerAxis: 'y', layerVal:  1 },
  "U'": { axis: 'y', dir:  1, layerAxis: 'y', layerVal:  1 },
  'U2': { axis: 'y', dir: -2, layerAxis: 'y', layerVal:  1 },
  'D':  { axis: 'y', dir:  1, layerAxis: 'y', layerVal: -1 },
  "D'": { axis: 'y', dir: -1, layerAxis: 'y', layerVal: -1 },
  'D2': { axis: 'y', dir:  2, layerAxis: 'y', layerVal: -1 },
  'F':  { axis: 'z', dir: -1, layerAxis: 'z', layerVal:  1 },
  "F'": { axis: 'z', dir:  1, layerAxis: 'z', layerVal:  1 },
  'F2': { axis: 'z', dir: -2, layerAxis: 'z', layerVal:  1 },
  'B':  { axis: 'z', dir:  1, layerAxis: 'z', layerVal: -1 },
  "B'": { axis: 'z', dir: -1, layerAxis: 'z', layerVal: -1 },
  'B2': { axis: 'z', dir:  2, layerAxis: 'z', layerVal: -1 },
  // 中层转动（M 跟 L 向 / E 跟 D 向 / S 跟 F 向）
  'M':  { axis: 'x', dir:  1, layerAxis: 'x', layerVal:  0 },
  "M'": { axis: 'x', dir: -1, layerAxis: 'x', layerVal:  0 },
  'M2': { axis: 'x', dir:  2, layerAxis: 'x', layerVal:  0 },
  'E':  { axis: 'y', dir:  1, layerAxis: 'y', layerVal:  0 },
  "E'": { axis: 'y', dir: -1, layerAxis: 'y', layerVal:  0 },
  'E2': { axis: 'y', dir:  2, layerAxis: 'y', layerVal:  0 },
  'S':  { axis: 'z', dir: -1, layerAxis: 'z', layerVal:  0 },
  "S'": { axis: 'z', dir:  1, layerAxis: 'z', layerVal:  0 },
  'S2': { axis: 'z', dir: -2, layerAxis: 'z', layerVal: 0 },
  // 整体旋转（x 跟 R 向 / y 跟 U 向 / z 跟 F 向）
  'x':  { axis: 'x', dir: -1, layerAxis: 'all', layerVal: null },
  "x'": { axis: 'x', dir:  1, layerAxis: 'all', layerVal: null },
  'x2': { axis: 'x', dir: -2, layerAxis: 'all', layerVal: null },
  'y':  { axis: 'y', dir: -1, layerAxis: 'all', layerVal: null },
  "y'": { axis: 'y', dir:  1, layerAxis: 'all', layerVal: null },
  'y2': { axis: 'y', dir: -2, layerAxis: 'all', layerVal: null },
  'z':  { axis: 'z', dir: -1, layerAxis: 'all', layerVal: null },
  "z'": { axis: 'z', dir:  1, layerAxis: 'all', layerVal: null },
  'z2': { axis: 'z', dir:  2, layerAxis: 'all', layerVal: null },
};

// 转动提示文案
const MOVE_HINTS = {
  'R':  { text: "R · 右层顺时针", color: FACE_COLORS.R.hex },
  "R'": { text: "R' · 右层逆时针", color: FACE_COLORS.R.hex },
  'R2': { text: "R2 · 右层转 180°", color: FACE_COLORS.R.hex },
  'L':  { text: "L · 左层顺时针", color: FACE_COLORS.L.hex },
  "L'": { text: "L' · 左层逆时针", color: FACE_COLORS.L.hex },
  'L2': { text: "L2 · 左层转 180°", color: FACE_COLORS.L.hex },
  'U':  { text: "U · 顶层顺时针", color: FACE_COLORS.U.hex },
  "U'": { text: "U' · 顶层逆时针", color: FACE_COLORS.U.hex },
  'U2': { text: "U2 · 顶层转 180°", color: FACE_COLORS.U.hex },
  'D':  { text: "D · 底层顺时针", color: FACE_COLORS.D.hex },
  "D'": { text: "D' · 底层逆时针", color: FACE_COLORS.D.hex },
  'D2': { text: "D2 · 底层转 180°", color: FACE_COLORS.D.hex },
  'F':  { text: "F · 前层顺时针", color: FACE_COLORS.F.hex },
  "F'": { text: "F' · 前层逆时针", color: FACE_COLORS.F.hex },
  'F2': { text: "F2 · 前层转 180°", color: FACE_COLORS.F.hex },
  'B':  { text: "B · 后层顺时针", color: FACE_COLORS.B.hex },
  "B'": { text: "B' · 后层逆时针", color: FACE_COLORS.B.hex },
  'B2': { text: "B2 · 后层转 180°", color: FACE_COLORS.B.hex },
  'M':  { text: "M · 中层（跟L向）", color: '#cccccc' },
  "M'": { text: "M' · 中层反转", color: '#cccccc' },
  'M2': { text: "M2 · 中层转 180°", color: '#cccccc' },
  'E':  { text: "E · 赤道层（跟D向）", color: '#cccccc' },
  "E'": { text: "E' · 赤道层反转", color: '#cccccc' },
  'E2': { text: "E2 · 赤道层转 180°", color: '#cccccc' },
  'S':  { text: "S · 中立面（跟F向）", color: '#cccccc' },
  "S'": { text: "S' · 中立面反转", color: '#cccccc' },
  'S2': { text: "S2 · 中立面转 180°", color: '#cccccc' },
  'x':  { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  "x'": { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  'x2': { text: "整体旋转 180° · 对齐朝向", color: '#ffffff' },
  'y':  { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  "y'": { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  'y2': { text: "整体旋转 180° · 对齐朝向", color: '#ffffff' },
  'z':  { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  "z'": { text: "整体旋转 · 对齐朝向", color: '#ffffff' },
  'z2': { text: "整体旋转 180° · 对齐朝向", color: '#ffffff' },
};

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function getInverse(move) {
  if (move.endsWith('2')) return move;
  if (move.endsWith("'")) return move[0];
  return move + "'";
}

export class Visualizer {
  constructor(container) {
    this.container = container;
    this.onStepChange = null;
    this.onPlaybackComplete = null;
    this.onFacePaint = null;
    this.onUserMove = null;       // 用户手动转层后的回调

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12121f);

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 500;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.defaultCamPos = new THREE.Vector3(4.8, 4.2, 6.2);
    this.defaultTarget = new THREE.Vector3(0, 0, 0);
    this.camera.position.copy(this.defaultCamPos);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: QUALITY.antialias,
      powerPreference: 'high-performance',
    });
    const dpr = clampDpr(QUALITY.dpr, w, h, QUALITY.maxCanvasPixels);
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(dpr);
    // 记录初始尺寸：ResizeObserver 注册时的首次回调若尺寸未变即可跳过冗余重建
    this._lastResizeW = w;
    this._lastResizeH = h;
    this._lastResizeDpr = dpr;
    container.appendChild(this.renderer.domElement);

    // TrackballControls：四元数旋转，无极角限制，可 360° 自由翻转
    this._target = new THREE.Vector3(0, 0, 0);  // 替代 OrbitControls.target
    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 1.5;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0;
    this.controls.noPan = true;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 16;
    // 右键留给转层
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // 用 MeshBasicMaterial，不依赖光照 → 颜色永远鲜艳清晰
    // 边缘描亮线增强立体感
    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);
    this.cubelets = [];
    this._posMap = new Map();

    // Playback state
    this.moves = [];
    this.stepStates = null;
    this.currentStep = -1;
    this.isPlaying = false;
    this.speed = 1;
    this.animation = null;
    this.pauseTimer = 0;
    this.targetStep = -1;
    this._introCancelled = false;
    this._rafId = 0;
    this._dirty = true;
    this._frameAccum = 0;
    this._prevCamX = 0; this._prevCamY = 0; this._prevCamZ = 0;
    this._prevTargetX = 0; this._prevTargetY = 0; this._prevTargetZ = 0;

    // 手动转层状态
    this.dragMode = null;       // null | 'camera' | 'layer'
    this.dragLayer = null;      // { axis, layerAxis, layerVal }
    this.dragPivot = null;
    this.dragStartAngle = null;

    // 转动提示浮层
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'move-hint';
    this.container.appendChild(this.hintEl);
    this.hintTimer = null;

    // Input mode（涂色模式 vs 播放模式）
    this.inputMode = true;
    this.setSelectedColor(null);

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Pointer
    this._pointerDown = false;
    this._pointerMoved = false;
    this._pointerStartX = 0;
    this._pointerStartY = 0;

    const el = this.renderer.domElement;
    this._onDown = (e) => this._handlePointerDown(e);
    this._onMove = (e) => this._handlePointerMove(e);
    this._onUp = (e) => this._handlePointerUp(e);
    // pointerdown 用捕获阶段 + stopImmediatePropagation：彻底阻止 TrackballControls
    el.addEventListener('pointerdown', this._onDown, true);
    // pointermove/up 始终注册在 canvas 上
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // 渲染循环
    this.clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
    this._animate();

    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);

    // 容器尺寸变化（如播放控制条弹出/收起改变画布高度）时同步 renderer
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(container);
    } else {
      this._resizeObserver = null;
    }
  }

  _onResize() {
    // 拖动窗口改变分辨率时 resize 事件会高频触发，用 rAF 合并到一帧执行一次
    if (this._resizeRaf) return;
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = clampDpr(QUALITY.dpr, w, h, QUALITY.maxCanvasPixels);
      // 尺寸与像素比均未变化则跳过：避免重复事件/初始回调无谓重建 buffer
      if (w === this._lastResizeW && h === this._lastResizeH && dpr === this._lastResizeDpr) return;
      this._lastResizeW = w;
      this._lastResizeH = h;
      this._lastResizeDpr = dpr;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(dpr);
      this.controls.handleResize();
      this._dirty = true;
      // 关键：setSize/setPixelRatio 会重建 WebGL buffer（旧画面被清空）。
      // 本回调在渲染循环之后执行，若只置脏标记等下一帧重绘，本帧合成呈现的
      // 就是空画布 → 拖动逐帧黑屏闪烁。必须同帧同步补画，合成时画面才完整。
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ─── 视角控制 ───

  /**
   * 平滑重置视角（带动画过渡）
   */
  resetCamera() {
    if (this.cameraAnim) return;

    const startPos = this.camera.position.clone();
    const startTarget = this._target.clone();
    const endPos = this.defaultCamPos.clone();
    const endTarget = this.defaultTarget.clone();

    this.cameraAnim = {
      progress: 0,
      duration: 0.8,
      startPos, startTarget, endPos, endTarget,
    };
  }

  _updateCameraAnim(delta) {
    const a = this.cameraAnim;
    if (!a) return;
    a.progress += delta / a.duration;
    const t = Math.min(a.progress, 1);
    const eased = easeInOutCubic(t);
    this.camera.position.lerpVectors(a.startPos, a.endPos, eased);
    this._target.lerpVectors(a.startTarget, a.endTarget, eased);
    this.camera.lookAt(this._target);
    if (t >= 1) {
      this.cameraAnim = null;
      // 同步 TrackballControls 内部状态
      this.controls.target0.copy(this._target);
      this.controls.update();
    }
  }

  // ─── 3D 涂色输入 ───

  setInputMode(enabled) { this.inputMode = enabled; }

  setSelectedColor(face) { this.selectedColor = face; }

  /**
   * Shift/右键 = 转层；未选色时左键拖魔方也 = 转层
   */
  _isLayerDrag(e) {
    if (e.shiftKey || e.button === 2) return true;
    // 未选颜色时，左键拖魔方 = 转层（在 _handlePointerDown 中 raycast 确认是否点中魔方）
    if (e.button === 0 && !this.selectedColor) return true;
    return false;
  }

  _handlePointerDown(e) {
    this._pointerDown = true;
    this._pointerMoved = false;
    this._pointerStartX = e.clientX;
    this._pointerStartY = e.clientY;

    if (this._isLayerDrag(e) && !this.animation) {
      // 未选色时左键：需 raycast 确认点中了魔方才转层，否则转视角
      if (e.button === 0 && !this.selectedColor) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const hits = this.raycaster.intersectObjects(this.cubelets, false);
        if (hits.length === 0) {
          // 点中空白 → 不阻止，让 TrackballControls 转视角
          this.dragMode = 'camera';
          return;
        }
      }
      // 转层：stopImmediatePropagation 彻底阻止 TrackballControls 收到 pointerdown
      e.stopImmediatePropagation();
      this.dragMode = 'layer';
      this._dragCandidatesSet = false;
      if (e.button === 2) e.preventDefault();
      this.controls.enabled = false;
      // 自己捕获指针，确保 pointermove/up 即使鼠标移出 canvas 也能收到
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      this._pointerCaptured = true;
    } else {
      this.dragMode = 'camera';
    }
  }

  _handlePointerMove(e) {
    if (!this._pointerDown) return;
    const dxAbs = Math.abs(e.clientX - this._pointerStartX);
    const dyAbs = Math.abs(e.clientY - this._pointerStartY);
    if (dxAbs > 5 || dyAbs > 5) this._pointerMoved = true;

    // 层拖拽处理
    if (this.dragMode === 'layer' && this._pointerMoved) {
      this._updateLayerDrag(e);
    }
  }

  _handlePointerUp(e) {
    if (this._pointerDown && !this._pointerMoved && this.inputMode && this.dragMode !== 'layer') {
      this._handleFaceClick(e);
    }
    // 结束层拖拽
    if (this.dragMode === 'layer' && this.dragPivot) {
      this._finishLayerDrag();
    }
    // 恢复 TrackballControls
    if (!this.controls.enabled) this.controls.enabled = true;
    // 释放指针捕获
    if (this._pointerCaptured) {
      try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
      this._pointerCaptured = false;
    }
    this._pointerDown = false;
    this._pointerMoved = false;
    this.dragMode = null;
    this._dragCandidatesSet = false;
  }

  /**
   * 层拖拽：根据拖拽方向确定旋转轴，实时旋转层
   */
  _updateLayerDrag(e) {
    if (this.animation) return;

    const dx = e.clientX - this._pointerStartX;
    const dy = e.clientY - this._pointerStartY;

    if (!this._dragCandidatesSet) {
      // 第一次移动超过阈值：确定点击的 cubelet 和候选轴
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((this._pointerStartX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((this._pointerStartY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObjects(this.cubelets, false);
      if (hits.length === 0) {
        this.dragMode = 'camera';
        if (!this.controls.enabled) this.controls.enabled = true;
        return;
      }

      const hit = hits[0];
      const cubelet = hit.object;
      const pos = cubelet.userData.logicalPos;
      this._dragCubelet = cubelet;

      // 点击的世界法向 → 决定两个候选旋转轴
      const n = hit.face.normal.clone();
      n.transformDirection(cubelet.matrixWorld);
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      let faceDir;
      if (ax >= ay && ax >= az) faceDir = n.x > 0 ? 'right' : 'left';
      else if (ay >= ax && ay >= az) faceDir = n.y > 0 ? 'up' : 'down';
      else faceDir = n.z > 0 ? 'front' : 'back';

      const AXIS_VEC = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };

      let cands;
      if (faceDir === 'up' || faceDir === 'down') {
        // 顶/底面：拖拽绕 x 轴（左右拖）或 z 轴（上下拖）——实际取决于屏幕拖拽方向
        cands = [
          { axis: 'x', layerAxis: 'x', layerVal: pos.x },
          { axis: 'z', layerAxis: 'z', layerVal: pos.z },
        ];
      } else if (faceDir === 'front' || faceDir === 'back') {
        cands = [
          { axis: 'y', layerAxis: 'y', layerVal: pos.y },
          { axis: 'x', layerAxis: 'x', layerVal: pos.x },
        ];
      } else {
        cands = [
          { axis: 'y', layerAxis: 'y', layerVal: pos.y },
          { axis: 'z', layerAxis: 'z', layerVal: pos.z },
        ];
      }

      // 根据拖拽方向选择轴：旋转时触摸点沿切线方向（垂直于轴）移动
      // 所以选屏幕投影与拖拽方向最垂直的轴（|dot| 最小）
      const dragDir = new THREE.Vector2(dx, -dy);   // 屏幕 y 向下为正，翻转
      const dragLen = dragDir.length();
      const originP = new THREE.Vector3().project(this.camera);
      let chosen = cands[0], bestDot = Infinity;
      for (const cd of cands) {
        const axisEnd = AXIS_VEC[cd.axis].clone().multiplyScalar(0.5).project(this.camera);
        const axDir = new THREE.Vector2(axisEnd.x - originP.x, axisEnd.y - originP.y);
        if (axDir.lengthSq() < 1e-8) continue;   // 轴向指向相机，屏幕投影退化
        axDir.normalize();
        const d = dragLen > 0 ? Math.abs((dragDir.x * axDir.x + dragDir.y * axDir.y) / dragLen) : 0;
        if (d < bestDot) { bestDot = d; chosen = cd; }
      }
      this._dragChosen = chosen;
      this._dragAxisVec = AXIS_VEC[chosen.axis];

      // 抓取层中的所有 cubelet
      const layer = this.cubelets.filter(c =>
        c.userData.logicalPos[chosen.layerAxis] === chosen.layerVal
      );
      const pivot = new THREE.Object3D();
      this.cubeGroup.add(pivot);
      for (const c of layer) pivot.attach(c);
      this.dragPivot = pivot;
      this.dragLayer = { cubelets: layer };
      this._dragCandidatesSet = true;
    }

    // 计算拖拽角度：旋转轴投影到屏幕后，取其垂直方向作为旋转切线方向
    // 拖拽向量在切线方向上的分量决定旋转角度
    const cam = this.camera;
    const origin = new THREE.Vector3();
    const p1 = origin.clone().project(cam);
    const p2 = this._dragAxisVec.clone().multiplyScalar(0.5).project(cam);
    const axisScreen = new THREE.Vector2(p2.x - p1.x, p2.y - p1.y);
    if (axisScreen.lengthSq() < 1e-8) return;
    axisScreen.normalize();

    // 旋转切线 = 旋转轴屏幕投影顺时针转90°（触摸点的移动方向）
    const rotScreen = new THREE.Vector2(axisScreen.y, -axisScreen.x);

    const dragVec = new THREE.Vector2(
      (e.clientX - this._pointerStartX),
      -(e.clientY - this._pointerStartY) // 屏幕 y 向下为正，翻转
    );
    // 拖拽 100px ≈ 转 45°，限制在 ±90°
    let angle = (dragVec.dot(rotScreen) / 100) * (Math.PI / 4);
    angle = THREE.MathUtils.clamp(angle, -Math.PI / 2, Math.PI / 2) * 1.0;
    this.dragPivot.rotation[this._dragChosen.axis] = angle;
    this._dirty = true;
  }

  /**
   * 结束层拖拽：snap 到最近的 90° 并应用
   */
  _finishLayerDrag() {
    if (!this.dragPivot) return;
    const axis = this._dragChosen.axis;
    const angle = this.dragPivot.rotation[axis];
    // snap 到最近的 90°
    const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    this.dragPivot.rotation[axis] = snapped;
    this.dragPivot.updateMatrixWorld(true);

    for (const c of this.dragLayer.cubelets) {
      this.cubeGroup.attach(c);
      c.position.set(
        Math.round(c.position.x),
        Math.round(c.position.y),
        Math.round(c.position.z)
      );
      c.userData.logicalPos = {
        x: Math.round(c.position.x),
        y: Math.round(c.position.y),
        z: Math.round(c.position.z),
      };
    }
    this.cubeGroup.remove(this.dragPivot);
    this.dragPivot = null;
    this.dragLayer = null;
    this._rebuildPosMap();
    this._dirty = true;

    if (this.onUserMove) this.onUserMove();
  }

  _handleFaceClick(e) {
    if (!this.selectedColor) return;

    const { faceletIdx, cubelet, faceDir } = this._raycastFace(e);
    if (faceletIdx < 0) return;

    // 中心块也可涂色（自定义配色方案）
    this.paintFacelet(faceletIdx, this.selectedColor);
    if (this.onFacePaint) this.onFacePaint(faceletIdx);
  }

  _raycastFace(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.cubelets, false);
    if (intersects.length === 0) return { faceletIdx: -1 };

    const hit = intersects[0];
    const cubelet = hit.object;
    const faceNormal = hit.face.normal.clone();
    faceNormal.transformDirection(cubelet.matrixWorld);

    const ax = Math.abs(faceNormal.x), ay = Math.abs(faceNormal.y), az = Math.abs(faceNormal.z);
    let faceDir;
    if (ax >= ay && ax >= az) faceDir = faceNormal.x > 0 ? 'right' : 'left';
    else if (ay >= ax && ay >= az) faceDir = faceNormal.y > 0 ? 'up' : 'down';
    else faceDir = faceNormal.z > 0 ? 'front' : 'back';

    const pos = cubelet.userData.logicalPos;
    const faceletIdx = this._posToFacelet(pos.x, pos.y, pos.z, faceDir);
    return { faceletIdx, cubelet, faceDir };
  }

  _posToFacelet(x, y, z, faceDir) {
    switch (faceDir) {
      case 'up':    return 0  + (z + 1) * 3 + (x + 1);
      case 'down':  return 27 + (1 - z) * 3 + (x + 1);
      case 'front': return 18 + (1 - y) * 3 + (x + 1);
      case 'back':  return 45 + (1 - y) * 3 + (1 - x);
      case 'right': return 9  + (1 - y) * 3 + (1 - z);
      case 'left':  return 36 + (1 - y) * 3 + (z + 1);
      default: return -1;
    }
  }

  _faceletToPos(idx) {
    if (idx < 9) {
      const r = Math.floor(idx / 3), c = idx % 3;
      return { x: c - 1, y: 1, z: r - 1, faceDir: 'up' };
    } else if (idx < 18) {
      const p = idx - 9, r = Math.floor(p / 3), c = p % 3;
      return { x: 1, y: 1 - r, z: 1 - c, faceDir: 'right' };
    } else if (idx < 27) {
      const p = idx - 18, r = Math.floor(p / 3), c = p % 3;
      return { x: c - 1, y: 1 - r, z: 1, faceDir: 'front' };
    } else if (idx < 36) {
      const p = idx - 27, r = Math.floor(p / 3), c = p % 3;
      return { x: c - 1, y: -1, z: 1 - r, faceDir: 'down' };
    } else if (idx < 45) {
      const p = idx - 36, r = Math.floor(p / 3), c = p % 3;
      return { x: -1, y: 1 - r, z: c - 1, faceDir: 'left' };
    } else {
      const p = idx - 45, r = Math.floor(p / 3), c = p % 3;
      return { x: 1 - c, y: 1 - r, z: -1, faceDir: 'back' };
    }
  }

  paintFacelet(faceletIdx, color) {
    const info = this._faceletToPos(faceletIdx);
    if (!info) return;

    const cubelet = this._posMap.get(`${info.x},${info.y},${info.z}`);
    if (!cubelet) return;

    const matIdx = FACE_DIR_TO_MAT[info.faceDir];
    cubelet.material[matIdx] = color ? SHARED_MATS[color] : SHARED_MATS['?'];
    this._dirty = true;
  }

  /**
   * 从 3D 立方体读取当前状态字符串（考虑 cubelet 旋转）
   */
  getCubeState() {
    const arr = new Array(54).fill('');
    const worldDirs = WORLD_DIRS;

    for (const cubelet of this.cubelets) {
      const pos = cubelet.userData.logicalPos;
      const invQ = cubelet.quaternion.clone().invert();

      for (const wd of worldDirs) {
        if (!wd.test(pos)) continue;

        const localDir = wd.vec.clone().applyQuaternion(invQ);
        const ax = Math.abs(localDir.x), ay = Math.abs(localDir.y), az = Math.abs(localDir.z);
        let matIdx;
        if (ax >= ay && ax >= az) matIdx = localDir.x > 0 ? 0 : 1;
        else if (ay >= ax && ay >= az) matIdx = localDir.y > 0 ? 2 : 3;
        else matIdx = localDir.z > 0 ? 4 : 5;

        const hex = '#' + cubelet.material[matIdx].color.getHexString();
        const face = HEX_TO_FACE[hex.toLowerCase()];
        if (face) {
          const idx = this._posToFacelet(pos.x, pos.y, pos.z, wd.dir);
          if (idx >= 0) arr[idx] = face;
        }
      }
    }
    return arr.join('');
  }

  // ─── 状态设置 ───

  setCubeState(facelets) {
    while (this.cubeGroup.children.length > 0) {
      const child = this.cubeGroup.children[0];
      this.cubeGroup.remove(child);
      this._disposeObject(child);
    }
    this.cubelets = [];
    this.animation = null;
    this.moves = [];
    this.stepStates = null;
    this.currentStep = -1;
    this.isPlaying = false;
    this.pauseTimer = 0;
    this.targetStep = -1;

    const faceColors = this._buildFaceColors(facelets);
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const colors = faceColors[`${x},${y},${z}`];
          const cubelet = this._createCubelet(x, y, z, colors);
          this.cubelets.push(cubelet);
          this.cubeGroup.add(cubelet);
        }
      }
    }
    this._rebuildPosMap();
    this._dirty = true;
  }

  _rebuildPosMap() {
    this._posMap.clear();
    for (const c of this.cubelets) {
      const p = c.userData.logicalPos;
      this._posMap.set(`${p.x},${p.y},${p.z}`, c);
    }
  }

  _disposeObject(obj) {
    if (obj.geometry && !obj.geometry._shared) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => { if (!m._shared) m.dispose(); });
      } else if (!obj.material._shared) {
        obj.material.dispose();
      }
    }
    for (const child of obj.children) this._disposeObject(child);
  }

  _buildFaceColors(facelets) {
    const fc = {};
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const colors = {};
          if (y === 1)  colors.up    = facelets[(z + 1) * 3 + (x + 1)];
          if (y === -1) colors.down  = facelets[27 + (1 - z) * 3 + (x + 1)];
          if (z === 1)  colors.front = facelets[18 + (1 - y) * 3 + (x + 1)];
          if (z === -1) colors.back  = facelets[45 + (1 - y) * 3 + (1 - x)];
          if (x === 1)  colors.right = facelets[9 + (1 - y) * 3 + (1 - z)];
          if (x === -1) colors.left  = facelets[36 + (1 - y) * 3 + (z + 1)];
          fc[`${x},${y},${z}`] = colors;
        }
      }
    }
    return fc;
  }

  _createCubelet(x, y, z, colors) {
    // 共享几何体 + 共享材质：全魔方仅 1 个 BoxGeometry、1 个 EdgesGeometry、7 个材质
    const mats = MAT_TO_DIR.map(face => {
      const c = colors[face];
      return c && FACE_COLORS[c] ? SHARED_MATS[c] : SHARED_MATS['?'];
    });

    const mesh = new THREE.Mesh(SHARED_BOX_GEO, mats);
    mesh.position.set(x, y, z);
    mesh.userData.logicalPos = { x, y, z };

    // 共享描边几何体 + 材质（低端设备跳过描边以减半 DrawCall）
    if (QUALITY.edges) {
      mesh.add(new THREE.LineSegments(SHARED_EDGES_GEO, SHARED_EDGE_MAT));
    }

    return mesh;
  }

  // ─── 播放控制 ───

  setSolution(moves, stepStates) {
    this.moves = moves;
    this.stepStates = stepStates || null;
    this.currentStep = -1;
    this.isPlaying = false;
    this.pauseTimer = 0;
    this.targetStep = -1;
  }

  /**
   * 瞬间执行一步（含整体旋转 'all' 层）：按动画完成态同步 cubelet 物理状态。
   * 与 _completeAnimation 的落位逻辑一致：pivot 转满角度 → attach 回 → 位置取整。
   */
  _instantMove(move) {
    const params = MOVE_PARAMS[move];
    if (!params) return;

    const layerCubelets = params.layerAxis === 'all'
      ? this.cubelets.slice()
      : this.cubelets.filter(c =>
          c.userData.logicalPos[params.layerAxis] === params.layerVal
        );

    const pivot = new THREE.Object3D();
    this.cubeGroup.add(pivot);
    for (const c of layerCubelets) pivot.attach(c);
    pivot.rotation[params.axis] = params.dir * Math.PI / 2;
    pivot.updateMatrixWorld(true);
    for (const c of layerCubelets) {
      this.cubeGroup.attach(c);
      c.position.set(
        Math.round(c.position.x),
        Math.round(c.position.y),
        Math.round(c.position.z)
      );
      c.userData.logicalPos = {
        x: Math.round(c.position.x),
        y: Math.round(c.position.y),
        z: Math.round(c.position.z),
      };
    }
    this.cubeGroup.remove(pivot);
  }

  /**
   * 无动画快进到播放序列第 idx 步：物理重放 moves[0..idx]。
   * 恢复播放进度时必须走这条路径——仅改贴纸颜色会与层动画机制脱节，
   * 导致后续步骤旋转的 cubelet 与状态不一致、最终魔方错乱。
   */
  applyMovesInstant(idx) {
    if (!this.moves || !this.moves.length) return false;
    if (idx < 0 || idx >= this.moves.length) return false;
    for (let k = 0; k <= idx; k++) this._instantMove(this.moves[k]);
    this._rebuildPosMap();
    this.currentStep = idx;
    this._dirty = true;
    return true;
  }

  play() { this._introCancelled = true; if (this.currentStep < this.moves.length - 1) this.isPlaying = true; }
  pause() { this._introCancelled = true; this.isPlaying = false; }

  nextStep() {
    if (this.animation || this.pauseTimer > 0) return;
    if (this.currentStep >= this.moves.length - 1) return;
    this.currentStep++;
    this._startMoveAnimation(this.moves[this.currentStep]);
    if (this.onStepChange) this.onStepChange(this.currentStep);
  }

  prevStep() {
    if (this.animation || this.pauseTimer > 0) return;
    if (this.currentStep < 0) return;
    this.currentStep--;
    this._startMoveAnimation(getInverse(this.moves[this.currentStep + 1]));
    if (this.onStepChange) this.onStepChange(this.currentStep);
  }

  jumpToStep(targetIdx) {
    if (targetIdx < 0 || targetIdx >= this.moves.length) return;
    if (targetIdx === this.currentStep) return;
    this._introCancelled = true;
    this.pause();
    this.targetStep = targetIdx;
    this._continueJump();
  }

  _continueJump() {
    if (this.animation) return;
    if (this.targetStep < 0 || this.targetStep === this.currentStep) {
      this.targetStep = -1;
      return;
    }
    if (this.targetStep > this.currentStep) {
      this.currentStep++;
      this._startMoveAnimation(this.moves[this.currentStep]);
    } else {
      const inv = getInverse(this.moves[this.currentStep]);
      this.currentStep--;
      this._startMoveAnimation(inv);
    }
    if (this.onStepChange) this.onStepChange(this.currentStep);
  }

  setSpeed(s) { this.speed = s; }

  getStepInfo() {
    return {
      current: this.currentStep + 1,
      total: this.moves.length,
      move: this.currentStep >= 0 ? this.moves[this.currentStep] : null,
      isComplete: this.currentStep >= this.moves.length - 1 && !this.animation,
    };
  }

  _startMoveAnimation(move) {
    const params = MOVE_PARAMS[move];
    if (!params) { console.warn('Unknown move:', move); return; }

    // 若拖拽中先取消拖拽层
    if (this.dragPivot) this._finishLayerDrag();

    // 'all' 表示整体旋转（x/y/z）：全部 cubelet 参与
    const layerCubelets = params.layerAxis === 'all'
      ? this.cubelets.slice()
      : this.cubelets.filter(c =>
          c.userData.logicalPos[params.layerAxis] === params.layerVal
        );

    const pivot = new THREE.Object3D();
    this.cubeGroup.add(pivot);
    for (const c of layerCubelets) pivot.attach(c);

    this.animation = {
      move, params, pivot,
      cubelets: layerCubelets,
      progress: 0,
      duration: (Math.abs(params.dir) === 2 ? 0.9 : 0.65) / this.speed,
      targetAngle: params.dir * Math.PI / 2,
    };

    this._showMoveHint(move);
  }

  /**
   * 播放整体旋转序列（用于中层朝向对齐），完成后回调
   * @param {string[]} seq - 如 ["x'", 'y']
   * @param {Function} onDone
   */
  playIntroRotation(seq, onDone) {
    this._introCancelled = false;
    const queue = seq.filter(m => MOVE_PARAMS[m]);
    if (queue.length === 0) { if (onDone) onDone(); return; }

    const playNext = () => {
      if (this._introCancelled) return;
      if (queue.length === 0) { if (onDone) onDone(); return; }
      const m = queue.shift();
      this._startMoveAnimation(m);
      const check = () => {
        if (this._introCancelled) return;
        if (this.animation) { requestAnimationFrame(check); return; }
        // 等待 pauseTimer 结束
        setTimeout(() => { if (!this._introCancelled) playNext(); }, 150 / this.speed);
      };
      requestAnimationFrame(check);
    };
    playNext();
  }

  _showMoveHint(move) {
    const hint = MOVE_HINTS[move];
    if (!hint) return;
    this.hintEl.textContent = hint.text;
    this.hintEl.style.borderColor = hint.color;
    this.hintEl.style.color = hint.color;
    this.hintEl.classList.add('visible');
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hintEl.classList.remove('visible');
    }, 1100);
  }

  _completeAnimation() {
    const a = this.animation;
    a.pivot.rotation[a.params.axis] = a.targetAngle;
    a.pivot.updateMatrixWorld(true);

    for (const c of a.cubelets) {
      this.cubeGroup.attach(c);
      c.position.set(
        Math.round(c.position.x),
        Math.round(c.position.y),
        Math.round(c.position.z)
      );
      c.userData.logicalPos = {
        x: Math.round(c.position.x),
        y: Math.round(c.position.y),
        z: Math.round(c.position.z),
      };
    }

    this.cubeGroup.remove(a.pivot);
    this.animation = null;
    this._rebuildPosMap();
    this._dirty = true;

    if (this.targetStep >= 0 && this.targetStep !== this.currentStep) {
      this.pauseTimer = 0.06;
    } else {
      this.targetStep = -1;
      this.pauseTimer = 0.25;
    }
  }

  // ─── 渲染循环 ───

  _animate() {
    this._rafId = requestAnimationFrame(this._animate);
    const delta = Math.min(this.clock.getDelta(), 0.1);

    // 低端设备帧率限制：30fps cap
    if (QUALITY.fpsCap > 0) {
      this._frameAccum += delta;
      if (this._frameAccum < 1 / QUALITY.fpsCap) return;
      this._frameAccum = 0;
    }

    let needsRender = this._dirty;
    this._dirty = false;

    // 视角重置动画（优先于用户控制）
    if (this.cameraAnim) {
      this._updateCameraAnim(delta);
      // 重置期间禁用 controls 防止打架
      this.controls.enabled = false;
      needsRender = true;
    } else if (!this.controls.enabled) {
      this.controls.enabled = true;
    }

    if (this.animation) {
      this.animation.progress += delta / this.animation.duration;
      if (this.animation.progress >= 1) {
        this._completeAnimation();
        if (this.targetStep >= 0 && this.targetStep !== this.currentStep) {
          this._continueJump();
        }
      } else {
        const eased = easeInOutCubic(this.animation.progress);
        this.animation.pivot.rotation[this.animation.params.axis] = eased * this.animation.targetAngle;
      }
      needsRender = true;
    } else if (this.pauseTimer > 0) {
      this.pauseTimer -= delta;
      if (this.pauseTimer <= 0 && this.targetStep >= 0 && this.targetStep !== this.currentStep) {
        this._continueJump();
      }
    } else if (this.isPlaying && this.currentStep < this.moves.length - 1) {
      this.nextStep();
    } else if (this.isPlaying && this.currentStep >= this.moves.length - 1) {
      this.isPlaying = false;
      if (this.onPlaybackComplete) this.onPlaybackComplete();
    }

    this.controls.update();

    // nextStep / continueJump 可能在本帧启动了新动画
    if (this.animation) needsRender = true;

    // TrackballControls 阻尼动画期间相机仍在移动
    if (needsRender || this._cameraMoved()) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  _cameraMoved() {
    const p = this.camera.position;
    const moved = Math.abs(p.x - this._prevCamX) > 1e-6 ||
                   Math.abs(p.y - this._prevCamY) > 1e-6 ||
                   Math.abs(p.z - this._prevCamZ) > 1e-6;
    this._prevCamX = p.x; this._prevCamY = p.y; this._prevCamZ = p.z;
    return moved;
  }

  dispose() {
    this._introCancelled = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    window.removeEventListener('resize', this._resizeHandler);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
