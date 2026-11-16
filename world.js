/**
 * AzogStream — Praça
 * Um lounge gamer em pixel art onde o avatar de cada pessoa da sala passeia
 * quando ninguém está transmitindo (ou quando você escolhe "Praça" no topo).
 *
 * O cenário é desenhado por código numa resolução pequena (384x216) e esticado
 * sem suavização, então o visual é pixelado e o custo é mínimo. Nomes e balões
 * de chat são HTML por cima, para ficarem nítidos.
 *
 * Rede: só o destino de cada caminhada viaja pela sala (mensagem WALK, uma a
 * cada poucos segundos por pessoa). Cada tela anima o trajeto sozinha.
 */

const WORLD_W = 384;
const WORLD_H = 216;
const WALL_B = 120;
const WALK_AREA = { x0: 18, x1: 366, y0: 138, y1: 208 };
const TV_RECT = { x: 148, y: 18, w: 88, h: 60 };

const world = {
  stage: null,
  frame: null,
  canvas: null,
  g: null,
  labelsEl: null,
  bg: null,
  stars: [],
  walkers: new Map(),
  labels: new Map(),
  active: false,
  raf: 0,
  lastTs: 0,
  lastDraw: 0,
  clock: 0,
  logo: { x: 6, y: 6, vx: 13, vy: 8, hue: 280 },
  shooting: null,
  nextShooting: 6
};

// ---------------------------------------------------------
// Utilidades
// ---------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function worldRand(min, max) {
  return min + Math.random() * (max - min);
}

function clampWalk(x, y) {
  return {
    x: Math.max(WALK_AREA.x0, Math.min(WALK_AREA.x1, x)),
    y: Math.max(WALK_AREA.y0, Math.min(WALK_AREA.y1, y))
  };
}

function fillCircle(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    g.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

function liveStreamers() {
  return Array.from(state.members.values()).filter((m) => m.isStreaming);
}

// ---------------------------------------------------------
// Cenário estático (desenhado uma vez)
// ---------------------------------------------------------
function buildWorldBackground() {
  const c = document.createElement('canvas');
  c.width = WORLD_W;
  c.height = WORLD_H;
  const g = c.getContext('2d');
  const W = WORLD_W;
  const H = WORLD_H;

  // Parede em degradê, divisões e lambri
  for (let y = 0; y < WALL_B; y += 2) {
    g.fillStyle = lerpColor('#1a0f33', '#2f1b54', y / WALL_B);
    g.fillRect(0, y, W, 2);
  }
  g.fillStyle = 'rgba(0,0,0,0.14)';
  for (let x = 0; x < W; x += 48) g.fillRect(x, 0, 1, WALL_B);
  g.fillStyle = '#23133f';
  g.fillRect(0, 92, W, WALL_B - 92);
  g.fillStyle = '#3d2569';
  g.fillRect(0, 92, W, 2);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let x = 0; x < W; x += 32) g.fillRect(x, 94, 1, WALL_B - 94);
  g.fillStyle = '#120a22';
  g.fillRect(0, WALL_B - 4, W, 4);

  // Piso xadrez
  for (let y = WALL_B; y < H; y += 12) {
    for (let x = 0; x < W; x += 24) {
      const odd = (x / 24 + (y - WALL_B) / 12) % 2;
      g.fillStyle = odd ? '#2e1e4f' : '#291a46';
      g.fillRect(x, y, 24, 12);
    }
  }
  const floorShade = g.createLinearGradient(0, WALL_B, 0, H);
  floorShade.addColorStop(0, 'rgba(0,0,0,0.38)');
  floorShade.addColorStop(0.12, 'rgba(0,0,0,0)');
  floorShade.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = floorShade;
  g.fillRect(0, WALL_B, W, H - WALL_B);

  // Tapete
  const rx = 116;
  const ry = 152;
  const rw = 152;
  const rh = 52;
  g.fillStyle = '#6d28d9';
  g.fillRect(rx, ry, rw, rh);
  g.fillStyle = '#2e1065';
  g.fillRect(rx + 3, ry + 3, rw - 6, rh - 6);
  g.fillStyle = '#4c1d95';
  g.fillRect(rx + 8, ry + 8, rw - 16, rh - 16);
  g.fillStyle = '#a855f7';
  for (let i = 0; i < 5; i++) {
    const cx = rx + 26 + i * 25;
    const cy = ry + rh / 2;
    g.fillRect(cx - 1, cy - 5, 2, 10);
    g.fillRect(cx - 5, cy - 1, 10, 2);
  }
  g.fillStyle = '#c4b5fd';
  for (let y = ry + 2; y < ry + rh - 2; y += 4) {
    g.fillRect(rx - 2, y, 2, 2);
    g.fillRect(rx + rw, y, 2, 2);
  }

  // Janela com a cidade à noite
  g.fillStyle = '#0a0614';
  g.fillRect(20, 14, 84, 66);
  for (let y = 17; y < 75; y += 2) {
    g.fillStyle = lerpColor('#0b0a26', '#3a1d63', (y - 17) / 58);
    g.fillRect(23, y, 78, 2);
  }
  fillCircle(g, 88, 30, 7, 'rgba(253,246,216,0.18)');
  fillCircle(g, 88, 30, 5, '#fdf6d8');
  g.fillStyle = '#e6dcb0';
  g.fillRect(86, 29, 2, 2);
  g.fillRect(90, 32, 1, 1);
  const rnd = mulberry32(7);
  let bx = 23;
  while (bx < 101) {
    const bw = 6 + Math.floor(rnd() * 9);
    const bh = 10 + Math.floor(rnd() * 28);
    const w = Math.min(bw, 101 - bx);
    g.fillStyle = '#0d0a20';
    g.fillRect(bx, 74 - bh, w, bh);
    for (let wy = 74 - bh + 3; wy < 72; wy += 4) {
      for (let wx = bx + 2; wx < bx + w - 1; wx += 3) {
        if (rnd() < 0.35) {
          g.fillStyle = rnd() < 0.7 ? '#fde68a' : '#f0abfc';
          g.fillRect(wx, wy, 1, 2);
        }
      }
    }
    bx += bw + 1;
  }
  g.fillStyle = '#0a0614';
  g.fillRect(61, 17, 2, 57);
  g.fillRect(23, 44, 78, 2);
  g.fillStyle = '#2a1850';
  g.fillRect(17, 80, 90, 3);
  g.fillStyle = '#1a0f33';
  g.fillRect(17, 83, 90, 1);

  // Estrelas (animadas depois)
  world.stars = [];
  const srnd = mulberry32(21);
  for (let i = 0; i < 16; i++) {
    const x = 25 + Math.floor(srnd() * 72);
    const y = 18 + Math.floor(srnd() * 22);
    if (Math.hypot(x - 88, y - 30) > 10) world.stars.push({ x, y, p: srnd() * 6 });
  }

  // Pôster
  g.fillStyle = '#a78bfa';
  g.fillRect(111, 25, 26, 36);
  g.fillStyle = '#e9d5ff';
  g.fillRect(112, 26, 24, 34);
  g.fillStyle = '#9333ea';
  g.fillRect(115, 29, 18, 4);
  g.fillStyle = '#312e81';
  g.fillRect(115, 38, 18, 9);
  g.fillStyle = '#e9d5ff';
  g.fillRect(118, 41, 4, 1);
  g.fillRect(119, 40, 2, 3);
  g.fillStyle = '#ef4444';
  g.fillRect(127, 40, 2, 2);
  g.fillStyle = '#22d3ee';
  g.fillRect(129, 42, 2, 2);
  g.fillStyle = '#7c3aed';
  g.fillRect(115, 51, 18, 2);
  g.fillRect(115, 54, 12, 2);

  // TV + móvel embaixo
  g.fillStyle = '#1c1033';
  g.fillRect(138, 100, 108, 16);
  g.fillStyle = '#2f1d55';
  g.fillRect(138, 100, 108, 2);
  g.fillStyle = '#0f0a1e';
  g.fillRect(152, 104, 32, 7);
  g.fillStyle = '#22c55e';
  g.fillRect(155, 107, 2, 2);
  g.fillStyle = '#a855f7';
  g.fillRect(160, 107, 2, 2);
  g.fillStyle = '#0f0a1e';
  g.fillRect(196, 104, 12, 9);
  g.fillRect(212, 104, 22, 9);

  // Placa do letreiro
  g.fillStyle = '#3b2368';
  g.fillRect(253, 15, 106, 38);
  g.fillStyle = '#0d0818';
  g.fillRect(254, 16, 104, 36);

  // Sofá
  g.fillStyle = '#4c1d95';
  g.fillRect(20, 94, 86, 18);
  g.fillStyle = '#5b21b6';
  g.fillRect(23, 96, 80, 14);
  g.fillStyle = '#6d28d9';
  g.fillRect(18, 108, 90, 16);
  g.fillStyle = '#7c3aed';
  g.fillRect(22, 110, 82, 6);
  g.fillStyle = '#4c1d95';
  g.fillRect(14, 100, 8, 24);
  g.fillRect(104, 100, 8, 24);
  g.fillStyle = '#5b21b6';
  g.fillRect(15, 101, 6, 6);
  g.fillRect(105, 101, 6, 6);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(48, 110, 1, 12);
  g.fillRect(76, 110, 1, 12);
  g.fillStyle = '#ec4899';
  g.fillRect(28, 100, 10, 10);
  g.fillStyle = '#f472b6';
  g.fillRect(29, 101, 8, 2);
  g.fillStyle = '#120a22';
  g.fillRect(18, 124, 4, 2);
  g.fillRect(104, 124, 4, 2);

  // Planta
  g.fillStyle = '#15803d';
  g.fillRect(126, 86, 3, 24);
  g.fillStyle = '#22c55e';
  g.fillRect(119, 92, 7, 3);
  g.fillRect(129, 90, 8, 3);
  g.fillStyle = '#16a34a';
  g.fillRect(121, 99, 6, 3);
  g.fillRect(129, 96, 7, 3);
  g.fillStyle = '#4ade80';
  g.fillRect(125, 83, 5, 3);
  g.fillStyle = '#d97706';
  g.fillRect(122, 108, 14, 3);
  g.fillStyle = '#b45309';
  g.fillRect(123, 111, 12, 12);

  // Fliperamas
  const arcade = (x, body, trim) => {
    g.fillStyle = body;
    g.fillRect(x, 62, 24, 60);
    g.fillStyle = trim;
    g.fillRect(x, 62, 24, 6);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x, 62, 2, 60);
    g.fillRect(x + 22, 62, 2, 60);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x + 2, 92, 20, 8);
    g.fillStyle = '#e5e7eb';
    g.fillRect(x + 6, 95, 2, 2);
    g.fillStyle = '#ef4444';
    g.fillRect(x + 13, 95, 2, 2);
    g.fillStyle = '#3b82f6';
    g.fillRect(x + 17, 95, 2, 2);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x + 3, 108, 18, 12);
    g.fillStyle = '#fbbf24';
    g.fillRect(x + 10, 111, 4, 3);
  };
  arcade(264, '#312e81', '#ec4899');
  arcade(292, '#0e4f6b', '#22d3ee');

  // Luminária de chão
  g.fillStyle = '#1f1238';
  g.fillRect(346, 66, 2, 58);
  g.fillRect(341, 122, 12, 2);
  g.fillStyle = '#fbbf24';
  g.fillRect(341, 56, 12, 4);
  g.fillStyle = '#fcd34d';
  g.fillRect(339, 60, 16, 8);

  return c;
}

// ---------------------------------------------------------
// Partes animadas do cenário
// ---------------------------------------------------------
function drawTv(g, t, live) {
  const { x, y, w, h } = TV_RECT;
  g.fillStyle = '#0a0614';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#1b1233';
  g.fillRect(x + 2, y + 2, w - 4, h - 4);
  const sx = x + 5;
  const sy = y + 5;
  const sw = w - 10;
  const sh = h - 10;

  g.save();
  g.beginPath();
  g.rect(sx, sy, sw, sh);
  g.clip();
  g.textBaseline = 'top';

  if (live.length) {
    g.fillStyle = '#12091f';
    g.fillRect(sx, sy, sw, sh);
    const cols = ['#7c3aed', '#a855f7', '#ec4899', '#22d3ee', '#10b981', '#f59e0b'];
    const bw = sw / cols.length;
    cols.forEach((c, i) => {
      const hh = sh * (0.3 + 0.28 * Math.abs(Math.sin(t * 2 + i * 1.3)));
      g.fillStyle = c;
      g.fillRect(sx + i * bw, sy + sh - hh, bw - 1, hh);
    });
    g.fillStyle = 'rgba(10,5,24,0.7)';
    g.fillRect(sx, sy, sw, 30);
    g.fillStyle = '#ef4444';
    g.fillRect(sx + 3, sy + 3, 32, 9);
    g.fillStyle = '#fff';
    g.font = 'bold 7px monospace';
    g.textAlign = 'left';
    g.fillText('AO VIVO', sx + 5, sy + 4.5);
    const names = live.slice(0, 2).map((m) => m.username).join(' + ');
    g.font = 'bold 8px monospace';
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.fillText(names.length > 13 ? names.slice(0, 12) + '…' : names, sx + sw / 2, sy + 15);
    g.font = '6px monospace';
    g.fillStyle = '#e9d5ff';
    g.fillText('clique para assistir', sx + sw / 2, sy + 24);
  } else {
    g.fillStyle = '#0b0718';
    g.fillRect(sx, sy, sw, sh);
    g.font = 'bold 10px monospace';
    g.textAlign = 'left';
    g.fillStyle = `hsl(${world.logo.hue},80%,66%)`;
    g.fillText('AZOG', sx + world.logo.x, sy + world.logo.y);
  }

  g.fillStyle = 'rgba(0,0,0,0.14)';
  for (let yy = sy; yy < sy + sh; yy += 2) g.fillRect(sx, yy, sw, 1);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(sx, sy, sw * 0.45, 2);
  g.restore();
}

function drawNeon(g, t) {
  const off = Math.sin(t * 37) > 0.93 && Math.sin(t * 3) > 0.4;
  g.save();
  g.globalAlpha = off ? 0.35 : 1;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 18px monospace';
  g.shadowColor = '#e879f9';
  g.shadowBlur = 6;
  g.fillStyle = '#f5d0fe';
  g.fillText('AZOG', 306, 28);
  g.font = 'bold 8px monospace';
  g.shadowColor = '#22d3ee';
  g.fillStyle = '#a5f3fc';
  g.fillText('S T R E A M', 306, 43);
  g.restore();
}

function drawArcadeScreen(g, x, t, variant) {
  const c = variant ? ['#22d3ee', '#a5f3fc', '#0e7490'] : ['#ec4899', '#fbcfe8', '#fbbf24'];
  g.fillStyle = '#07040f';
  g.fillRect(x + 3, 70, 18, 18);
  g.fillStyle = c[0];
  g.fillRect(x + 4, 72 + Math.floor(Math.sin(t * 2 + variant) * 5 + 5), 2, 5);
  g.fillRect(x + 18, 72 + Math.floor(Math.cos(t * 2.3 + variant) * 5 + 5), 2, 5);
  const bxp = Math.abs(((t * 16 + variant * 7) % 24) - 12);
  const byp = Math.abs(((t * 11 + variant * 5) % 28) - 14);
  g.fillStyle = '#fff';
  g.fillRect(x + 8 + Math.floor(bxp), 72 + Math.floor(byp * 0.85), 2, 2);
  g.fillStyle = c[2];
  for (let yy = 71; yy < 87; yy += 4) g.fillRect(x + 11, yy, 1, 2);
}

function drawWorldFrame(t) {
  const g = world.g;
  const live = liveStreamers();
  g.drawImage(world.bg, 0, 0);

  world.stars.forEach((s) => {
    const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.4 + s.p));
    g.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
    g.fillRect(s.x, s.y, 1, 1);
  });
  if (world.shooting) {
    const s = world.shooting;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(Math.round(s.x), Math.round(s.y), 2, 1);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(Math.round(s.x) - 3, Math.round(s.y) - 1, 3, 1);
  }

  drawTv(g, t, live);
  drawNeon(g, t);
  drawArcadeScreen(g, 264, t, 0);
  drawArcadeScreen(g, 292, t, 1);

  // Brilho quente da luminária
  const glow = g.createRadialGradient(347, 66, 2, 347, 66, 52);
  glow.addColorStop(0, 'rgba(253,224,71,0.24)');
  glow.addColorStop(1, 'rgba(253,224,71,0)');
  g.fillStyle = glow;
  g.fillRect(295, 14, 89, 110);
  const floorGlow = g.createRadialGradient(347, 126, 2, 347, 126, 36);
  floorGlow.addColorStop(0, 'rgba(253,224,71,0.14)');
  floorGlow.addColorStop(1, 'rgba(253,224,71,0)');
  g.fillStyle = floorGlow;
  g.fillRect(300, 120, 84, 70);

  // Pessoas, de trás para frente
  const list = Array.from(world.walkers.values()).sort((a, b) => a.y - b.y);
  list.forEach((w) => {
    const m = state.members.get(w.id);
    const av = sanitizeAvatar(m && m.avatar, m && m.username);
    const sheet = getSpriteSheet(av);
    const px0 = Math.round(w.x);
    const py0 = Math.round(w.y);
    const speaking = typeof voiceIsSpeaking === 'function' && voiceIsSpeaking(w.id);

    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.beginPath();
    g.ellipse(px0, py0, 7, 2.4, 0, 0, Math.PI * 2);
    g.fill();
    if (speaking) {
      g.strokeStyle = 'rgba(16,185,129,0.95)';
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(px0, py0, 10, 3.6, 0, 0, Math.PI * 2);
      g.stroke();
    }

    const frame = w.moving ? (Math.floor(w.walkT * 6) % 2) + 1 : 0;
    g.save();
    g.translate(px0, py0);
    if (w.dir < 0) g.scale(-1, 1);
    g.drawImage(sheet, frame * SPRITE_W, 0, SPRITE_W, SPRITE_H, -8, -SPRITE_H, SPRITE_W, SPRITE_H);
    g.restore();
  });
}

// ---------------------------------------------------------
// Pessoas: criação, caminhada e rede
// ---------------------------------------------------------
function ensureWalker(m) {
  let w = world.walkers.get(m.peerId);
  if (!w) {
    const mine = m.peerId === state.myPeerId;
    const x = mine ? 196 : worldRand(WALK_AREA.x0, WALK_AREA.x1);
    const y = mine ? 176 : worldRand(WALK_AREA.y0, WALK_AREA.y1);
    w = {
      id: m.peerId,
      x,
      y,
      tx: x,
      ty: y,
      sp: 22,
      dir: 1,
      moving: false,
      wasMoving: false,
      walkT: 0,
      idleUntil: performance.now() + worldRand(800, 3000),
      holdMs: 0,
      bubble: '',
      bubbleUntil: 0
    };
    world.walkers.set(m.peerId, w);
  }
  return w;
}

const roundTo1 = (n) => Math.round(n * 10) / 10;

function walkMessage(w) {
  return { type: 'WALK', peerId: w.id, x: roundTo1(w.x), y: roundTo1(w.y), tx: roundTo1(w.tx), ty: roundTo1(w.ty), sp: roundTo1(w.sp) };
}

function pickNewTarget(w) {
  let t = clampWalk(w.x, w.y);
  for (let i = 0; i < 6; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = worldRand(30, 120);
    t = clampWalk(w.x + Math.cos(angle) * dist * 1.4, w.y + Math.sin(angle) * dist * 0.7);
    if (Math.hypot(t.x - w.x, t.y - w.y) > 22) break;
  }
  w.tx = t.x;
  w.ty = t.y;
  w.sp = worldRand(16, 26);
  broadcastData(walkMessage(w));
}

function walkMeTo(x, y) {
  const w = world.walkers.get(state.myPeerId);
  if (!w) return;
  const t = clampWalk(x, y);
  w.tx = t.x;
  w.ty = t.y;
  w.sp = 32;
  w.holdMs = 9000; // depois de ir até onde você mandou, fica um tempo parado
  broadcastData(walkMessage(w));
}

// Mensagem WALK de outra pessoa: só números dentro do chão
function worldOnWalk(data) {
  const m = state.members.get(data.peerId);
  if (!m || data.peerId === state.myPeerId) return;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const x = n(data.x);
  const y = n(data.y);
  const tx = n(data.tx);
  const ty = n(data.ty);
  const sp = n(data.sp);
  if ([x, y, tx, ty].some((v) => v === null)) return;
  const w = ensureWalker(m);
  const a = clampWalk(x, y);
  const b = clampWalk(tx, ty);
  w.x = a.x;
  w.y = a.y;
  w.tx = b.x;
  w.ty = b.y;
  w.sp = sp === null ? 22 : Math.max(8, Math.min(40, sp));
}

// Quem acabou de entrar precisa saber onde eu estou
function worldSendState(conn) {
  const w = world.walkers.get(state.myPeerId);
  if (w && conn && conn.open) conn.send(walkMessage(w));
}

function worldBubble(peerId, text) {
  const m = state.members.get(peerId);
  if (!m) return;
  const w = ensureWalker(m);
  w.bubble = String(text).slice(0, 80);
  w.bubbleUntil = performance.now() + Math.max(3500, 1800 + String(text).length * 70);
}

function updateWorld(dt, now, snap) {
  state.members.forEach((m) => ensureWalker(m));
  world.walkers.forEach((w, id) => {
    if (!state.members.has(id)) {
      world.walkers.delete(id);
      const el = world.labels.get(id);
      if (el) el.root.remove();
      world.labels.delete(id);
    }
  });

  world.walkers.forEach((w) => {
    if (snap) {
      w.x = w.tx;
      w.y = w.ty;
    }
    const dx = w.tx - w.x;
    const dy = w.ty - w.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.8) {
      const step = Math.min(dist, w.sp * dt);
      w.x += (dx / dist) * step;
      w.y += (dy / dist) * step;
      if (Math.abs(dx) > 0.5) w.dir = dx > 0 ? 1 : -1;
      w.moving = true;
      w.wasMoving = true;
      w.walkT += dt;
    } else {
      w.moving = false;
      if (w.wasMoving) {
        w.wasMoving = false;
        w.idleUntil = now + w.holdMs + worldRand(2500, 7000);
        w.holdMs = 0;
      }
      // Só a minha tela decide para onde eu vou; as outras recebem WALK
      if (w.id === state.myPeerId && now >= w.idleUntil) pickNewTarget(w);
    }
  });

  // Efeitos do cenário
  const logo = world.logo;
  logo.x += logo.vx * dt;
  logo.y += logo.vy * dt;
  if (logo.x < 0 || logo.x > 50) {
    logo.vx *= -1;
    logo.x = Math.max(0, Math.min(50, logo.x));
    logo.hue = (logo.hue + 47) % 360;
  }
  if (logo.y < 0 || logo.y > 36) {
    logo.vy *= -1;
    logo.y = Math.max(0, Math.min(36, logo.y));
    logo.hue = (logo.hue + 47) % 360;
  }
  world.clock += dt;
  if (world.shooting) {
    world.shooting.x += 70 * dt;
    world.shooting.y += 24 * dt;
    if (world.shooting.x > 100) world.shooting = null;
  } else if (world.clock > world.nextShooting) {
    world.shooting = { x: 30, y: 20 + Math.random() * 12 };
    world.nextShooting = world.clock + 9 + Math.random() * 14;
  }
}

// ---------------------------------------------------------
// Nomes e balões (HTML por cima do canvas)
// ---------------------------------------------------------
function ensureLabel(id) {
  let l = world.labels.get(id);
  if (l) return l;
  const root = document.createElement('div');
  root.className = 'wlabel';
  root.innerHTML = '<div class="wbubble hidden"></div><div class="wname"><span class="wname-text"></span><span class="wname-badges"></span></div>';
  world.labelsEl.appendChild(root);
  l = {
    root,
    bubble: root.querySelector('.wbubble'),
    nameText: root.querySelector('.wname-text'),
    badges: root.querySelector('.wname-badges'),
    key: ''
  };
  world.labels.set(id, l);
  return l;
}

function updateLabels(now) {
  world.walkers.forEach((w) => {
    const m = state.members.get(w.id);
    if (!m) return;
    const l = ensureLabel(w.id);
    const isMe = w.id === state.myPeerId;
    const speaking = typeof voiceIsSpeaking === 'function' && voiceIsSpeaking(w.id);

    const key = `${m.username}|${isMe}|${m.isStreaming}|${m.hasMic}|${m.micMuted}`;
    if (key !== l.key) {
      l.key = key;
      l.nameText.textContent = m.username + (isMe ? ' (você)' : '');
      l.badges.innerHTML = `${m.isStreaming ? '<span class="wbadge live">LIVE</span>' : ''}${m.hasMic && m.micMuted ? '<span class="wbadge muted" title="Microfone mudo">🔇</span>' : ''}`;
      l.root.classList.toggle('me', isMe);
    }
    l.root.classList.toggle('speaking', speaking);

    const showBubble = now < w.bubbleUntil && w.bubble;
    l.bubble.classList.toggle('hidden', !showBubble);
    if (showBubble && l.bubble.textContent !== w.bubble) l.bubble.textContent = w.bubble;

    l.root.style.left = `${(w.x / WORLD_W) * 100}%`;
    l.root.style.top = `${((w.y - SPRITE_H - 2) / WORLD_H) * 100}%`;
    l.root.style.zIndex = String(Math.round(w.y));
  });
}

// ---------------------------------------------------------
// Laço de animação e tamanho
// ---------------------------------------------------------
function worldLoop(ts) {
  if (!world.active) {
    world.raf = 0;
    return;
  }
  world.raf = requestAnimationFrame(worldLoop);
  // 30 quadros por segundo bastam e poupam a máquina de quem está jogando
  if (ts - world.lastDraw < 32) return;
  world.lastDraw = ts;

  const raw = (ts - world.lastTs) / 1000;
  world.lastTs = ts;
  const dt = Math.min(0.1, raw);
  const now = performance.now();
  updateWorld(dt, now, raw > 1.5); // voltou de uma aba parada: pula direto para os destinos
  drawWorldFrame(ts / 1000);
  updateLabels(now);
}

function resizeWorld() {
  if (!world.stage) return;
  const cw = world.stage.clientWidth;
  const ch = world.stage.clientHeight;
  if (!cw || !ch) return;
  const scale = Math.min(cw / WORLD_W, ch / WORLD_H);
  world.frame.style.width = `${Math.floor(WORLD_W * scale)}px`;
  world.frame.style.height = `${Math.floor(WORLD_H * scale)}px`;
  world.frame.style.setProperty('--ws', String(scale));
}

function worldSetVisible(visible) {
  if (!world.stage) return;
  world.active = Boolean(visible);
  if (world.active) {
    resizeWorld();
    if (!world.raf) {
      world.lastTs = performance.now();
      world.raf = requestAnimationFrame(worldLoop);
    }
  }
}

function initWorld() {
  world.stage = document.getElementById('world-stage');
  world.frame = document.getElementById('world-frame');
  world.canvas = document.getElementById('world-canvas');
  world.labelsEl = document.getElementById('world-labels');
  if (!world.stage || !world.canvas) return;

  world.g = world.canvas.getContext('2d');
  world.g.imageSmoothingEnabled = false;
  world.bg = buildWorldBackground();

  new ResizeObserver(resizeWorld).observe(world.stage);

  world.canvas.addEventListener('click', (e) => {
    const r = world.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * WORLD_W;
    const y = ((e.clientY - r.top) / r.height) * WORLD_H;
    const onTv = x >= TV_RECT.x && x <= TV_RECT.x + TV_RECT.w && y >= TV_RECT.y && y <= TV_RECT.y + TV_RECT.h;
    if (onTv) {
      if (state.screenStreams.size > 0) setLayoutMode('grid');
      return;
    }
    if (y >= WALL_B) walkMeTo(x, y);
  });
}
