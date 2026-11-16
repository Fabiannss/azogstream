/**
 * AzogStream — Avatares em pixel art
 * Os sprites são desenhados por código (sem imagens), então qualquer combinação
 * de pele, cabelo, roupa e acessório funciona e cabe numa mensagem minúscula.
 *
 * Um avatar é só cinco números: { s: pele, h: estilo de cabelo, hc: cor do cabelo, c: roupa, a: acessório }.
 */

const AVATAR_KEY = 'azogstream_avatar';

const AV = {
  skin: ['#f5d0b0', '#e8b48a', '#c98d62', '#9a6540', '#6e4529', '#fbe3d0'],
  hairColor: ['#1b1b1b', '#5a3a1e', '#c9a24b', '#d9482b', '#6d3bd1', '#2e8bd8', '#e85fb0', '#e6e6e6'],
  shirt: ['#9333ea', '#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6', '#e5e7eb', '#111827', '#f97316'],
  hairStyles: ['Curto', 'Comprido', 'Espetado', 'Moicano', 'Careca'],
  accessories: ['Nenhum', 'Boné', 'Fone', 'Coroa', 'Orelhas', 'Óculos', 'Faixa']
};

const AV_LIMITS = { s: AV.skin.length, h: AV.hairStyles.length, hc: AV.hairColor.length, c: AV.shirt.length, a: AV.accessories.length };

function avatarHash(str) {
  let h = 2166136261;
  const s = String(str || 'P');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function defaultAvatarFor(name) {
  const h = avatarHash(name);
  return { s: h % 6, h: (h >>> 3) % 5, hc: (h >>> 6) % 8, c: (h >>> 9) % 10, a: (h >>> 12) % 7 };
}

// Tudo que vem da rede passa por aqui: só números inteiros dentro da faixa
function sanitizeAvatar(av, name) {
  const base = defaultAvatarFor(name);
  if (!av || typeof av !== 'object') return base;
  const out = {};
  Object.keys(AV_LIMITS).forEach((k) => {
    const v = Number(av[k]);
    out[k] = Number.isInteger(v) && v >= 0 && v < AV_LIMITS[k] ? v : base[k];
  });
  return out;
}

function loadSavedAvatar() {
  try {
    const raw = localStorage.getItem(AVATAR_KEY);
    return raw ? sanitizeAvatar(JSON.parse(raw), '') : null;
  } catch (err) {
    return null;
  }
}

function saveMyAvatar(av) {
  try {
    localStorage.setItem(AVATAR_KEY, JSON.stringify(av));
  } catch (err) {
    /* vale só nesta sessão */
  }
}

function avatarKey(av) {
  return `${av.s}-${av.h}-${av.hc}-${av.c}-${av.a}`;
}

// ---------------------------------------------------------
// Sprite: 3 quadros (parado, passo A, passo B) de 16x24 pixels, virado para a direita
// ---------------------------------------------------------
const SPRITE_W = 16;
const SPRITE_H = 24;
const spriteCache = new Map();

function px(g, color, x, y, w = 1, h = 1) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

function paintFrame(g, ox, frame, av) {
  const skin = AV.skin[av.s];
  const hair = AV.hairColor[av.hc];
  const shirt = AV.shirt[av.c];
  const accent = AV.shirt[(av.c + 4) % AV.shirt.length];
  const pants = '#2b2a4a';
  const shoe = '#ece9f7';
  const ink = '#1a1228';
  const X = (x) => ox + x;

  const liftL = frame === 1 ? 1 : 0;
  const liftR = frame === 2 ? 1 : 0;
  const swing = frame === 1 ? 1 : frame === 2 ? -1 : 0;

  // Cabelo comprido fica atrás do corpo
  if (av.h === 1) px(g, hair, X(4), 3, 2, 8);

  // Pernas e sapatos
  px(g, pants, X(5), 17, 2, 5 - liftL);
  px(g, shoe, X(5), 22 - liftL, 3, 2);
  px(g, pants, X(9), 17, 2, 5 - liftR);
  px(g, shoe, X(9), 22 - liftR, 3, 2);

  // Braço de trás (mais escuro), tronco, braço da frente
  px(g, shirt, X(3), 10 + swing, 1, 5);
  px(g, 'rgba(0,0,0,0.25)', X(3), 10 + swing, 1, 5);
  px(g, skin, X(3), 15 + swing, 1, 1);
  px(g, shirt, X(4), 9, 8, 7);
  px(g, 'rgba(255,255,255,0.12)', X(4), 9, 8, 1);
  px(g, pants, X(4), 16, 8, 1);
  px(g, shirt, X(12), 10 - swing, 1, 5);
  px(g, skin, X(12), 15 - swing, 1, 1);

  // Cabeça e rosto
  px(g, skin, X(5), 3, 6, 6);
  px(g, 'rgba(0,0,0,0.12)', X(5), 8, 6, 1);
  px(g, ink, X(7), 6, 1, 1);
  px(g, ink, X(9), 6, 1, 1);
  px(g, 'rgba(0,0,0,0.28)', X(8), 8, 2, 1);

  // Cabelo
  if (av.h !== 4) {
    px(g, hair, X(5), 2, 6, 2);
    px(g, hair, X(5), 4, 1, 2);
  }
  if (av.h === 2) {
    [5, 7, 9].forEach((x) => px(g, hair, X(x), 1, 1, 1));
    [6, 8].forEach((x) => px(g, hair, X(x), 0, 1, 1));
  }
  if (av.h === 3) {
    px(g, hair, X(7), 0, 2, 3);
    px(g, skin, X(5), 2, 2, 1);
    px(g, skin, X(9), 2, 2, 1);
  }

  // Acessórios
  switch (av.a) {
    case 1: // boné
      px(g, accent, X(5), 1, 6, 3);
      px(g, accent, X(10), 3, 4, 1);
      px(g, 'rgba(0,0,0,0.2)', X(10), 3, 4, 1);
      break;
    case 2: // fone
      px(g, accent, X(5), 1, 6, 1);
      px(g, accent, X(5), 1, 1, 3);
      px(g, accent, X(10), 1, 1, 3);
      px(g, accent, X(3), 4, 2, 4);
      px(g, accent, X(11), 4, 2, 4);
      px(g, 'rgba(0,0,0,0.25)', X(3), 4, 1, 4);
      break;
    case 3: // coroa
      px(g, '#fbbf24', X(5), 1, 6, 1);
      [5, 7, 9].forEach((x) => px(g, '#fbbf24', X(x), 0, 1, 1));
      px(g, '#ef4444', X(7), 1, 1, 1);
      break;
    case 4: // orelhas de gato
      px(g, hair, X(5), 1, 2, 2);
      px(g, hair, X(9), 1, 2, 2);
      px(g, hair, X(5), 0, 1, 1);
      px(g, hair, X(10), 0, 1, 1);
      px(g, '#f9a8d4', X(6), 2, 1, 1);
      px(g, '#f9a8d4', X(9), 2, 1, 1);
      break;
    case 5: // óculos
      px(g, '#0f0f1a', X(6), 5, 5, 1);
      px(g, '#0f0f1a', X(6), 7, 2, 1);
      px(g, '#0f0f1a', X(9), 7, 2, 1);
      px(g, '#0f0f1a', X(6), 6, 1, 1);
      px(g, '#0f0f1a', X(8), 6, 1, 1);
      px(g, '#0f0f1a', X(10), 6, 1, 1);
      break;
    case 6: // faixa
      px(g, '#ef4444', X(5), 3, 6, 1);
      px(g, '#ef4444', X(4), 3, 1, 3);
      break;
    default:
      break;
  }
}

// Folha de sprites já pronta para o canvas do mundo: [parado | passo A | passo B]
function getSpriteSheet(av) {
  const key = avatarKey(av);
  let sheet = spriteCache.get(key);
  if (sheet) return sheet;
  sheet = document.createElement('canvas');
  sheet.width = SPRITE_W * 3;
  sheet.height = SPRITE_H;
  const g = sheet.getContext('2d');
  for (let f = 0; f < 3; f++) paintFrame(g, f * SPRITE_W, f, av);
  if (spriteCache.size > 60) spriteCache.clear();
  spriteCache.set(key, sheet);
  return sheet;
}

// Rosto (cabeça e ombros) como imagem, para a lista de membros e o painel do usuário
const headCache = new Map();
function avatarHeadUrl(av) {
  const key = avatarKey(av);
  let url = headCache.get(key);
  if (url) return url;
  const c = document.createElement('canvas');
  c.width = 12;
  c.height = 12;
  c.getContext('2d').drawImage(getSpriteSheet(av), 2, 0, 12, 12, 0, 0, 12, 12);
  url = c.toDataURL();
  if (headCache.size > 60) headCache.clear();
  headCache.set(key, url);
  return url;
}

// Desenha um quadro num canvas pequeno (prévia do lobby e do editor)
function drawAvatarPreview(canvas, av, frame = 0) {
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(getSpriteSheet(av), frame * SPRITE_W, 0, SPRITE_W, SPRITE_H, 0, 0, SPRITE_W, SPRITE_H);
}

// ---------------------------------------------------------
// Editor de avatar (modal)
// ---------------------------------------------------------
const avatarEditor = { draft: null, onSave: null, timer: 0, frame: 0 };

function currentAvatar() {
  return (state.myAvatar && sanitizeAvatar(state.myAvatar, state.myUsername)) || loadSavedAvatar() || defaultAvatarFor('');
}

function randomAvatar() {
  const out = {};
  Object.keys(AV_LIMITS).forEach((k) => {
    out[k] = Math.floor(Math.random() * AV_LIMITS[k]);
  });
  return out;
}

function buildAvatarEditor() {
  const card = document.getElementById('avatar-modal-card');
  const swatches = (key, colors) =>
    colors
      .map((c, i) => `<button type="button" class="av-swatch" data-key="${key}" data-val="${i}" style="background:${c}" title="${i + 1}"></button>`)
      .join('');
  const options = (key, labels) =>
    labels.map((l, i) => `<button type="button" class="av-opt" data-key="${key}" data-val="${i}">${l}</button>`).join('');

  card.innerHTML = `
    <div class="modal-header">
      <div class="modal-title-group">
        <div class="settings-badge-icon">🧑‍🎤</div>
        <div>
          <h3>Seu avatar</h3>
          <p>É ele que anda pela praça da sala</p>
        </div>
      </div>
      <button id="btn-close-avatar" class="icon-btn" type="button" title="Fechar">✕</button>
    </div>
    <div class="av-layout">
      <div class="av-preview-col">
        <div class="av-preview-stage"><canvas id="avatar-preview" width="16" height="24"></canvas></div>
        <button id="btn-avatar-random" class="chip-btn big" type="button">🎲 Aleatório</button>
      </div>
      <div class="av-controls">
        <div class="av-row"><span class="av-label">Pele</span><div class="av-choices">${swatches('s', AV.skin)}</div></div>
        <div class="av-row"><span class="av-label">Cabelo</span><div class="av-choices">${options('h', AV.hairStyles)}</div></div>
        <div class="av-row"><span class="av-label">Cor do cabelo</span><div class="av-choices">${swatches('hc', AV.hairColor)}</div></div>
        <div class="av-row"><span class="av-label">Roupa</span><div class="av-choices">${swatches('c', AV.shirt)}</div></div>
        <div class="av-row"><span class="av-label">Acessório</span><div class="av-choices">${options('a', AV.accessories)}</div></div>
      </div>
    </div>
    <div class="av-actions">
      <button id="btn-avatar-save" class="primary-btn" type="button">Salvar avatar</button>
    </div>
  `;

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    avatarEditor.draft[btn.dataset.key] = Number(btn.dataset.val);
    refreshAvatarEditor();
  });
  document.getElementById('btn-avatar-random').addEventListener('click', () => {
    avatarEditor.draft = randomAvatar();
    refreshAvatarEditor();
  });
  document.getElementById('btn-close-avatar').addEventListener('click', closeAvatarEditor);
  document.getElementById('btn-avatar-save').addEventListener('click', () => {
    const av = sanitizeAvatar(avatarEditor.draft, state.myUsername);
    const cb = avatarEditor.onSave;
    closeAvatarEditor();
    if (cb) cb(av);
  });
}

function refreshAvatarEditor() {
  const card = document.getElementById('avatar-modal-card');
  card.querySelectorAll('[data-key]').forEach((el) => {
    el.classList.toggle('active', avatarEditor.draft[el.dataset.key] === Number(el.dataset.val));
  });
  drawAvatarPreview(document.getElementById('avatar-preview'), avatarEditor.draft, avatarEditor.frame);
}

function openAvatarEditor(onSave) {
  avatarEditor.draft = { ...currentAvatar() };
  avatarEditor.onSave = onSave;
  avatarEditor.frame = 0;
  document.getElementById('avatar-modal').classList.remove('hidden');
  refreshAvatarEditor();
  // A prévia anda no lugar para dar para ver os pés e os braços
  clearInterval(avatarEditor.timer);
  const seq = [0, 1, 0, 2];
  let i = 0;
  avatarEditor.timer = setInterval(() => {
    i = (i + 1) % seq.length;
    avatarEditor.frame = seq[i];
    drawAvatarPreview(document.getElementById('avatar-preview'), avatarEditor.draft, avatarEditor.frame);
  }, 220);
}

function closeAvatarEditor() {
  clearInterval(avatarEditor.timer);
  document.getElementById('avatar-modal').classList.add('hidden');
}

// Aplica um avatar novo: guarda, atualiza minha ficha e avisa a sala
function applyMyAvatar(av) {
  state.myAvatar = av;
  saveMyAvatar(av);
  const me = state.members.get(state.myPeerId);
  if (me) me.avatar = av;
  updateLobbyAvatarPreview();
  if (state.myPeerId) {
    updateUserPanelAvatar();
    broadcastData({ type: 'AVATAR', peerId: state.myPeerId, avatar: av });
    renderMembersList();
  }
}

function updateLobbyAvatarPreview() {
  const canvas = document.getElementById('lobby-avatar-canvas');
  if (canvas) drawAvatarPreview(canvas, currentAvatar(), 0);
}

function initAvatar() {
  buildAvatarEditor();

  const modal = document.getElementById('avatar-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeAvatarEditor();
  });

  // Antes de entrar numa sala, o avatar vem do navegador (ou do apelido, se for a primeira vez)
  if (!state.myAvatar) {
    state.myAvatar = loadSavedAvatar() || defaultAvatarFor(dom.usernameInput.value || '');
  }
  updateLobbyAvatarPreview();

  const lobbyBtn = document.getElementById('btn-lobby-avatar');
  if (lobbyBtn) lobbyBtn.addEventListener('click', () => openAvatarEditor(applyMyAvatar));
  if (dom.userPanelAvatar) {
    dom.userPanelAvatar.title = 'Clique para editar seu avatar';
    dom.userPanelAvatar.addEventListener('click', () => openAvatarEditor(applyMyAvatar));
  }
}
