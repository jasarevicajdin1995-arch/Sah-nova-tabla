import * as THREE from "three";
import { GLTFLoader }     from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

// ═══════════════════════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════════════════════
const chess = new Chess();
const FILES = ["a","b","c","d","e","f","g","h"];

let selectedSquare    = null;
let legalTargets      = [];
let lastMoveSquares   = [];
let engineBusy        = false;
let engineReady       = false;
let engineStartSent   = false;
let pendingEngineMove = false;
let engineLoadTimer   = null;
let isAnimating       = false;

// ── Undo stack ──────────────────────────────────────────────────
const snapshotStack   = [];
const allPieceObjects = new Set();

// ── King/Queen template swap ────────────────────────────────────
let templatesSwapped = false;

// ── Orbit / rotation ────────────────────────────────────────────
const ORBIT_TARGET    = new THREE.Vector3(-0.1, 0, -2);
let orbitRadius       = 41.23;
let orbitPhi          = Math.acos(32 / Math.sqrt(32*32 + 26*26));
let orbitTheta        = 0;
let baseOrbitRadius   = 41.23;   // auto-fit computed value
let userZoomMultiplier = 1.0;    // user-controlled zoom on top of auto-fit

let rotationModeActive = false;
let orbitDragActive    = false;
let orbitLastX = 0, orbitLastY = 0;
const activePointers   = new Map();
let pinchActive        = false;
let pinchStartDist     = 0;
let pinchStartMultiplier = 1.0;

// Board corners (GLB world space) for camera auto-fit
const BOARD_CORNERS = [
  new THREE.Vector3(-9.68, 0,  8.96),
  new THREE.Vector3( 9.50, 0,  8.96),
  new THREE.Vector3(-9.68, 0, -10.36),
  new THREE.Vector3( 9.50, 0, -10.36),
  // Include modest piece height so tall pieces aren't cropped
  new THREE.Vector3(-9.68, 3.2,  8.96),
  new THREE.Vector3( 9.50, 3.2, -10.36),
];

// ═══════════════════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════════════════
const statusTextEl    = document.getElementById("status-text");
const lastMoveEl      = document.getElementById("last-move-text");
const mateBannerEl    = document.getElementById("mate-banner");
const newGameBtn      = document.getElementById("new-game");
const undoBtn         = document.getElementById("undo-btn");
const rotateBtn       = document.getElementById("rotate-btn");
const finishRotateBtn = document.getElementById("finish-rotate-btn");
const undoOverlay     = document.getElementById("undo-overlay");
const rotateOverlay   = document.getElementById("rotate-overlay");
const finishRotateOverlay = document.getElementById("finish-rotate-overlay");
const toggleMusicBtn  = document.getElementById("toggle-music");
const prevSongBtn     = document.getElementById("prev-song");
const nextSongBtn     = document.getElementById("next-song");
const songNameEl      = document.getElementById("song-name");
const musicStateEl    = document.getElementById("music-state");
const canvasEl        = document.getElementById("board-canvas");
const boardContainer  = document.getElementById("board-container");
const diffBtns        = document.querySelectorAll(".diff-btn");
const capByBlackEl    = document.getElementById("cap-by-black-pieces");  // left sidebar (black captured white)
const capByWhiteEl    = document.getElementById("cap-by-white-pieces");  // right sidebar (white captured black)

// ═══════════════════════════════════════════════════════════════
//  DIFFICULTY
// ═══════════════════════════════════════════════════════════════
const DIFFICULTY = {
  easy:   { skill: 2,  depth: 5,  label: "🟢 Lako"   },
  medium: { skill: 10, depth: 12, label: "🟡 Srednje" },
  hard:   { skill: 20, depth: 18, label: "🔴 Teško"   },
};
let currentDifficulty = "medium";
diffBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    currentDifficulty = btn.dataset.level;
    diffBtns.forEach(b => b.classList.toggle("active", b === btn));
    if (engine && engineReady)
      engine.postMessage(`setoption name Skill Level value ${DIFFICULTY[currentDifficulty].skill}`);
  });
});

// ═══════════════════════════════════════════════════════════════
//  RENDERER  — transparent background; dark color comes from CSS
// ═══════════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
renderer.outputColorSpace    = THREE.SRGBColorSpace;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
// Transparent clear — CSS background on the container provides the dark fill
renderer.setClearColor(0x000000, 0);

// ═══════════════════════════════════════════════════════════════
//  SCENE  +  ENVIRONMENT
// ═══════════════════════════════════════════════════════════════
const scene = new THREE.Scene();
// NO scene.background — use CSS dark background instead
const pmrem  = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment()).texture;
scene.environment = envMap;
pmrem.dispose();

// ═══════════════════════════════════════════════════════════════
//  CAMERA
// ═══════════════════════════════════════════════════════════════
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
camera.position.set(-0.1, 32, 24);
camera.lookAt(-0.1, 0, -2);

function updateCameraFromOrbit() {
  const sp = Math.sin(orbitPhi), cp = Math.cos(orbitPhi);
  const st = Math.sin(orbitTheta), ct = Math.cos(orbitTheta);
  camera.position.set(
    ORBIT_TARGET.x + orbitRadius * sp * st,
    ORBIT_TARGET.y + orbitRadius * cp,
    ORBIT_TARGET.z + orbitRadius * sp * ct
  );
  camera.lookAt(ORBIT_TARGET);
  camera.updateProjectionMatrix();
}

// ── Auto-fit: find smallest orbitRadius where board corners fit ─
const _tmpV = new THREE.Vector3();
function autoFitCamera(pad = 0.03) {
  let lo = 12, hi = 180;
  for (let i = 0; i < 42; i++) {
    orbitRadius = (lo + hi) * 0.5;
    updateCameraFromOrbit();
    let fits = true;
    for (const p of BOARD_CORNERS) {
      _tmpV.copy(p).project(camera);
      if (Math.abs(_tmpV.x) > 1 - pad || Math.abs(_tmpV.y) > 1 - pad) { fits = false; break; }
    }
    if (fits) hi = orbitRadius;
    else      lo = orbitRadius;
  }
  baseOrbitRadius = hi;
  orbitRadius = baseOrbitRadius * userZoomMultiplier;
  updateCameraFromOrbit();
}

// ═══════════════════════════════════════════════════════════════
//  LIGHTS
// ═══════════════════════════════════════════════════════════════
scene.add(new THREE.AmbientLight(0xfff4e8, 0.3));
const key = new THREE.DirectionalLight(0xfff8f0, 1.6);
key.position.set(-5, 45, 25);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1; key.shadow.camera.far = 100;
key.shadow.camera.left = key.shadow.camera.bottom = -16;
key.shadow.camera.right= key.shadow.camera.top    =  16;
key.shadow.bias = -0.0005;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9ab8e0, 0.5);
fill.position.set(10, 20, -20); scene.add(fill);
const rim  = new THREE.DirectionalLight(0xffe0b0, 0.25);
rim.position.set(0, 10, -30);  scene.add(rim);

// ═══════════════════════════════════════════════════════════════
//  GLB COORDINATE SYSTEM
// ═══════════════════════════════════════════════════════════════
const GLB_X0 = -9.68;
const GLB_XS =  2.74;
const GLB_Z0 = -10.36;
const GLB_ZS =  2.76;
const GLB_Y  =  0.0;

function glbPos(sq) {
  const fi = sq.charCodeAt(0) - 97;
  const rk = parseInt(sq[1]);
  return new THREE.Vector3(
    GLB_X0 + fi * GLB_XS,
    GLB_Y,
    GLB_Z0 + (8 - rk) * GLB_ZS
  );
}

// ═══════════════════════════════════════════════════════════════
//  PIECE MATERIALS
// ═══════════════════════════════════════════════════════════════
const MAT_W = new THREE.MeshStandardMaterial({
  color: 0xddd5b8, roughness: 0.14, metalness: 0.35, envMapIntensity: 1.6,
});
const MAT_B = new THREE.MeshStandardMaterial({
  color: 0x5a2d0c, roughness: 0.30, metalness: 0.20, envMapIntensity: 1.0,
});
const MAT_BOARD_BOOST = { envMapIntensity: 0.7 };

// ═══════════════════════════════════════════════════════════════
//  PIECE TRACKING
// ═══════════════════════════════════════════════════════════════
const pieceAtSquare  = new Map();
const templates      = { w: {}, b: {} };
const promotionPieces = [];

// ═══════════════════════════════════════════════════════════════
//  GLB LOADING
//  chess_board.glb  = new board visual  (XY plane, ±4.75 units)
//  chess-set.glb    = pieces only       (board meshes hidden)
// ═══════════════════════════════════════════════════════════════

// New board transform: it's flat in the XY plane — rotate to XZ plane,
// scale to match piece coordinate system, translate to board center.
//   Rotation -90° around X:  (x,y,z) → (x, z, -y)
//   Old board spans X: -9.68…9.50, Z: -10.36…8.96  (center ≈ -0.09, -0.70)
//   New board half-width: 4.75  → scale = 9.59 / 4.75 ≈ 2.02
const BOARD_SCALE     = (9.68 + 9.50) / 2 / 4.75;   // ≈ 2.019
const BOARD_CENTER_X  = (GLB_X0 + GLB_X0 + 7 * GLB_XS) / 2;  // ≈ -0.09
const BOARD_CENTER_Z  = (GLB_Z0 + GLB_Z0 + 7 * GLB_ZS) / 2;  // ≈ -0.70

function loadNewBoard() {
  return new Promise(resolve => {
    new GLTFLoader().load('./assets/chess_board.glb', gltf => {
      const root = gltf.scene;
      // DO NOT add any rotation — the GLB node hierarchy already handles
      // orientation (Sketchfab_model has Rx(-90°) baked in that lays board flat).
      // Adding another rotation here doubled it and made the board vertical.
      root.scale.setScalar(BOARD_SCALE);
      // Top playing surface of board is at world y ≈ +0.505 (before position).
      // Shift down so pieces at y=0 sit on the board surface.
      root.position.set(BOARD_CENTER_X, -0.50, BOARD_CENTER_Z);
      root.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow    = false;
        obj.receiveShadow = true;
        if (obj.material) {
          obj.material = obj.material.clone();
          obj.material.envMapIntensity = 0.6;
        }
      });
      scene.add(root);
      resolve();
    }, undefined, err => { console.warn('Board GLB load error:', err); resolve(); });
  });
}

function loadGLB() {
  return new Promise((resolve) => {
    new GLTFLoader().load(
      "./assets/chess-set.glb",
      (gltf) => {
        const root = gltf.scene;
        scene.add(root);

        const pieceMeshes = [];
        root.traverse(obj => {
          if (!obj.isMesh) return;
          const matName = obj.material?.name ?? "";
          obj.castShadow = true; obj.receiveShadow = true;
          if (matName === "aiStandardSurface1") {
            obj.material = MAT_W;
            pieceMeshes.push({ mesh: obj, color: "w" });
          } else if (matName === "aiStandardSurface2") {
            obj.material = MAT_B;
            pieceMeshes.push({ mesh: obj, color: "b" });
          } else {
            // Old board mesh — hide it; we use the new board GLB
            obj.visible = false;
          }
        });

        const initialBoard = chess.board();
        function boardPieceAt(sq) {
          const fi = sq.charCodeAt(0) - 97;
          const ri = 8 - parseInt(sq[1]);
          return initialBoard[ri][fi];
        }

        for (const { mesh, color } of pieceMeshes) {
          const bbox = new THREE.Box3().setFromObject(mesh);
          const cx = (bbox.min.x + bbox.max.x) / 2;
          const cz = (bbox.min.z + bbox.max.z) / 2;

          let bestSq = null, bestDist = Infinity;
          for (let ri = 0; ri < 8; ri++)
            for (let fi = 0; fi < 8; fi++) {
              const sq  = FILES[fi] + (8 - ri);
              const bp  = boardPieceAt(sq);
              if (!bp || bp.color !== color) continue;
              const pos  = glbPos(sq);
              const dist = Math.hypot(cx - pos.x, cz - pos.z);
              if (dist < bestDist) { bestDist = dist; bestSq = sq; }
            }

          if (!bestSq || bestDist > 2.5) continue;

          const moveable = mesh.parent ?? mesh;
          pieceAtSquare.set(bestSq, moveable);

          const type = boardPieceAt(bestSq).type;
          if (!templates[color][type])
            templates[color][type] = { obj: moveable, homeSq: bestSq };
        }
        resolve();
      },
      undefined,
      (err) => { console.error("GLB load error:", err); resolve(); }
    );
  });
}

// ═══════════════════════════════════════════════════════════════
//  KING / QUEEN VISUAL SWAP
// ═══════════════════════════════════════════════════════════════
function swapKingQueenVisuals() {
  // Only swap white pieces — GLB has white king-mesh at d1 and queen-mesh at e1
  // Black pieces in the GLB are already correctly placed (king mesh at e8, queen at d8)
  for (const [kSq, qSq] of [["e1","d1"]]) {
    const wrongAtK = pieceAtSquare.get(kSq);
    const wrongAtQ = pieceAtSquare.get(qSq);
    if (!wrongAtK || !wrongAtQ) continue;
    movePieceObjTo(wrongAtQ, qSq, kSq);
    movePieceObjTo(wrongAtK, kSq, qSq);
    pieceAtSquare.set(kSq, wrongAtQ);
    pieceAtSquare.set(qSq, wrongAtK);
  }
  if (!templatesSwapped) {
    // Only swap white templates; black templates stay as-is
    [templates.w.k, templates.w.q] = [templates.w.q, templates.w.k];
    templatesSwapped = true;
  }
}

// ═══════════════════════════════════════════════════════════════
//  PIECE MOVEMENT HELPERS
// ═══════════════════════════════════════════════════════════════
function movePieceObjTo(obj, fromSq, toSq) {
  const from = glbPos(fromSq), to = glbPos(toSq);
  obj.position.x += to.x - from.x;
  obj.position.z += to.z - from.z;
  obj.position.y  = 0;
}

function cloneForPromotion(color, type, toSq) {
  const tmpl = templates[color][type];
  if (!tmpl) return null;
  const clone = tmpl.obj.clone(true);
  clone.visible = true;
  const from = glbPos(tmpl.homeSq), to = glbPos(toSq);
  clone.position.set(to.x - from.x, 0, to.z - from.z);
  clone.traverse(c => {
    if (c.isMesh) { c.material = color === "w" ? MAT_W : MAT_B; c.castShadow = true; }
  });
  scene.add(clone);
  promotionPieces.push(clone);
  allPieceObjects.add(clone);
  return clone;
}

// ═══════════════════════════════════════════════════════════════
//  UNDO SNAPSHOTS
// ═══════════════════════════════════════════════════════════════
function saveSnapshot() {
  const snap = {
    pieceStates: [],
    pieceMapEntries: [...pieceAtSquare.entries()],
    promotionCount: promotionPieces.length,
    lastMoveSquares: [...lastMoveSquares],
  };
  allPieceObjects.forEach(obj => snap.pieceStates.push({
    obj, visible: obj.visible,
    x: obj.position.x, y: obj.position.y, z: obj.position.z,
  }));
  snapshotStack.push(snap);
}

function restoreSnapshot(snap) {
  while (promotionPieces.length > snap.promotionCount) {
    const p = promotionPieces.pop();
    scene.remove(p); allPieceObjects.delete(p);
  }
  snap.pieceStates.forEach(({ obj, visible, x, y, z }) => {
    obj.visible = visible; obj.position.set(x, y, z);
  });
  pieceAtSquare.clear();
  snap.pieceMapEntries.forEach(([sq, obj]) => pieceAtSquare.set(sq, obj));
  lastMoveSquares = [...snap.lastMoveSquares];
}

// ═══════════════════════════════════════════════════════════════
//  CAPTURED PIECES
// ═══════════════════════════════════════════════════════════════
const PIECE_UNICODE = {
  w: { p:'♙', n:'♘', b:'♗', r:'♖', q:'♕', k:'♔' },
  b: { p:'♟', n:'♞', b:'♝', r:'♜', q:'♛', k:'♚' },
};
const PIECE_ORDER = ['q','r','b','n','p'];

function updateCapturedDisplay() {
  const byWhite = {}, byBlack = {};
  for (const mv of chess.history({ verbose: true })) {
    if (!mv.captured) continue;
    const bucket = mv.color === 'w' ? byWhite : byBlack;
    bucket[mv.captured] = (bucket[mv.captured] || 0) + 1;
  }
  // Render each piece as a separate span so they stack vertically in the flex column
  function renderSidebar(bucket, color, el) {
    const pieces = PIECE_ORDER.flatMap(t => Array(bucket[t]||0).fill(PIECE_UNICODE[color][t]));
    el.innerHTML = pieces.map(p => `<span>${p}</span>`).join('');
  }
  // Left sidebar: black captured white pieces → show white symbols
  renderSidebar(byBlack, 'w', capByBlackEl);
  // Right sidebar: white captured black pieces → show black symbols
  renderSidebar(byWhite, 'b', capByWhiteEl);
}

// ═══════════════════════════════════════════════════════════════
//  HIGHLIGHTS
// ═══════════════════════════════════════════════════════════════
const hlMeshes = [];
const SQ_SIZE  = 2.6;
const HL_Y     = 0.5;

function clearHighlights() { hlMeshes.forEach(m => scene.remove(m)); hlMeshes.length = 0; }

function addOverlay(sq, color, opacity) {
  const p = glbPos(sq);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(SQ_SIZE, SQ_SIZE),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, HL_Y, p.z);
  m.renderOrder = 2;
  scene.add(m); hlMeshes.push(m);
}

function addDot(sq) {
  const p = glbPos(sq);
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 16),
    new THREE.MeshBasicMaterial({ color: 0x228844, transparent: true, opacity: 0.78, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, HL_Y + 0.05, p.z);
  m.renderOrder = 2;
  scene.add(m); hlMeshes.push(m);
}

function updateHighlights() {
  clearHighlights();
  lastMoveSquares.forEach(sq => addOverlay(sq, 0xddcc22, 0.42));
  if (selectedSquare) {
    addOverlay(selectedSquare, 0x88dd22, 0.52);
    legalTargets.forEach(sq =>
      chess.get(sq) ? addOverlay(sq, 0x22bb44, 0.45) : addDot(sq)
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  HIT-TEST SQUARES
// ═══════════════════════════════════════════════════════════════
const hitSquares = new Map();
const hitGeo = new THREE.PlaneGeometry(SQ_SIZE, SQ_SIZE);
const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

function buildHitSquares() {
  for (let ri = 0; ri < 8; ri++)
    for (let fi = 0; fi < 8; fi++) {
      const sq = FILES[fi] + (8 - ri);
      const p  = glbPos(sq);
      const m  = new THREE.Mesh(hitGeo, hitMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(p.x, HL_Y + 0.1, p.z);
      m.userData.square = sq;
      hitSquares.set(sq, m);
      scene.add(m);
    }
}

// ═══════════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════════
let renderPending = false;

function requestRender() {
  if (renderPending || isAnimating) return;
  renderPending = true;
  requestAnimationFrame(() => { renderer.render(scene, camera); renderPending = false; });
}

function resizeRenderer() {
  const w = boardContainer.clientWidth, h = boardContainer.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Auto-fit board into viewport, preserving user zoom preference
  autoFitCamera();
  requestRender();
}
new ResizeObserver(resizeRenderer).observe(boardContainer);

// ═══════════════════════════════════════════════════════════════
//  ANIMATION
// ═══════════════════════════════════════════════════════════════
function animateMove(fromSq, toSq, extraObjRemove, onComplete) {
  const obj = pieceAtSquare.get(fromSq);
  if (!obj) { onComplete(); requestRender(); return; }

  if (extraObjRemove) extraObjRemove.visible = false;

  const fromPos = glbPos(fromSq), toPos = glbPos(toSq);
  const dx = toPos.x - fromPos.x, dz = toPos.z - fromPos.z;
  const dist = Math.hypot(dx, dz);
  const ARC  = Math.min(dist * 0.25, 4.0);
  const T    = 320;
  const sx   = obj.position.x, sz = obj.position.z;

  pieceAtSquare.delete(fromSq);
  pieceAtSquare.set(toSq, obj);

  isAnimating = true;
  const t0 = performance.now();

  (function step(now) {
    const raw = Math.min((now - t0) / T, 1);
    const t   = raw < 0.5 ? 2*raw*raw : -1+(4-2*raw)*raw;
    obj.position.set(sx + dx*t, Math.sin(t*Math.PI)*ARC, sz + dz*t);
    renderer.render(scene, camera);
    if (raw < 1) requestAnimationFrame(step);
    else {
      obj.position.set(sx + dx, 0, sz + dz);
      isAnimating = false;
      onComplete();
      // ← Render immediately after onComplete so castling / special moves show up
      renderer.render(scene, camera);
    }
  })(t0);
}

// ═══════════════════════════════════════════════════════════════
//  BOARD SYNC (en-passant, etc.)
// ═══════════════════════════════════════════════════════════════
function syncPiecesToBoard() {
  const board = chess.board();
  for (let ri = 0; ri < 8; ri++)
    for (let fi = 0; fi < 8; fi++) {
      const sq = FILES[fi] + (8 - ri);
      if (!board[ri][fi] && pieceAtSquare.has(sq)) {
        pieceAtSquare.get(sq).visible = false;
        pieceAtSquare.delete(sq);
      }
    }
}

// ═══════════════════════════════════════════════════════════════
//  INTERACTION
// ═══════════════════════════════════════════════════════════════
const raycaster  = new THREE.Raycaster();
const pointer    = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y=0

// ── Pan state (drag on empty area to pan the camera target) ─────
let panPotential = false;   // touch started on empty area, might pan
let panActive    = false;   // moved enough → actively panning
let panDownX = 0, panDownY = 0;
let panLastX = 0, panLastY = 0;
const PAN_THRESHOLD_PX = 10;

/** Intersect a screen pixel with the board plane (Y=0); returns world pos or null */
function boardPlaneIntersect(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  pointer.set(
    ((clientX - rect.left) / rect.width)  *  2 - 1,
    ((clientY - rect.top)  / rect.height) * -2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(boardPlane, hit)) return null;
  if (hit.length() > 300) return null;   // near-horizon safety
  return hit.clone();
}

/** Returns chess square under screen pos if a piece is there, else null */
function getPieceSqAtScreen(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  pointer.set(
    ((clientX - rect.left) / rect.width)  *  2 - 1,
    ((clientY - rect.top)  / rect.height) * -2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const parts = [];
  pieceAtSquare.forEach(obj => obj.traverse(c => { if (c.isMesh) parts.push(c); }));
  const hits = raycaster.intersectObjects(parts);
  if (!hits.length) return null;
  let o = hits[0].object;
  const tracked = new Set(pieceAtSquare.values());
  while (o && !tracked.has(o)) o = o.parent;
  if (!o) return null;
  let sq = null;
  pieceAtSquare.forEach((v, k) => { if (v === o) sq = k; });
  return sq;
}

/** Full raycast: pieces → hit-test planes */
function doRaycast(clientX, clientY) {
  const sq = getPieceSqAtScreen(clientX, clientY);
  if (sq) { handleSquareClick(sq); return; }
  const rect = canvasEl.getBoundingClientRect();
  pointer.set(
    ((clientX - rect.left) / rect.width)  *  2 - 1,
    ((clientY - rect.top)  / rect.height) * -2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const sh = raycaster.intersectObjects([...hitSquares.values()]);
  if (sh.length) handleSquareClick(sh[0].object.userData.square);
}

function handleSquareClick(sq) {
  if (isAnimating || chess.turn() !== "w" || engineBusy || chess.isGameOver()) return;
  const piece = chess.get(sq);
  if (selectedSquare) {
    if (legalTargets.includes(sq))  { executePlayerMove(selectedSquare, sq); return; }
    if (piece?.color === "w")        { selectSquare(sq); return; }
    deselect(); return;
  }
  if (piece?.color === "w") selectSquare(sq);
}

function selectSquare(sq) {
  selectedSquare = sq;
  legalTargets   = chess.moves({ square: sq, verbose: true }).map(m => m.to);
  playLiftSound(); updateHighlights(); requestRender();
}

function deselect() {
  selectedSquare = null; legalTargets = [];
  updateHighlights(); requestRender();
}

// ─── Pointer events ─────────────────────────────────────────────
canvasEl.addEventListener("contextmenu", e => e.preventDefault());

canvasEl.addEventListener("pointerdown", e => {
  e.preventDefault(); unlockAudio();
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const isRight = e.button === 2;

  // Orbit: right-mouse (desktop) or rotation mode (single touch)
  if (isRight || (rotationModeActive && activePointers.size === 1)) {
    orbitDragActive = true;
    orbitLastX = e.clientX; orbitLastY = e.clientY;
    panPotential = panActive = false;
    canvasEl.setPointerCapture(e.pointerId);
    return;
  }

  // Normal left-click / single touch in play mode
  if (e.button === 0 && !isAnimating && activePointers.size === 1) {
    const pieceSq = getPieceSqAtScreen(e.clientX, e.clientY);
    if (pieceSq !== null) {
      // Piece → immediate select / move
      handleSquareClick(pieceSq);
      panPotential = panActive = false;
    } else {
      // Empty area → might pan, might be a short tap
      panPotential = true; panActive = false;
      panDownX = panLastX = e.clientX;
      panDownY = panLastY = e.clientY;
      canvasEl.setPointerCapture(e.pointerId);
    }
  }
});

canvasEl.addEventListener("pointermove", e => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Two-finger pinch zoom (highest priority)
  if (activePointers.size >= 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (!pinchActive) {
      pinchActive = true; pinchStartDist = dist; pinchStartMultiplier = userZoomMultiplier;
    } else {
      userZoomMultiplier = Math.max(0.35, Math.min(3.5,
        pinchStartMultiplier * (pinchStartDist / dist)));
      orbitRadius = baseOrbitRadius * userZoomMultiplier;
      updateCameraFromOrbit(); requestRender();
    }
    return;
  }
  pinchActive = false;

  // Orbit drag
  if (orbitDragActive) {
    const dx = e.clientX - orbitLastX, dy = e.clientY - orbitLastY;
    orbitLastX = e.clientX; orbitLastY = e.clientY;
    orbitTheta -= dx * 0.008;
    orbitPhi = Math.max(0.06, Math.min(Math.PI * 0.47, orbitPhi - dy * 0.008));
    updateCameraFromOrbit(); requestRender();
    return;
  }

  // Pan (drag on empty area)
  if (panPotential) {
    const moved = Math.hypot(e.clientX - panDownX, e.clientY - panDownY);
    if (!panActive && moved > PAN_THRESHOLD_PX) {
      panActive = true;
      // Deselect piece so we don't accidentally fire a move
      selectedSquare = null; legalTargets = [];
      updateHighlights();
    }
    if (panActive) {
      const prev3D = boardPlaneIntersect(panLastX, panLastY);
      const curr3D = boardPlaneIntersect(e.clientX, e.clientY);
      if (prev3D && curr3D) {
        // Shift camera target so the board point under the finger stays put
        ORBIT_TARGET.add(prev3D.sub(curr3D));
        updateCameraFromOrbit(); requestRender();
      }
      panLastX = e.clientX; panLastY = e.clientY;
    }
  }
});

canvasEl.addEventListener("pointerup", e => {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchActive = false;
  if (activePointers.size === 0) orbitDragActive = false;

  // Short tap on empty area → treat as game click (move-to-square / deselect)
  if (panPotential && !panActive && e.button === 0)
    doRaycast(e.clientX, e.clientY);

  panPotential = panActive = false;
});

canvasEl.addEventListener("pointercancel", e => {
  activePointers.delete(e.pointerId);
  if (activePointers.size === 0) { orbitDragActive = false; pinchActive = false; }
  panPotential = panActive = false;
});

canvasEl.addEventListener("wheel", e => {
  e.preventDefault();
  userZoomMultiplier = Math.max(0.35, Math.min(3.5,
    userZoomMultiplier * (1 + e.deltaY * 0.0012)));
  orbitRadius = baseOrbitRadius * userZoomMultiplier;
  updateCameraFromOrbit();
  requestRender();
}, { passive: false });

// ─── Rotation buttons ────────────────────────────────────────────
function enterRotationMode() {
  rotationModeActive = true;
  boardContainer.classList.add("rotation-active");
  rotateBtn.classList.add("hidden");
  finishRotateBtn.classList.remove("hidden");
  rotateOverlay.classList.add("hidden");
  finishRotateOverlay.classList.remove("hidden");
  deselect();
}

function exitRotationMode() {
  rotationModeActive = false;
  boardContainer.classList.remove("rotation-active");
  rotateBtn.classList.remove("hidden");
  finishRotateBtn.classList.add("hidden");
  rotateOverlay.classList.remove("hidden");
  finishRotateOverlay.classList.add("hidden");
}

rotateBtn.addEventListener("click", () => { unlockAudio(); enterRotationMode(); });
finishRotateBtn.addEventListener("click", () => { unlockAudio(); exitRotationMode(); });
rotateOverlay.addEventListener("click", () => { unlockAudio(); enterRotationMode(); });
finishRotateOverlay.addEventListener("click", () => { unlockAudio(); exitRotationMode(); });

// ═══════════════════════════════════════════════════════════════
//  EXECUTE PLAYER MOVE
// ═══════════════════════════════════════════════════════════════
function executePlayerMove(from, to) {
  saveSnapshot();
  const capturePieceObj = pieceAtSquare.get(to) ?? null;
  const move = chess.move({ from, to, promotion: "q" });
  if (!move) { snapshotStack.pop(); deselect(); return; }

  lastMoveSquares = [from, to];
  selectedSquare  = null; legalTargets = [];
  updateHighlights();
  playMoveSound(!!move.captured);

  animateMove(from, to, capturePieceObj, () => {
    handleSpecialMove(move);
    syncPiecesToBoard();
    updateCapturedDisplay();
    updateAfterMove(move, "Ti");
    if (!chess.isGameOver()) requestEngineMove();
  });
}

function handleSpecialMove(move) {
  // Rokada (Castling)
  if (move.flags.includes("k") || move.flags.includes("q")) {
    const rank  = move.color === "w" ? "1" : "8";
    const kside = move.flags.includes("k");
    const rookFrom = (kside ? "h" : "a") + rank;
    const rookTo   = (kside ? "f" : "d") + rank;
    const rookObj  = pieceAtSquare.get(rookFrom);
    if (rookObj) {
      movePieceObjTo(rookObj, rookFrom, rookTo);
      pieceAtSquare.delete(rookFrom);
      pieceAtSquare.set(rookTo, rookObj);
    }
  }
  // Promotion
  if (move.flags.includes("p")) {
    const pawnObj = pieceAtSquare.get(move.to);
    if (pawnObj) { pawnObj.visible = false; pieceAtSquare.delete(move.to); }
    const newPiece = cloneForPromotion(move.color, move.promotion || "q", move.to);
    if (newPiece) pieceAtSquare.set(move.to, newPiece);
  }
}

// ═══════════════════════════════════════════════════════════════
//  UNDO
// ═══════════════════════════════════════════════════════════════
undoBtn.addEventListener("click", doUndo);
undoOverlay.addEventListener("click", doUndo);

function doUndo() {
  unlockAudio();
  if (isAnimating || engineBusy || snapshotStack.length === 0) return;
  const hist = chess.history().length;
  if (hist === 0) return;
  const snap = snapshotStack.pop();
  if (chess.turn() === "w" && hist >= 2) chess.undo();
  if (chess.history().length > 0 || hist === 1) chess.undo();
  restoreSnapshot(snap);
  engineBusy = false; pendingEngineMove = false;
  selectedSquare = null; legalTargets = [];
  mateBannerEl.classList.add("hidden");
  updateCapturedDisplay();
  updateHighlights();
  refreshStatus();
  requestRender();
}

// ═══════════════════════════════════════════════════════════════
//  STOCKFISH ENGINE
// ═══════════════════════════════════════════════════════════════
const engine = (() => {
  try {
    const w = new Worker("./stockfish-worker.js");
    w.onmessage = handleEngineMsg;
    w.onerror   = () => { engineReady = engineBusy = false; setStatus("Stockfish se nije učitao."); };
    engineLoadTimer = setTimeout(() => { if (!engineReady) setStatus("Stockfish se još učitava…"); }, 5000);
    w.postMessage("uci");
    w.postMessage(`setoption name Skill Level value ${DIFFICULTY[currentDifficulty].skill}`);
    w.postMessage("isready");
    engineStartSent = true;
    return w;
  } catch { setStatus("Stockfish nije dostupan."); return null; }
})();

function requestEngineMove() {
  if (!engine) { setStatus("Stockfish nije dostupan."); return; }
  if (!engineReady) {
    pendingEngineMove = true;
    if (!engineStartSent) { engine.postMessage("uci"); engine.postMessage("isready"); engineStartSent = true; }
    setStatus("Stockfish se priprema…"); return;
  }
  pendingEngineMove = false; engineBusy = true;
  setStatus("Stockfish razmišlja…");
  engine.postMessage("ucinewgame");
  engine.postMessage(`position fen ${chess.fen()}`);
  engine.postMessage(`go depth ${DIFFICULTY[currentDifficulty].depth}`);
}

function handleEngineMsg(event) {
  const text = (typeof event.data === "string") ? event.data.trim() : "";
  if (!text) return;
  if (text === "uciok")   { engineStartSent = true; return; }
  if (text === "readyok") {
    engineReady = true;
    engine.postMessage(`setoption name Skill Level value ${DIFFICULTY[currentDifficulty].skill}`);
    if (engineLoadTimer) { clearTimeout(engineLoadTimer); engineLoadTimer = null; }
    if (pendingEngineMove && chess.turn() === "b" && !chess.isGameOver()) requestEngineMove();
    else refreshStatus(); return;
  }
  if (text.startsWith("bestmove ")) {
    engineBusy = false;
    const bm = text.split(/\s+/)[1];
    if (!bm || bm === "(none)") { refreshStatus(); return; }
    const from = bm.slice(0,2), to = bm.slice(2,4), pro = bm.slice(4,5)||"q";
    const capturePieceObj = pieceAtSquare.get(to) ?? null;
    const move = chess.move({ from, to, promotion: pro });
    if (!move) { refreshStatus(); return; }
    lastMoveSquares = [from, to];
    playMoveSound(!!move.captured);
    animateMove(from, to, capturePieceObj, () => {
      handleSpecialMove(move);
      syncPiecesToBoard();
      updateCapturedDisplay();
      updateAfterMove(move, "Stockfish");
    });
    updateHighlights(); requestRender();
  }
}

// ═══════════════════════════════════════════════════════════════
//  STATUS
// ═══════════════════════════════════════════════════════════════
function setStatus(msg) { statusTextEl.textContent = msg; }

function updateAfterMove(move, actor) {
  lastMoveEl.textContent = `${actor}: ${move.san || move.from+"→"+move.to}`;
  mateBannerEl.classList.add("hidden");
  if (chess.isCheckmate()) {
    const won = actor === "Ti";
    mateBannerEl.textContent = won ? "Mat! Pobijedio si! 🏆" : "Mat! Izgubio si.";
    mateBannerEl.classList.remove("hidden");
    setStatus(won ? "Čestitamo! Pobijedio si Stockfish!" : "Mat! Stockfish je pobijedio."); return;
  }
  if (chess.isStalemate()) { setStatus("Pat! Remi."); return; }
  if (chess.isDraw())      { setStatus("Remi! Partija je završena izjednačeno."); return; }
  if (chess.isCheck())     { setStatus(actor==="Ti" ? "Šah! Stockfish je u šahu." : "Šah! Ti si u šahu."); return; }
  refreshStatus();
}

function refreshStatus() {
  if (chess.isGameOver()) return;
  if (chess.turn()==="w") setStatus("Tvoj potez. Bijeli igraju.");
  else if (engineBusy)    setStatus("Stockfish razmišlja…");
  else if (engineReady)   setStatus("Stockfish je na potezu.");
  else                    setStatus("Stockfish se priprema…");
}

// ═══════════════════════════════════════════════════════════════
//  NEW GAME
// ═══════════════════════════════════════════════════════════════
newGameBtn.addEventListener("click", () => {
  unlockAudio();
  promotionPieces.forEach(p => scene.remove(p));
  promotionPieces.length = 0;

  pieceAtSquare.forEach(obj => { obj.position.set(0,0,0); obj.visible = true; });
  pieceAtSquare.clear();

  for (const color of ["w","b"])
    for (const type of ["k","q","b","n","r","p"]) {
      const tmpl = templates[color][type];
      if (tmpl) tmpl.obj.visible = true;
    }

  scene.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.material === MAT_W || obj.material === MAT_B) {
      const g = obj.parent ?? obj;
      g.position.set(0,0,0); g.visible = true;
    }
  });

  chess.reset();
  rebuildPieceAtSquare();
  swapKingQueenVisuals();

  allPieceObjects.clear();
  pieceAtSquare.forEach(obj => allPieceObjects.add(obj));
  snapshotStack.length = 0;

  // Reset user zoom so board fills viewport again after new game
  userZoomMultiplier = 1.0;
  autoFitCamera();

  selectedSquare = null; legalTargets = []; lastMoveSquares = [];
  engineBusy = false; pendingEngineMove = false;
  mateBannerEl.classList.add("hidden");
  lastMoveEl.textContent = "Još nema poteza.";
  updateCapturedDisplay();

  if (engine) { engineReady = false; engine.postMessage("uci"); engine.postMessage("isready"); }
  setStatus("Nova partija. Ti si bijeli.");
  updateHighlights(); requestRender();
});

function rebuildPieceAtSquare() {
  pieceAtSquare.clear();
  const initialBoard = chess.board();
  function boardPieceAt(sq) {
    const fi = sq.charCodeAt(0) - 97;
    const ri = 8 - parseInt(sq[1]);
    return initialBoard[ri][fi];
  }
  const used = new Set();
  scene.traverse(obj => {
    if (!obj.isMesh) return;
    if (obj.material !== MAT_W && obj.material !== MAT_B) return;
    const color = obj.material === MAT_W ? "w" : "b";
    const moveable = obj.parent ?? obj;
    if (used.has(moveable)) return;
    const bbox = new THREE.Box3().setFromObject(obj);
    const cx = (bbox.min.x + bbox.max.x) / 2;
    const cz = (bbox.min.z + bbox.max.z) / 2;
    let bestSq = null, bestDist = Infinity;
    for (let ri = 0; ri < 8; ri++)
      for (let fi = 0; fi < 8; fi++) {
        const sq = FILES[fi] + (8-ri);
        const bp = boardPieceAt(sq);
        if (!bp || bp.color !== color || pieceAtSquare.has(sq)) continue;
        const p = glbPos(sq);
        const d = Math.hypot(cx - p.x, cz - p.z);
        if (d < bestDist) { bestDist = d; bestSq = sq; }
      }
    if (bestSq && bestDist < 2.5) { pieceAtSquare.set(bestSq, moveable); used.add(moveable); }
  });
}

// ═══════════════════════════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════════════════════════
let audioCtx = null, sfxGain = null, audioReady = false;

function unlockAudio() {
  if (audioReady) { if (audioCtx.state === "suspended") audioCtx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC(); sfxGain = audioCtx.createGain();
  sfxGain.gain.value = 0.72; sfxGain.connect(audioCtx.destination);
  audioReady = true;
  if (audioCtx.state === "suspended") audioCtx.resume();
  if (musicEnabled && songs.length) playCurrentSong();
}

function playMoveSound(isCapture = false) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime, len = isCapture ? 0.20 : 0.14;
  const sz  = Math.ceil(audioCtx.sampleRate*(len+0.05));
  const buf = audioCtx.createBuffer(1,sz,audioCtx.sampleRate);
  const d   = buf.getChannelData(0); for (let i=0;i<sz;i++) d[i]=Math.random()*2-1;
  const noise = audioCtx.createBufferSource(); noise.buffer=buf;
  const bp=audioCtx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=isCapture?700:480; bp.Q.value=2.5;
  const lp=audioCtx.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=2400;
  const g=audioCtx.createGain();
  g.gain.setValueAtTime(0,now); g.gain.linearRampToValueAtTime(isCapture?1.0:0.85,now+0.004);
  g.gain.exponentialRampToValueAtTime(0.001,now+len);
  const echo=audioCtx.createDelay(); echo.delayTime.value=0.024;
  const eg=audioCtx.createGain(); eg.gain.setValueAtTime(0,now);
  eg.gain.linearRampToValueAtTime(0.28,now+0.028);
  eg.gain.exponentialRampToValueAtTime(0.001,now+len+0.07);
  noise.connect(bp); bp.connect(lp); lp.connect(g); g.connect(sfxGain);
  bp.connect(echo); echo.connect(eg); eg.connect(sfxGain);
  noise.start(now); noise.stop(now+len+0.1);
}

function playLiftSound() {
  if (!audioCtx) return;
  const now=audioCtx.currentTime, sz=Math.ceil(audioCtx.sampleRate*0.060);
  const buf=audioCtx.createBuffer(1,sz,audioCtx.sampleRate); const d=buf.getChannelData(0);
  for(let i=0;i<sz;i++) d[i]=Math.random()*2-1;
  const noise=audioCtx.createBufferSource(); noise.buffer=buf;
  const bp=audioCtx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=920; bp.Q.value=3.2;
  const g=audioCtx.createGain(); g.gain.setValueAtTime(0,now);
  g.gain.linearRampToValueAtTime(0.38,now+0.003); g.gain.exponentialRampToValueAtTime(0.001,now+0.060);
  noise.connect(bp); bp.connect(g); g.connect(sfxGain); noise.start(now); noise.stop(now+0.07);
}

// ═══════════════════════════════════════════════════════════════
//  MUSIC
// ═══════════════════════════════════════════════════════════════
let songs=[],currentIdx=0,musicEnabled=true,musicAudio=null,musicStarted=false;

async function loadSongs() {
  try {
    const res = await fetch("./assets/music/songs.json");
    if (res.ok) songs = await res.json(); else throw new Error();
  } catch {
    try {
      const res2 = await fetch("/api/songs");
      if (res2.ok) songs = await res2.json();
    } catch { songs = []; }
  }
  if (!songs.length) {
    songNameEl.textContent="Uredi songs.json za muziku";
    prevSongBtn.disabled=nextSongBtn.disabled=true;
    musicStateEl.textContent=""; return;
  }
  for (let i=songs.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1)); [songs[i],songs[j]]=[songs[j],songs[i]];
  }
  currentIdx=0; updateSongDisplay();
  if (audioReady && musicEnabled) playCurrentSong();
}
function updateSongDisplay() {
  if (!songs.length) return;
  songNameEl.textContent=songs[currentIdx].name;
  musicStateEl.textContent=musicEnabled?(musicStarted?"▶ svira":"▶ čeka klik"):"⏸ pauza";
}
function playCurrentSong() {
  if (!songs.length) return;
  if (!musicAudio) {
    musicAudio=new Audio(); musicAudio.volume=0.50;
    musicAudio.addEventListener("ended",()=>{ currentIdx=(currentIdx+1)%songs.length; playCurrentSong(); });
  }
  musicAudio.src=songs[currentIdx].file; musicAudio.load();
  musicAudio.play().then(()=>{ musicStarted=true; updateSongDisplay(); }).catch(()=>{});
}
function stopCurrentSong() { if(musicAudio){musicAudio.pause();musicAudio.currentTime=0;} musicStarted=false; }
prevSongBtn.addEventListener("click",()=>{ unlockAudio(); currentIdx=((currentIdx-1)+songs.length)%songs.length; if(musicEnabled&&songs.length){stopCurrentSong();playCurrentSong();}else updateSongDisplay(); });
nextSongBtn.addEventListener("click",()=>{ unlockAudio(); currentIdx=(currentIdx+1)%songs.length; if(musicEnabled&&songs.length){stopCurrentSong();playCurrentSong();}else updateSongDisplay(); });
toggleMusicBtn.addEventListener("click",()=>{ unlockAudio(); musicEnabled=!musicEnabled; toggleMusicBtn.textContent=musicEnabled?"Muzika: uključena":"Muzika: isključena"; if(musicEnabled&&songs.length)playCurrentSong();else stopCurrentSong(); updateSongDisplay(); });

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
async function init() {
  resizeRenderer();
  setStatus("Učitavanje 3D modela…");
  await loadNewBoard();   // new board visual first (renders behind pieces)
  await loadGLB();        // pieces from old chess-set.glb (board meshes hidden)
  buildHitSquares();
  swapKingQueenVisuals();
  allPieceObjects.clear();
  pieceAtSquare.forEach(obj => allPieceObjects.add(obj));
  updateCapturedDisplay();
  updateHighlights();
  refreshStatus();
  loadSongs();
  autoFitCamera();
  requestRender();
}

init();
