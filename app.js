/**
 * GameStream P2P — Motor de Streaming Multi-Telas 60 FPS + Áudio Estéreo
 * Arquitetura Mesh coordenada pelo Host da Sala via PeerJS (WebRTC)
 */

const ROOM_PREFIX = 'gamestream-v1-room-';

// Configura servidores STUN globais ultra-rápidos (Google + Cloudflare) sem IPs mortos que atrasem o ICE
const PEER_CONFIG = {
  debug: 1,
  config: {
    iceCandidatePoolSize: 10,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  }
};

// Estado Global da Aplicação
const state = {
  myPeer: null,
  myPeerId: null,
  myUsername: 'Player',
  roomCode: '',
  isHost: false,
  hostPeerId: '',

  // Mapa de participantes: peerId -> { peerId, username, isStreaming, hasMic }
  members: new Map(),

  // Conexões de Dados (DataConnection): peerId -> conn
  dataConns: new Map(),

  // Chamadas de Vídeo/Tela enviadas por mim: peerId -> MediaConnection
  outgoingScreenCalls: new Map(),

  // Chamadas de Vídeo/Tela recebidas por mim: peerId -> MediaConnection
  incomingScreenCalls: new Map(),

  // Chamadas de Voz enviadas por mim: peerId -> MediaConnection
  outgoingVoiceCalls: new Map(),

  // Streams de Tela ativos (meus e dos amigos): peerId -> MediaStream ou 'embed'
  screenStreams: new Map(),

  // Embeds de PS5 (Twitch/YouTube) ativos na sala: tileId -> { tileId, embedUrl, label, ownerId }
  ps5Embeds: new Map(),

  // Streams locais capturados
  localScreenStream: null,
  localVoiceStream: null,

  // Preferências de UI (gpuSaverSelfPreview = true por padrão para não gastar GPU de quem está jogando)
  layoutMode: 'grid', // 'grid' | 'spotlight'
  spotlightPeerId: null,
  gpuSaverSelfPreview: true,
  statsIntervals: new Map()
};

// =========================================================
// ELEMENTOS DO DOM
// =========================================================
const dom = {
  lobbyScreen: document.getElementById('lobby-screen'),
  appScreen: document.getElementById('app-screen'),
  usernameInput: document.getElementById('username-input'),
  tabCreate: document.getElementById('tab-create'),
  tabJoin: document.getElementById('tab-join'),
  panelCreate: document.getElementById('panel-create'),
  panelJoin: document.getElementById('panel-join'),
  createRoomCode: document.getElementById('create-room-code'),
  joinRoomCode: document.getElementById('join-room-code'),
  btnRegenerateCode: document.getElementById('btn-regenerate-code'),
  btnCreateRoom: document.getElementById('btn-create-room'),
  btnJoinRoom: document.getElementById('btn-join-room'),
  lobbyStatus: document.getElementById('lobby-status'),

  // Topbar
  displayRoomCode: document.getElementById('display-room-code'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  btnCopyLink: document.getElementById('btn-copy-link'),
  selectResolution: document.getElementById('select-resolution'),
  selectFps: document.getElementById('select-fps'),
  selectBitrate: document.getElementById('select-bitrate'),
  selectContentHint: document.getElementById('select-content-hint'),
  btnReconnectStreams: document.getElementById('btn-reconnect-streams'),
  btnLayoutGrid: document.getElementById('btn-layout-grid'),
  btnLayoutSpotlight: document.getElementById('btn-layout-spotlight'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
  peerCountBadge: document.getElementById('peer-count-badge'),

  // Palco e Sidebar
  emptyStage: document.getElementById('empty-stage'),
  btnEmptyStartStream: document.getElementById('btn-empty-start-stream'),
  btnEmptyReconnect: document.getElementById('btn-empty-reconnect'),
  streamsGrid: document.getElementById('streams-grid'),
  roomSidebar: document.getElementById('room-sidebar'),
  membersCount: document.getElementById('members-count'),
  networkRoleBadge: document.getElementById('network-role-badge'),
  membersList: document.getElementById('members-list'),
  chatMessages: document.getElementById('chat-messages'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),

  // Dock Inferior
  btnToggleStream: document.getElementById('btn-toggle-stream'),
  streamBtnLabel: document.getElementById('stream-btn-label'),
  btnToggleMic: document.getElementById('btn-toggle-mic'),
  iconMicOff: document.getElementById('icon-mic-off'),
  iconMicOn: document.getElementById('icon-mic-on'),
  micBtnLabel: document.getElementById('mic-btn-label'),
  btnToggleSelfPreview: document.getElementById('btn-toggle-self-preview'),
  selfPreviewLabel: document.getElementById('self-preview-label'),
  btnLeaveRoom: document.getElementById('btn-leave-room'),

  // Modal PS5 / PSN
  btnOpenPs5Modal: document.getElementById('btn-open-ps5-modal'),
  btnEmptyPs5: document.getElementById('btn-empty-ps5'),
  ps5Modal: document.getElementById('ps5-modal'),
  btnClosePs5Modal: document.getElementById('btn-close-ps5-modal'),
  ps5EmbedForm: document.getElementById('ps5-embed-form'),
  ps5ChannelInput: document.getElementById('ps5-channel-input'),
  selectCaptureDevice: document.getElementById('select-capture-device'),
  btnRefreshDevices: document.getElementById('btn-refresh-devices'),
  btnStartCaptureCard: document.getElementById('btn-start-capture-card'),
  btnPs5Remoteplay: document.getElementById('btn-ps5-remoteplay'),

  // Modal de Diagnóstico
  btnOpenDiagModal: document.getElementById('btn-open-diag-modal'),
  btnEmptyDiag: document.getElementById('btn-empty-diag'),
  diagModal: document.getElementById('diag-modal'),
  btnCloseDiagModal: document.getElementById('btn-close-diag-modal'),
  diagStatusBanner: document.getElementById('diag-status-banner'),
  diagStatusIcon: document.getElementById('diag-status-icon'),
  diagStatusText: document.getElementById('diag-status-text'),
  diagCardsGrid: document.getElementById('diag-cards-grid'),
  diagReportTextarea: document.getElementById('diag-report-textarea'),
  btnRerunDiag: document.getElementById('btn-rerun-diag'),
  btnCopyDiag: document.getElementById('btn-copy-diag'),
  btnSendDiagChat: document.getElementById('btn-send-diag-chat'),

  voiceAudioContainer: document.getElementById('voice-audio-container'),
  toastContainer: document.getElementById('toast-container')
};

// =========================================================
// INICIALIZAÇÃO E UTILITÁRIOS
// =========================================================
function generateRoomCode() {
  const prefixes = ['ARENA', 'SQUAD', 'NEXUS', 'TURBO', 'PIXEL', 'RAID', 'NITRO'];
  const word = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

function sanitizeCode(raw) {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-_]/g, '');
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function setLobbyStatus(msg, isError = false) {
  if (!msg) {
    dom.lobbyStatus.classList.add('hidden');
    return;
  }
  dom.lobbyStatus.textContent = msg;
  dom.lobbyStatus.classList.remove('hidden');
  dom.lobbyStatus.classList.toggle('error', isError);
}

function initLobby() {
  // Carrega apelido salvo se existir
  const savedName = localStorage.getItem('gamestream_username');
  if (savedName) {
    dom.usernameInput.value = savedName;
  } else {
    dom.usernameInput.value = `Player${Math.floor(100 + Math.random() * 899)}`;
  }

  dom.createRoomCode.value = generateRoomCode();

  // Verifica se há código de sala na URL (?room=CODIGO)
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  if (urlRoom) {
    switchLobbyTab('join');
    dom.joinRoomCode.value = sanitizeCode(urlRoom);
  }

  dom.tabCreate.addEventListener('click', () => switchLobbyTab('create'));
  dom.tabJoin.addEventListener('click', () => switchLobbyTab('join'));
  dom.btnRegenerateCode.addEventListener('click', () => {
    dom.createRoomCode.value = generateRoomCode();
  });

  dom.btnCreateRoom.addEventListener('click', () => {
    const code = sanitizeCode(dom.createRoomCode.value);
    if (!code) return setLobbyStatus('Digite um código válido para a sala.', true);
    startSession(code, true);
  });

  dom.btnJoinRoom.addEventListener('click', () => {
    const code = sanitizeCode(dom.joinRoomCode.value);
    if (!code) return setLobbyStatus('Digite o código da sala dos seus amigos.', true);
    startSession(code, false);
  });
}

function switchLobbyTab(tab) {
  const isCreate = tab === 'create';
  dom.tabCreate.classList.toggle('active', isCreate);
  dom.tabJoin.classList.toggle('active', !isCreate);
  dom.panelCreate.classList.toggle('active', isCreate);
  dom.panelJoin.classList.toggle('active', !isCreate);
  setLobbyStatus('');
}

// =========================================================
// CONEXÃO PEERJS & TOPOLOGIA MESH DE SALA
// =========================================================
function startSession(roomCode, asHost) {
  const username = dom.usernameInput.value.trim() || 'Player';
  localStorage.setItem('gamestream_username', username);

  state.myUsername = username;
  state.roomCode = roomCode;
  state.isHost = asHost;
  state.hostPeerId = `${ROOM_PREFIX}${roomCode}`;

  setLobbyStatus(asHost ? 'Criando sala...' : `Conectando à sala ${roomCode}...`);

  // Se for Host, registra o ID determinístico da sala; se for Convidado, gera ID único
  const requestedPeerId = asHost
    ? state.hostPeerId
    : `${ROOM_PREFIX}${roomCode}-peer-${Math.random().toString(36).substring(2, 8)}`;

  const peer = new Peer(requestedPeerId, PEER_CONFIG);
  state.myPeer = peer;

  peer.on('open', (id) => {
    state.myPeerId = id;

    // Registra a si mesmo na lista de membros
    state.members.set(id, {
      peerId: id,
      username: state.myUsername,
      isStreaming: false,
      hasMic: false
    });

    if (asHost) {
      enterRoomUI();
      addSystemMessage(`Sala "${roomCode}" criada! Compartilhe o código ou link com seus amigos.`);
    } else {
      // Conecta ao Host da sala para entrar na malha (Mesh)
      connectToPeer(state.hostPeerId, true);
    }
  });

  peer.on('connection', (conn) => {
    setupDataConnection(conn);
  });

  peer.on('call', (call) => {
    handleIncomingCall(call);
  });

  peer.on('error', (err) => {
    console.error('[PeerJS Error]', err);
    if (err.type === 'unavailable-id' && asHost) {
      setLobbyStatus('Esse código de sala já está em uso! Tente clicar em "Entrar com Código" ou gere outro.', true);
    } else if (err.type === 'peer-unavailable') {
      setLobbyStatus(`Sala "${roomCode}" não encontrada ou o Host já fechou a sala.`, true);
      showToast('Não foi possível encontrar o Host dessa sala.');
    } else {
      setLobbyStatus(`Erro de conexão: ${err.type || err.message}`, true);
    }
  });
}

function connectToPeer(targetPeerId, isInitialHostConn = false) {
  if (targetPeerId === state.myPeerId || state.dataConns.has(targetPeerId)) {
    return;
  }

  const conn = state.myPeer.connect(targetPeerId, {
    reliable: true,
    metadata: {
      username: state.myUsername
    }
  });

  setupDataConnection(conn, isInitialHostConn);
}

function setupDataConnection(conn, isInitialHostConn = false) {
  conn.on('open', () => {
    state.dataConns.set(conn.peer, conn);

    if (isInitialHostConn) {
      enterRoomUI();
      addSystemMessage(`Conectado à sala ${state.roomCode}!`);
    }

    // Envia nossas informações atuais para o peer recém-conectado
    conn.send({
      type: 'HELLO',
      peerId: state.myPeerId,
      username: state.myUsername,
      isStreaming: Boolean(state.localScreenStream),
      hasMic: Boolean(state.localVoiceStream)
    });
  });

  conn.on('data', (data) => {
    handleSignalingData(conn, data);
  });

  conn.on('close', () => {
    handlePeerDisconnect(conn.peer);
  });

  conn.on('error', () => {
    handlePeerDisconnect(conn.peer);
  });
}

function handleSignalingData(conn, data) {
  if (!data || !data.type) return;

  switch (data.type) {
    case 'HELLO': {
      const isNew = !state.members.has(data.peerId);
      state.members.set(data.peerId, {
        peerId: data.peerId,
        username: data.username || 'Amigo',
        isStreaming: Boolean(data.isStreaming),
        hasMic: Boolean(data.hasMic)
      });

      if (isNew) {
        addSystemMessage(`${data.username} entrou na sala.`);
        showToast(`${data.username} entrou na sala`);
      }

      // Se nós estamos transmitindo, enviamos o stream para quem acabou de mandar HELLO (sem duplicar chamadas)
      if (state.localScreenStream) {
        callPeerWithScreen(data.peerId, false);
      }
      if (state.localVoiceStream && !state.outgoingVoiceCalls.has(data.peerId)) {
        callPeerWithVoice(data.peerId);
      }

      // Se o amigo disse que está transmitindo, aguarda 2.5s pela chamada inicial e, se não chegar, solicita ativamente
      if (data.isStreaming && !state.screenStreams.has(data.peerId)) {
        setTimeout(() => {
          if (!state.screenStreams.has(data.peerId) && conn.open) {
            conn.send({ type: 'REQUEST_STREAM', requesterId: state.myPeerId, force: true });
          }
        }, 2500);
      }

      // Se temos embeds de PS5 ativos na sala, sincronizamos com o novo participante
      state.ps5Embeds.forEach((embedInfo) => {
        conn.send({
          type: 'PS5_EMBED_ADD',
          ...embedInfo
        });
      });

      // Se somos o Host, enviamos a lista de todos os membros da sala para que eles se conectem em Mesh
      if (state.isHost) {
        broadcastRoomRoster();
      }
      renderMembersList();
      break;
    }

    case 'REQUEST_STREAM': {
      if (state.localScreenStream && data.requesterId) {
        callPeerWithScreen(data.requesterId, Boolean(data.force));
      }
      if (state.localVoiceStream && data.requesterId) {
        callPeerWithVoice(data.requesterId);
      }
      // Também reenvia embeds PS5 caso existam
      state.ps5Embeds.forEach((embedInfo) => {
        conn.send({
          type: 'PS5_EMBED_ADD',
          ...embedInfo
        });
      });
      break;
    }

    case 'ROOM_ROSTER': {
      // Recebido do Host: garante que nos conectemos diretamente a todos os outros amigos da sala
      if (Array.isArray(data.members)) {
        data.members.forEach((m) => {
          state.members.set(m.peerId, m);
          if (m.peerId !== state.myPeerId && !state.dataConns.has(m.peerId)) {
            connectToPeer(m.peerId, false);
          }
        });
        renderMembersList();
      }
      break;
    }

    case 'MEMBER_STATE': {
      const member = state.members.get(data.peerId);
      if (member) {
        member.isStreaming = Boolean(data.isStreaming);
        member.hasMic = Boolean(data.hasMic);
        if (!member.isStreaming) {
          removeScreenStreamTile(data.peerId);
        }
        renderMembersList();
      }
      break;
    }

    case 'STREAM_STOPPED': {
      removeScreenStreamTile(data.peerId);
      const member = state.members.get(data.peerId);
      if (member) {
        member.isStreaming = false;
        renderMembersList();
      }
      break;
    }

    case 'CHAT': {
      appendChatMessage(data.username, data.text, data.timestamp);
      break;
    }

    case 'PS5_EMBED_ADD': {
      if (data.tileId && data.embedUrl) {
        addPs5EmbedTile(data.tileId, data.embedUrl, data.label, data.ownerId, false);
      }
      break;
    }

    case 'PS5_EMBED_REMOVE': {
      if (data.tileId) {
        removePs5EmbedTile(data.tileId, false);
      }
      break;
    }
  }
}

function broadcastData(payload) {
  state.dataConns.forEach((conn) => {
    if (conn.open) {
      conn.send(payload);
    }
  });
}

function broadcastRoomRoster() {
  const membersArray = Array.from(state.members.values());
  broadcastData({
    type: 'ROOM_ROSTER',
    members: membersArray
  });
}

function broadcastMyState() {
  const me = state.members.get(state.myPeerId);
  if (me) {
    me.isStreaming = Boolean(state.localScreenStream);
    me.hasMic = Boolean(state.localVoiceStream);
  }
  renderMembersList();

  broadcastData({
    type: 'MEMBER_STATE',
    peerId: state.myPeerId,
    isStreaming: Boolean(state.localScreenStream),
    hasMic: Boolean(state.localVoiceStream)
  });
}

function handlePeerDisconnect(peerId) {
  const member = state.members.get(peerId);
  if (member) {
    addSystemMessage(`${member.username} saiu da sala.`);
    state.members.delete(peerId);
  }

  state.dataConns.delete(peerId);
  state.outgoingScreenCalls.delete(peerId);
  state.outgoingVoiceCalls.delete(peerId);

  removeScreenStreamTile(peerId);
  removeVoiceAudioElement(peerId);
  renderMembersList();
}

// =========================================================
// CAPTURA DE JOGO / TELA EM ALTA QUALIDADE (60 FPS + ÁUDIO)
// =========================================================
async function startScreenShare() {
  const resValue = dom.selectResolution.value;
  const fpsValue = parseInt(dom.selectFps.value, 10) || 60;
  const contentHint = dom.selectContentHint.value; // 'motion' para jogos 60fps, 'detail' para nitidez

  const videoConstraints = {
    frameRate: { ideal: fpsValue, max: fpsValue },
    cursor: 'always'
  };

  if (resValue !== 'native') {
    const height = parseInt(resValue, 10);
    const width = Math.round((height * 16) / 9);
    videoConstraints.width = { ideal: width, max: width };
    videoConstraints.height = { ideal: height, max: height };
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: {
        // Desativa filtros de voz humana para que o áudio do jogo saia puro, estéreo e com graves/agudos fieis
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000
      },
      systemAudio: 'include'
    });

    // Configura dica de codificação na faixa de vídeo (prioriza 60 FPS constantes em jogos)
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = contentHint === 'detail' ? 'detail' : 'motion';
    }

    // Detecta quando o usuário clica em "Parar compartilhamento" na barra nativa do navegador
    videoTrack.addEventListener('ended', () => {
      stopScreenShare();
    });

    state.localScreenStream = stream;

    // Exibe nosso próprio stream na grade
    addOrUpdateScreenStreamTile(state.myPeerId, stream, true);

    // Envia nosso stream para todos os amigos conectados
    state.dataConns.forEach((_, peerId) => {
      callPeerWithScreen(peerId, true);
    });

    updateStreamControlsUI(true);
    broadcastMyState();
    const hasAudio = stream.getAudioTracks().length > 0;
    showToast(
      hasAudio
        ? `Transmitindo em ${fpsValue} FPS com Áudio do Jogo!`
        : `Transmitindo em ${fpsValue} FPS (Sem áudio marcado na janela)`
    );
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error('Erro ao capturar tela:', err);
      showToast('Não foi possível iniciar a captura de tela.');
    }
  }
}

function stopScreenShare() {
  if (!state.localScreenStream) return;

  state.localScreenStream.getTracks().forEach((t) => t.stop());
  state.localScreenStream = null;

  // Fecha chamadas de vídeo enviadas
  state.outgoingScreenCalls.forEach((call) => call.close());
  state.outgoingScreenCalls.clear();

  removeScreenStreamTile(state.myPeerId);
  updateStreamControlsUI(false);

  broadcastData({
    type: 'STREAM_STOPPED',
    peerId: state.myPeerId
  });
  broadcastMyState();
  showToast('Transmissão encerrada.');
}

function callPeerWithScreen(targetPeerId, force = false) {
  if (!state.localScreenStream || !state.myPeer) return;

  const existingCall = state.outgoingScreenCalls.get(targetPeerId);
  if (existingCall) {
    // Evita chamadas duplicadas simultâneas que derrubam a negociação WebRTC
    if (!force && existingCall._createdAt && Date.now() - existingCall._createdAt < 4000) {
      return;
    }
    try {
      existingCall.close();
    } catch (_) {}
    state.outgoingScreenCalls.delete(targetPeerId);
  }

  const useHardwareH264 = dom.selectContentHint.value === 'motion';
  const callOptions = {
    metadata: {
      streamType: 'screen',
      username: state.myUsername
    }
  };

  if (useHardwareH264) {
    callOptions.sdpTransform = (sdp) => preferHardwareH264Codec(sdp);
  }

  const call = state.myPeer.call(targetPeerId, state.localScreenStream, callOptions);

  if (!call) return;
  call._createdAt = Date.now();
  state.outgoingScreenCalls.set(targetPeerId, call);

  // Aplica o Bitrate quando a conexão estiver estabelecida ou após 800ms
  setTimeout(() => {
    applyHighBitrateToCall(call);
  }, 800);
}

/**
 * Reordena os codecs de vídeo no SDP do WebRTC para priorizar H.264 (acelerado por hardware na GPU)
 * quando selecionado pelo usuário, mantendo VP8/VP9 como fallback.
 */
function preferHardwareH264Codec(sdp) {
  try {
    const lines = sdp.split('\r\n');
    const mLineIndex = lines.findIndex((line) => line.startsWith('m=video'));
    if (mLineIndex === -1) return sdp;

    const h264Payloads = [];
    const rtxMap = new Map();

    for (const line of lines) {
      const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
      if (rtpmapMatch) {
        h264Payloads.push(rtpmapMatch[1]);
      }
      const fmtpRtxMatch = line.match(/^a=fmtp:(\d+)\s+apt=(\d+)/i);
      if (fmtpRtxMatch) {
        rtxMap.set(fmtpRtxMatch[2], fmtpRtxMatch[1]);
      }
    }

    if (h264Payloads.length === 0) return sdp;

    const preferredPayloads = [];
    h264Payloads.forEach((pt) => {
      preferredPayloads.push(pt);
      if (rtxMap.has(pt)) {
        preferredPayloads.push(rtxMap.get(pt));
      }
    });

    const mElements = lines[mLineIndex].split(' ');
    const header = mElements.slice(0, 3);
    const existingPayloads = mElements.slice(3);
    const remainingPayloads = existingPayloads.filter((pt) => !preferredPayloads.includes(pt));

    lines[mLineIndex] = [...header, ...preferredPayloads, ...remainingPayloads].join(' ');
    return lines.join('\r\n');
  } catch (e) {
    return sdp;
  }
}

/**
 * Ajusta dinamicamente o bitrate e framerate de forma segura em qualquer navegador.
 */
async function applyHighBitrateToCall(call) {
  try {
    const pc = call.peerConnection;
    if (!pc) return;

    const activePeersCount = Math.max(1, state.outgoingScreenCalls.size);
    const baseBitrate = parseInt(dom.selectBitrate.value, 10) || 4500000;
    const targetVideoBitrate =
      activePeersCount > 2 ? Math.max(2000000, Math.round(baseBitrate * 0.75)) : baseBitrate;

    const senders = pc.getSenders();

    for (const sender of senders) {
      if (!sender.track) continue;

      if (sender.track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = targetVideoBitrate;
        params.encodings[0].maxFramerate = parseInt(dom.selectFps.value, 10) || 60;
        params.degradationPreference =
          dom.selectContentHint.value === 'detail' ? 'maintain-resolution' : 'balanced';
        await sender.setParameters(params);
      } else if (sender.track.kind === 'audio') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 160000;
        await sender.setParameters(params);
      }
    }
  } catch (e) {
    console.warn('Aviso ao ajustar parâmetros de bitrate:', e);
  }
}

// Atualiza bitrate ou hint em tempo real se o usuário mudar os seletores durante a live
function updateLiveStreamParameters() {
  if (!state.localScreenStream) return;
  const videoTrack = state.localScreenStream.getVideoTracks()[0];
  if (videoTrack && 'contentHint' in videoTrack) {
    videoTrack.contentHint = dom.selectContentHint.value === 'detail' ? 'detail' : 'motion';
  }
  state.outgoingScreenCalls.forEach((call) => {
    applyHighBitrateToCall(call);
  });
  showToast('Parâmetros de transmissão atualizados!');
}

// =========================================================
// MICROFONE / CHAT DE VOZ P2P
// =========================================================
async function toggleMicrophone() {
  if (state.localVoiceStream) {
    state.localVoiceStream.getTracks().forEach((t) => t.stop());
    state.localVoiceStream = null;
    state.outgoingVoiceCalls.forEach((c) => c.close());
    state.outgoingVoiceCalls.clear();
    updateMicControlsUI(false);
    broadcastMyState();
    showToast('Microfone desativado.');
    return;
  }

  try {
    const voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    state.localVoiceStream = voiceStream;
    state.dataConns.forEach((_, peerId) => {
      callPeerWithVoice(peerId);
    });

    updateMicControlsUI(true);
    broadcastMyState();
    showToast('Microfone ativado!');
  } catch (err) {
    console.error('Erro ao acessar microfone:', err);
    showToast('Permissão de microfone negada ou dispositivo indisponível.');
  }
}

function callPeerWithVoice(targetPeerId) {
  if (!state.localVoiceStream || !state.myPeer) return;
  const call = state.myPeer.call(targetPeerId, state.localVoiceStream, {
    metadata: {
      streamType: 'voice',
      username: state.myUsername
    }
  });
  if (call) {
    state.outgoingVoiceCalls.set(targetPeerId, call);
  }
}

// =========================================================
// RECEBIMENTO DE STREAMS (TELA E VOZ DOS AMIGOS)
// =========================================================
function handleIncomingCall(call) {
  const streamType = call.metadata?.streamType || 'screen';

  if (streamType === 'screen') {
    state.incomingScreenCalls.set(call.peer, call);
  }

  const fallbackMediaStream = new MediaStream();
  let streamHandled = false;

  const onReceiveStream = (remoteStream) => {
    if (!remoteStream) return;
    if (streamHandled && streamType === 'voice') return;
    streamHandled = true;
    if (streamType === 'voice') {
      attachVoiceStream(call.peer, remoteStream);
    } else {
      addOrUpdateScreenStreamTile(call.peer, remoteStream, false, call);
    }
  };

  // IMPORTANTE: Registrar listener 'stream' ANTES de call.answer() para não perder o evento inicial
  call.on('stream', onReceiveStream);

  call.answer(); // Responde à chamada

  if (call.peerConnection) {
    call.peerConnection.addEventListener('track', (event) => {
      if (event.streams && event.streams[0]) {
        onReceiveStream(event.streams[0]);
      } else if (event.track) {
        fallbackMediaStream.addTrack(event.track);
        onReceiveStream(fallbackMediaStream);
      }
    });

    // Monitora falhas de rede/NAT para tentar reconexão automática do vídeo
    call.peerConnection.addEventListener('iceconnectionstatechange', () => {
      const iceState = call.peerConnection?.iceConnectionState;
      if (streamType === 'screen' && (iceState === 'failed' || iceState === 'disconnected')) {
        const conn = state.dataConns.get(call.peer);
        if (conn && conn.open && state.incomingScreenCalls.get(call.peer) === call) {
          showToast('Sinal de vídeo oscilou, reconectando automaticamente...');
          conn.send({ type: 'REQUEST_STREAM', requesterId: state.myPeerId, force: true });
        }
      }
    });
  }

  call.on('close', () => {
    if (streamType === 'voice') {
      removeVoiceAudioElement(call.peer);
    } else {
      // Só remove o bloco de vídeo se esta chamada ainda for a chamada ativa daquele peer
      if (state.incomingScreenCalls.get(call.peer) === call) {
        state.incomingScreenCalls.delete(call.peer);
        removeScreenStreamTile(call.peer);
      }
    }
  });

  call.on('error', (err) => {
    console.error('[Call Error]', err);
  });
}

function attachVoiceStream(peerId, stream) {
  let audioEl = document.getElementById(`voice-audio-${peerId}`);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = `voice-audio-${peerId}`;
    audioEl.autoplay = true;
    dom.voiceAudioContainer.appendChild(audioEl);
  }
  audioEl.srcObject = remoteStreamOrClone(stream);
}

function removeVoiceAudioElement(peerId) {
  const el = document.getElementById(`voice-audio-${peerId}`);
  if (el) el.remove();
}

function remoteStreamOrClone(stream) {
  return stream;
}

// =========================================================
// INTERFACE DE MÚLTIPLOS STREAMS (GRADE & SPOTLIGHT)
// =========================================================
function addOrUpdateScreenStreamTile(peerId, stream, isLocal, mediaCall = null) {
  state.screenStreams.set(peerId, stream);

  const member = state.members.get(peerId);
  const displayName = isLocal
    ? `${state.myUsername} (Você)`
    : member?.username || callMetadataName(mediaCall) || 'Amigo';

  let tile = document.getElementById(`stream-tile-${peerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `stream-tile-${peerId}`;
    tile.className = 'stream-tile';
    tile.dataset.peerId = peerId;

    tile.innerHTML = `
      <div class="tile-header">
        <div class="streamer-tag">
          <span class="live-pill">LIVE</span>
          <span class="streamer-name"></span>
        </div>
        <div class="stream-stats-badge" id="stats-${peerId}">60 FPS • HD</div>
      </div>

      <video class="stream-video" id="video-${peerId}" autoplay playsinline></video>

      <div class="gpu-saver-overlay hidden" id="gpu-overlay-${peerId}">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <path d="M8 21h8"></path>
          <path d="M12 17v4"></path>
        </svg>
        <span>Pré-visualização pausada (Economia de GPU ativa para o seu jogo)</span>
      </div>

      <div class="tile-controls">
        <div class="volume-group">
          <button class="tile-btn btn-mute-toggle" type="button" title="Mutar/Desmutar stream">🔊</button>
          <input type="range" class="volume-slider" min="0" max="1" step="0.02" value="1" title="Volume do Stream" />
        </div>
        <div class="tile-actions">
          <button class="tile-btn btn-focus-tile" type="button" title="Destacar esta tela">
            <span>Destacar</span>
          </button>
          <button class="tile-btn btn-pip-tile" type="button" title="Janela Flutuante (Picture-in-Picture)">
            <span>PiP</span>
          </button>
          <button class="tile-btn btn-fullscreen-tile" type="button" title="Tela Cheia">
            <span>Tela Cheia</span>
          </button>
        </div>
      </div>
    `;

    dom.streamsGrid.appendChild(tile);
    bindTileEvents(tile, peerId, isLocal);
  }

  tile.querySelector('.streamer-name').textContent = displayName;

  const videoEl = tile.querySelector(`#video-${peerId}`);
  videoEl.srcObject = stream;

  // Sempre muta o próprio preview local para não dar eco infinito no próprio PC
  if (isLocal) {
    videoEl.muted = true;
    const volGroup = tile.querySelector('.volume-group');
    if (volGroup) volGroup.classList.add('hidden');

    // Por padrão ativa a Economia de GPU para quem está transmitindo não renderizar o próprio vídeo 60fps duas vezes
    const myOverlay = tile.querySelector(`#gpu-overlay-${peerId}`);
    if (state.gpuSaverSelfPreview && myOverlay) {
      videoEl.pause();
      videoEl.srcObject = null; // Desacopla o decodificador local completamente para zero uso de GPU no navegador
      myOverlay.classList.remove('hidden');
      dom.selfPreviewLabel.textContent = 'Eco de GPU: Ativado (+FPS)';
    } else {
      videoEl.play().catch(() => {});
    }
  } else {
    videoEl.muted = false;
    const playPromise = videoEl.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Se o navegador bloquear autoplay com som, inicia mutado para o vídeo aparecer imediatamente
        videoEl.muted = true;
        videoEl.play().catch(() => {});
        const muteBtn = tile.querySelector('.btn-mute-toggle');
        if (muteBtn) muteBtn.textContent = '🔇';
        showToast('Vídeo iniciado sem som (clique em 🔇 no vídeo para ativar o áudio).');
      });
    }
  }

  // Inicia monitoramento de resolução e FPS reais do vídeo
  startVideoStatsMonitor(peerId, videoEl);

  // Se for o primeiro stream na sala e estivermos no modo spotlight, destaca ele
  if (!state.spotlightPeerId) {
    state.spotlightPeerId = peerId;
  }

  refreshStageVisibility();
}

function callMetadataName(mediaCall) {
  return mediaCall?.metadata?.username;
}

function bindTileEvents(tile, peerId, isLocal) {
  const videoEl = tile.querySelector(`#video-${peerId}`);
  const muteBtn = tile.querySelector('.btn-mute-toggle');
  const volSlider = tile.querySelector('.volume-slider');
  const focusBtn = tile.querySelector('.btn-focus-tile');
  const pipBtn = tile.querySelector('.btn-pip-tile');
  const fsBtn = tile.querySelector('.btn-fullscreen-tile');

  if (!isLocal && muteBtn && volSlider) {
    muteBtn.addEventListener('click', () => {
      videoEl.muted = !videoEl.muted;
      muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
      volSlider.value = videoEl.muted ? 0 : videoEl.volume || 1;
    });

    volSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      videoEl.volume = val;
      videoEl.muted = val === 0;
      muteBtn.textContent = val === 0 ? '🔇' : '🔊';
    });
  }

  focusBtn.addEventListener('click', () => {
    if (state.layoutMode === 'spotlight' && state.spotlightPeerId === peerId) {
      setLayoutMode('grid');
    } else {
      state.spotlightPeerId = peerId;
      setLayoutMode('spotlight');
    }
  });

  // Duplo clique no vídeo alterna Tela Cheia
  videoEl.addEventListener('dblclick', () => {
    toggleFullscreen(tile);
  });

  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (videoEl.requestPictureInPicture) {
        await videoEl.requestPictureInPicture();
      }
    } catch (e) {
      showToast('Picture-in-Picture não disponível neste navegador.');
    }
  });

  fsBtn.addEventListener('click', () => {
    toggleFullscreen(tile);
  });
}

function toggleFullscreen(element) {
  if (!document.fullscreenElement) {
    element.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function startVideoStatsMonitor(peerId, videoEl) {
  if (state.statsIntervals.has(peerId)) {
    clearInterval(state.statsIntervals.get(peerId));
  }

  let lastFrames = 0;
  let lastTime = performance.now();

  const intervalId = setInterval(() => {
    const badge = document.getElementById(`stats-${peerId}`);
    if (!badge || !videoEl) return;

    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;

    let fpsText = '';
    if (typeof videoEl.getVideoPlaybackQuality === 'function') {
      const quality = videoEl.getVideoPlaybackQuality();
      const now = performance.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed > 0 && lastFrames > 0) {
        const currentFps = Math.round((quality.totalVideoFrames - lastFrames) / elapsed);
        if (currentFps > 0 && currentFps <= 144) {
          fpsText = ` • ${currentFps} FPS`;
        }
      }
      lastFrames = quality.totalVideoFrames;
      lastTime = now;
    }

    if (w && h) {
      badge.textContent = `${h}p${fpsText}`;
    }
  }, 1500);

  state.statsIntervals.set(peerId, intervalId);
}

function removeScreenStreamTile(peerId) {
  state.screenStreams.delete(peerId);

  if (state.statsIntervals.has(peerId)) {
    clearInterval(state.statsIntervals.get(peerId));
    state.statsIntervals.delete(peerId);
  }

  const tile = document.getElementById(`stream-tile-${peerId}`);
  if (tile) {
    tile.remove();
  }

  if (state.spotlightPeerId === peerId) {
    const remainingKeys = Array.from(state.screenStreams.keys());
    state.spotlightPeerId = remainingKeys.length > 0 ? remainingKeys[0] : null;
  }

  refreshStageVisibility();
}

function refreshStageVisibility() {
  const count = state.screenStreams.size;
  dom.emptyStage.classList.toggle('hidden', count > 0);
  dom.streamsGrid.classList.toggle('hidden', count === 0);

  // Atualiza destaque se estivermos no modo spotlight
  const tiles = dom.streamsGrid.querySelectorAll('.stream-tile');
  tiles.forEach((tile) => {
    const isSpot = state.layoutMode === 'spotlight' && tile.dataset.peerId === state.spotlightPeerId;
    tile.classList.toggle('spotlight-active', isSpot);
    const focusBtn = tile.querySelector('.btn-focus-tile span');
    if (focusBtn) {
      focusBtn.textContent = isSpot ? 'Grade' : 'Destacar';
    }
  });
}

function setLayoutMode(mode) {
  state.layoutMode = mode;
  dom.streamsGrid.classList.toggle('mode-grid', mode === 'grid');
  dom.streamsGrid.classList.toggle('mode-spotlight', mode === 'spotlight');
  dom.btnLayoutGrid.classList.toggle('active', mode === 'grid');
  dom.btnLayoutSpotlight.classList.toggle('active', mode === 'spotlight');

  if (mode === 'spotlight' && !state.spotlightPeerId && state.screenStreams.size > 0) {
    state.spotlightPeerId = Array.from(state.screenStreams.keys())[0];
  }
  refreshStageVisibility();
}

// =========================================================
// UI DA SALA, MEMBROS E CHAT
// =========================================================
function enterRoomUI() {
  dom.lobbyScreen.classList.add('hidden');
  dom.appScreen.classList.remove('hidden');
  dom.displayRoomCode.textContent = state.roomCode;
  dom.networkRoleBadge.textContent = state.isHost ? 'Host da Sala' : 'Convidado';

  // Em telas menores/celulares, inicia com a barra lateral recolhida para focar no vídeo
  if (window.innerWidth <= 900) {
    dom.roomSidebar.classList.add('hidden');
  }

  // Atualiza URL sem recarregar para facilitar compartilhamento
  const newUrl = `${window.location.pathname}?room=${encodeURIComponent(state.roomCode)}`;
  window.history.replaceState({}, '', newUrl);

  renderMembersList();
}

function renderMembersList() {
  dom.membersList.innerHTML = '';
  const total = state.members.size;
  dom.membersCount.textContent = total;
  dom.peerCountBadge.textContent = total;

  state.members.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'member-item';

    const initials = (m.username || 'P').slice(0, 2).toUpperCase();
    const isMe = m.peerId === state.myPeerId;

    li.innerHTML = `
      <div class="member-info">
        <div class="member-avatar">${initials}</div>
        <span class="member-name">${escapeHtml(m.username)}${isMe ? ' (Você)' : ''}</span>
      </div>
      <div class="member-badges">
        ${m.hasMic ? '<span title="Microfone Ativo">🎙️</span>' : ''}
        ${m.isStreaming ? '<span class="badge-streaming">LIVE</span>' : ''}
      </div>
    `;
    dom.membersList.appendChild(li);
  });
}

function appendChatMessage(author, text, timestamp) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const timeStr = new Date(timestamp || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  div.innerHTML = `
    <span class="chat-msg-time">${timeStr}</span>
    <span class="chat-msg-author">${escapeHtml(author)}:</span>
    <span class="chat-msg-text">${escapeHtml(text)}</span>
  `;
  dom.chatMessages.appendChild(div);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  dom.chatMessages.appendChild(div);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateStreamControlsUI(isStreaming) {
  dom.btnToggleStream.classList.toggle('active-stream', isStreaming);
  dom.streamBtnLabel.textContent = isStreaming
    ? 'Parar Transmissão'
    : 'Transmitir Meu Jogo / Tela';

  dom.btnToggleSelfPreview.classList.toggle('hidden', !isStreaming);
  if (!isStreaming) {
    state.gpuSaverSelfPreview = true;
    dom.selfPreviewLabel.textContent = 'Eco de GPU: Ativado (+FPS)';
  }
}

function updateMicControlsUI(isActive) {
  dom.btnToggleMic.classList.toggle('mic-active', isActive);
  dom.iconMicOff.classList.toggle('hidden', isActive);
  dom.iconMicOn.classList.toggle('hidden', !isActive);
  dom.micBtnLabel.textContent = isActive ? 'Mic Ativo' : 'Mic Desativado';
}

// =========================================================
// EVENTOS GERAIS DA SALA
// =========================================================
function bindRoomEvents() {
  dom.btnCopyCode.addEventListener('click', () => {
    navigator.clipboard.writeText(state.roomCode);
    showToast(`Código "${state.roomCode}" copiado!`);
  });

  dom.btnCopyLink.addEventListener('click', () => {
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(state.roomCode)}`;
    navigator.clipboard.writeText(inviteUrl);
    showToast('Link direto da sala copiado!');
  });

  dom.btnToggleStream.addEventListener('click', () => {
    if (state.localScreenStream) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  });

  dom.btnEmptyStartStream.addEventListener('click', () => {
    startScreenShare();
  });

  const handleManualReconnect = () => {
    requestAllActiveStreams();
  };

  if (dom.btnReconnectStreams) {
    dom.btnReconnectStreams.addEventListener('click', handleManualReconnect);
  }
  if (dom.btnEmptyReconnect) {
    dom.btnEmptyReconnect.addEventListener('click', handleManualReconnect);
  }

  dom.btnToggleMic.addEventListener('click', () => {
    toggleMicrophone();
  });

  // Desliga/liga completamente o decodificador local para poupar GPU e não perder FPS no jogo
  dom.btnToggleSelfPreview.addEventListener('click', () => {
    if (!state.localScreenStream) return;
    state.gpuSaverSelfPreview = !state.gpuSaverSelfPreview;

    const myVideo = document.getElementById(`video-${state.myPeerId}`);
    const myOverlay = document.getElementById(`gpu-overlay-${state.myPeerId}`);

    if (myVideo && myOverlay) {
      if (state.gpuSaverSelfPreview) {
        myVideo.pause();
        myVideo.srcObject = null;
        myOverlay.classList.remove('hidden');
        dom.selfPreviewLabel.textContent = 'Eco de GPU: Ativado (+FPS)';
      } else {
        myVideo.srcObject = state.localScreenStream;
        myVideo.play().catch(() => {});
        myOverlay.classList.add('hidden');
        dom.selfPreviewLabel.textContent = 'Eco de GPU: Desligado';
      }
    }
  });

  dom.btnLayoutGrid.addEventListener('click', () => setLayoutMode('grid'));
  dom.btnLayoutSpotlight.addEventListener('click', () => setLayoutMode('spotlight'));

  dom.btnToggleSidebar.addEventListener('click', () => {
    dom.roomSidebar.classList.toggle('hidden');
  });

  dom.selectBitrate.addEventListener('change', updateLiveStreamParameters);
  dom.selectContentHint.addEventListener('change', updateLiveStreamParameters);

  dom.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dom.chatInput.value.trim();
    if (!text) return;
    dom.chatInput.value = '';

    const timestamp = Date.now();
    appendChatMessage(state.myUsername, text, timestamp);
    broadcastData({
      type: 'CHAT',
      username: state.myUsername,
      text,
      timestamp
    });
  });

  dom.btnLeaveRoom.addEventListener('click', () => {
    stopScreenShare();
    if (state.localVoiceStream) {
      state.localVoiceStream.getTracks().forEach((t) => t.stop());
    }
    if (state.myPeer) {
      state.myPeer.destroy();
    }
    window.location.href = window.location.pathname;
  });

  // Eventos do Modal PS5 / PSN
  const openPs5Modal = () => {
    dom.ps5Modal.classList.remove('hidden');
    populateCaptureDevices();
  };

  if (dom.btnOpenPs5Modal) {
    dom.btnOpenPs5Modal.addEventListener('click', openPs5Modal);
  }
  if (dom.btnEmptyPs5) {
    dom.btnEmptyPs5.addEventListener('click', openPs5Modal);
  }
  if (dom.btnClosePs5Modal) {
    dom.btnClosePs5Modal.addEventListener('click', () => {
      dom.ps5Modal.classList.add('hidden');
    });
  }
  if (dom.ps5Modal) {
    dom.ps5Modal.addEventListener('click', (e) => {
      if (e.target === dom.ps5Modal) dom.ps5Modal.classList.add('hidden');
    });
  }

  if (dom.ps5EmbedForm) {
    dom.ps5EmbedForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawInput = dom.ps5ChannelInput.value.trim();
      if (!rawInput) return;

      const parsed = parsePs5StreamInput(rawInput);
      if (!parsed) {
        showToast('Digite um canal da Twitch ou link válido do YouTube / Twitch.');
        return;
      }

      const tileId = `ps5-${state.myPeerId}-${Date.now().toString().slice(-4)}`;
      const label = `${state.myUsername} • PS5 (${parsed.platform})`;

      addPs5EmbedTile(tileId, parsed.embedUrl, label, state.myPeerId, true);
      dom.ps5ChannelInput.value = '';
      dom.ps5Modal.classList.add('hidden');
      showToast(`Stream do PS5 (${parsed.platform}) adicionado na sala para todos!`);
    });
  }

  if (dom.btnRefreshDevices) {
    dom.btnRefreshDevices.addEventListener('click', () => {
      populateCaptureDevices(true);
    });
  }

  if (dom.btnStartCaptureCard) {
    dom.btnStartCaptureCard.addEventListener('click', () => {
      startPs5CaptureCardStream();
    });
  }

  if (dom.btnPs5Remoteplay) {
    dom.btnPs5Remoteplay.addEventListener('click', () => {
      dom.ps5Modal.classList.add('hidden');
      startScreenShare();
    });
  }

  // Eventos do Modal de Diagnóstico
  const openAndRunDiag = () => {
    if (!dom.diagModal) return;
    dom.diagModal.classList.remove('hidden');
    runNetworkAndVideoDiagnostics(true);
  };

  if (dom.btnOpenDiagModal) {
    dom.btnOpenDiagModal.addEventListener('click', openAndRunDiag);
  }
  if (dom.btnEmptyDiag) {
    dom.btnEmptyDiag.addEventListener('click', openAndRunDiag);
  }
  if (dom.btnCloseDiagModal) {
    dom.btnCloseDiagModal.addEventListener('click', () => {
      dom.diagModal.classList.add('hidden');
    });
  }
  if (dom.diagModal) {
    dom.diagModal.addEventListener('click', (e) => {
      if (e.target === dom.diagModal) dom.diagModal.classList.add('hidden');
    });
  }
  if (dom.btnRerunDiag) {
    dom.btnRerunDiag.addEventListener('click', () => {
      runNetworkAndVideoDiagnostics(true);
    });
  }
  if (dom.btnCopyDiag) {
    dom.btnCopyDiag.addEventListener('click', () => {
      if (dom.diagReportTextarea) {
        navigator.clipboard.writeText(dom.diagReportTextarea.value);
        showToast('Relatório de diagnóstico copiado!');
      }
    });
  }
  if (dom.btnSendDiagChat) {
    dom.btnSendDiagChat.addEventListener('click', () => {
      if (dom.diagReportTextarea && dom.diagReportTextarea.value) {
        sendDiagSummaryToChat(dom.diagReportTextarea.value);
        showToast('Diagnóstico enviado no Chat da Sala!');
      }
    });
  }
}

// =========================================================
// SISTEMA DE DIAGNÓSTICO DE REDE, CGNAT, GPU E VÍDEO
// =========================================================
function sendDiagSummaryToChat(summaryText) {
  const cleanMsg = `🩺 [Diagnóstico]: ${summaryText.replace(/\n+/g, ' | ')}`;
  const timestamp = Date.now();
  appendChatMessage(state.myUsername, cleanMsg, timestamp);
  broadcastData({
    type: 'CHAT',
    username: state.myUsername,
    text: cleanMsg,
    timestamp
  });
}

function getGpuAndBrowserInfo() {
  let gpu = 'Desconhecida';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } else {
      gpu = 'WebGL Desativado (Sem Aceleração Gráfica)';
    }
  } catch (_) {}

  let codecs = [];
  try {
    if (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
      const caps = RTCRtpReceiver.getCapabilities('video');
      if (caps && caps.codecs) {
        const set = new Set();
        caps.codecs.forEach((c) => {
          const name = (c.mimeType || '').split('/')[1];
          if (name && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(name.toLowerCase())) {
            set.add(name.toUpperCase());
          }
        });
        codecs = Array.from(set);
      }
    }
  } catch (_) {}

  const isSoftwareGpu = /swiftshader|basic render|llvmpipe|software/i.test(gpu);
  return {
    gpu,
    isSoftwareGpu,
    codecs: codecs.length ? codecs : ['VP8', 'H264']
  };
}

async function probeWebRtcNatAndUdp() {
  return new Promise((resolve) => {
    const result = {
      hostCount: 0,
      srflxCount: 0,
      externalPorts: new Set(),
      externalIps: new Set(),
      error: null
    };

    let pc = null;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        if (pc) pc.close();
      } catch (_) {}
      resolve({
        hostCount: result.hostCount,
        srflxCount: result.srflxCount,
        externalPortsCount: result.externalPorts.size,
        isSymmetricNat: result.externalPorts.size > 1,
        hasUdpInternet: result.srflxCount > 0,
        error: result.error
      });
    };

    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ]
      });

      pc.createDataChannel('diag-probe');

      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          finish();
          return;
        }
        const cand = e.candidate.candidate || '';
        if (cand.includes('typ host')) {
          result.hostCount++;
        } else if (cand.includes('typ srflx')) {
          result.srflxCount++;
          const parts = cand.trim().split(/\s+/);
          // candidate:foundation component protocol priority ip port typ srflx ...
          if (parts.length >= 6) {
            result.externalIps.add(parts[4]);
            result.externalPorts.add(parts[5]);
          }
        }
      };

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch((err) => {
          result.error = err.message;
          finish();
        });

      setTimeout(finish, 2600);
    } catch (err) {
      result.error = err.message;
      finish();
    }
  });
}

async function inspectActiveVideoStreams() {
  const reports = [];

  for (const [peerId, call] of state.incomingScreenCalls.entries()) {
    const member = state.members.get(peerId);
    const name = member ? member.username : peerId.slice(0, 8);
    const pc = call.peerConnection;
    if (!pc) {
      reports.push({ peer: name, dir: 'Recebendo', ice: 'sem-pc', bytes: 0, frames: 0 });
      continue;
    }

    let bytesReceived = 0;
    let framesDecoded = 0;
    let packetsLost = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
          bytesReceived += s.bytesReceived || 0;
          framesDecoded += s.framesDecoded || 0;
          packetsLost += s.packetsLost || 0;
        }
      });
    } catch (_) {}

    reports.push({
      peer: name,
      dir: 'Recebendo',
      ice: pc.iceConnectionState || 'unknown',
      bytes: bytesReceived,
      frames: framesDecoded,
      lost: packetsLost
    });
  }

  for (const [peerId, call] of state.outgoingScreenCalls.entries()) {
    const member = state.members.get(peerId);
    const name = member ? member.username : peerId.slice(0, 8);
    const pc = call.peerConnection;
    if (!pc) continue;

    let bytesSent = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
          bytesSent += s.bytesSent || 0;
        }
      });
    } catch (_) {}

    reports.push({
      peer: name,
      dir: 'Enviando',
      ice: pc.iceConnectionState || 'unknown',
      bytes: bytesSent,
      frames: 0,
      lost: 0
    });
  }

  return reports;
}

async function runNetworkAndVideoDiagnostics(autoSendChat = true) {
  if (!dom.diagStatusBanner || !dom.diagCardsGrid) return;

  dom.diagStatusBanner.className = 'diag-status-banner running';
  dom.diagStatusIcon.textContent = '⏳';
  dom.diagStatusText.textContent = 'Testando portas UDP, tipo de NAT/CGNAT, GPU e fluxo de vídeo (aguarde ~2s)...';
  dom.diagCardsGrid.innerHTML = '';
  if (dom.diagReportTextarea) {
    dom.diagReportTextarea.value = 'Executando testes na máquina...';
  }

  // 1. Estado da Sinalização e Sala
  const peerOpen = !!(state.myPeer && !state.myPeer.disconnected && !state.myPeer.destroyed);
  let openConns = 0;
  state.dataConns.forEach((c) => {
    if (c && c.open) openConns++;
  });

  // 2. GPU e Codecs
  const hwInfo = getGpuAndBrowserInfo();

  // 3. Teste de Rede UDP / STUN / NAT Simétrico
  const natProbe = await probeWebRtcNatAndUdp();

  // 4. Inspecionar chamadas de vídeo ativas
  const streamReports = await inspectActiveVideoStreams();

  // Montar cartões visuais
  const cards = [];
  let overallLevel = 'ok'; // 'ok' | 'warn' | 'error'
  let mainDiagnosis = 'Conexão e navegador operando normalmente!';

  // Card 1: Sinalização e Sala
  if (peerOpen && (openConns > 0 || state.isHost)) {
    cards.push({
      title: '1. Conexão com a Sala',
      status: 'ok',
      badge: 'ONLINE',
      value: `${openConns} amigo(s) conectado(s)`,
      hint: `Papel: ${state.isHost ? 'Host' : 'Convidado'} • Canal de dados e chat funcionando.`
    });
  } else {
    overallLevel = 'error';
    mainDiagnosis = 'Sem conexão de dados com o Host da sala. Verifique o código da sala ou aperte Ctrl+F5.';
    cards.push({
      title: '1. Conexão com a Sala',
      status: 'error',
      badge: 'SEM CONEXÃO',
      value: peerOpen ? '0 amigos conectados' : 'Servidor desconectado',
      hint: 'O canal de controle não abriu com o Host. Verifique Firewall ou recarregue com Ctrl+F5.'
    });
  }

  // Card 2: Rede UDP & CGNAT da Operadora
  if (!natProbe.hasUdpInternet) {
    overallLevel = 'error';
    mainDiagnosis = 'Porta UDP bloqueada no PC/Roteador! Firewall, Antivírus ou VPN está bloqueando vídeo WebRTC.';
    cards.push({
      title: '2. Rede UDP / Operadora',
      status: 'error',
      badge: 'UDP BLOQUEADO',
      value: 'Sem saída UDP (0 respostas STUN)',
      hint: 'Firewall do Windows (Rede Pública), Antivírus ou VPN corporativa bloqueou portas UDP.'
    });
  } else if (natProbe.isSymmetricNat) {
    if (overallLevel === 'ok') overallLevel = 'warn';
    mainDiagnosis = 'Sua operadora usa CGNAT Restrito (NAT Simétrico), que pode bloquear conexão direta entre casas.';
    cards.push({
      title: '2. Rede UDP / Operadora',
      status: 'warn',
      badge: 'CGNAT RESTRITO',
      value: 'NAT Simétrico Detectado',
      hint: 'Sua operadora muda a porta a cada conexão. Dica: Ligar o app gratuito Cloudflare WARP (1.1.1.1) libera na hora!'
    });
  } else {
    cards.push({
      title: '2. Rede UDP / Operadora',
      status: 'ok',
      badge: 'UDP ABERTO',
      value: `NAT Compatível (${natProbe.srflxCount} rotas STUN)`,
      hint: 'Portas UDP abertas e prontas para conexão direta de vídeo.'
    });
  }

  // Card 3: Placa de Vídeo (GPU) & Codecs
  const hasVp8 = hwInfo.codecs.includes('VP8');
  if (hwInfo.isSoftwareGpu) {
    if (overallLevel === 'ok') overallLevel = 'warn';
    cards.push({
      title: '3. Placa de Vídeo & Codecs',
      status: 'warn',
      badge: 'MODO SOFTWARE',
      value: `Codecs: ${hwInfo.codecs.slice(0, 3).join(', ')}`,
      hint: `Aceleração de hardware desligada (${hwInfo.gpu.slice(0, 38)}). Use o modo "Compatível (Todos PCs)".`
    });
  } else {
    cards.push({
      title: '3. Placa de Vídeo & Codecs',
      status: hasVp8 ? 'ok' : 'warn',
      badge: 'GPU OK',
      value: `Codecs: ${hwInfo.codecs.slice(0, 4).join(', ')}`,
      hint: `GPU: ${hwInfo.gpu.slice(0, 48)}`
    });
  }

  // Card 4: Fluxo de Vídeo da Live
  if (streamReports.length === 0) {
    const someoneStreaming = Array.from(state.members.values()).some((m) => m.isStreaming && m.peerId !== state.myPeerId);
    if (someoneStreaming) {
      overallLevel = 'warn';
      mainDiagnosis = 'Há alguém transmitindo na sala, mas a chamada de vídeo ainda não chegou. Clique em "🔄 Reconectar Live".';
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'warn',
        badge: 'AGUARDANDO',
        value: 'Chamada não iniciada',
        hint: 'Um amigo está em live mas o canal de vídeo não abriu. Clique em "🔄 Reconectar Live".'
      });
    } else {
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'ok',
        badge: 'PARADO',
        value: 'Ninguém transmitindo agora',
        hint: 'Assim que alguém iniciar a live, o fluxo de pacotes aparecerá aqui.'
      });
    }
  } else {
    const r = streamReports[0];
    const kb = Math.round(r.bytes / 1024);
    if (r.ice === 'failed' || r.ice === 'disconnected') {
      overallLevel = 'error';
      mainDiagnosis = `Conexão de vídeo com ${r.peer} falhou (${r.ice}) por bloqueio de roteador/CGNAT entre as duas redes!`;
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'error',
        badge: `ICE: ${r.ice.toUpperCase()}`,
        value: `${r.dir} (${r.peer}): ${kb} KB`,
        hint: 'O roteador/operadora barrou a conexão direta. Teste ligar o Cloudflare WARP (1.1.1.1) ou mudar rede para Privada.'
      });
    } else if (r.dir === 'Recebendo' && r.bytes > 0 && r.frames === 0) {
      overallLevel = 'error';
      mainDiagnosis = `O vídeo de ${r.peer} está chegando (${kb} KB), mas a placa de vídeo não decodificou! Mude o Encoder para "Compatível (Todos PCs)".`;
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'error',
        badge: 'ERRO CODEC',
        value: `${kb} KB recebidos / 0 quadros`,
        hint: 'Pacotes chegam mas a GPU não decodificou. Peça para quem transmite selecionar "Compatível (Todos PCs)".'
      });
    } else if (r.bytes === 0) {
      if (overallLevel === 'ok') overallLevel = 'warn';
      mainDiagnosis = `Chamada com ${r.peer} em estado "${r.ice}", mas com 0 KB trafegados até agora.`;
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'warn',
        badge: `ICE: ${r.ice.toUpperCase()}`,
        value: `0 KB recebidos de ${r.peer}`,
        hint: 'Negociando rota de vídeo ou bloqueado por Firewall/CGNAT.'
      });
    } else {
      cards.push({
        title: '4. Recepção de Vídeo (Live)',
        status: 'ok',
        badge: 'RECEBENDO OK',
        value: `${r.dir} (${r.peer}): ${kb} KB`,
        hint: `ICE: ${r.ice} • Quadros decodificados: ${r.frames} • Perda: ${r.lost} pcts`
      });
    }
  }

  // Atualizar Banner Principal
  dom.diagStatusBanner.className = `diag-status-banner ${overallLevel}`;
  dom.diagStatusIcon.textContent = overallLevel === 'ok' ? '✅' : overallLevel === 'warn' ? '⚠️' : '❌';
  dom.diagStatusText.textContent = mainDiagnosis;

  // Renderizar Cards
  dom.diagCardsGrid.innerHTML = cards
    .map(
      (c) => `
      <div class="diag-card">
        <div class="diag-card-header">
          <span>${c.title}</span>
          <span class="diag-pill ${c.status}">${c.badge}</span>
        </div>
        <div class="diag-card-value">${c.value}</div>
        <div class="diag-card-hint">${c.hint}</div>
      </div>
    `
    )
    .join('');

  // Montar texto resumo técnico
  const streamSummary =
    streamReports.length > 0
      ? streamReports.map((s) => `${s.dir}(${s.peer}): ICE=${s.ice}, ${Math.round(s.bytes / 1024)}KB, frames=${s.frames}`).join('; ')
      : 'Sem chamadas de vídeo ativas';

  const reportLines = [
    `Resultado: ${mainDiagnosis}`,
    `Sala: ${state.roomCode || 'N/A'} (${state.isHost ? 'Host' : 'Convidado'}, ${openConns} peers conectados)`,
    `Rede UDP: ${natProbe.hasUdpInternet ? (natProbe.isSymmetricNat ? 'CGNAT Restrito / NAT Simétrico' : 'UDP Aberto OK') : 'BLOQUEADO (0 STUN)'} (host=${natProbe.hostCount}, srflx=${natProbe.srflxCount})`,
    `GPU/Codecs: [${hwInfo.codecs.slice(0, 4).join(',')}] - ${hwInfo.gpu.slice(0, 45)}`,
    `Vídeo: ${streamSummary}`
  ];

  const fullReport = reportLines.join('\n');
  if (dom.diagReportTextarea) {
    dom.diagReportTextarea.value = fullReport;
  }

  // Enviar automaticamente no chat da sala se estiver conectado a alguém
  if (autoSendChat && openConns > 0) {
    sendDiagSummaryToChat(fullReport);
  }
}

// Solicita ativamente que todos os participantes transmitindo reenviem seus streams de vídeo/áudio
function requestAllActiveStreams() {
  let requestedCount = 0;

  state.dataConns.forEach((conn, peerId) => {
    if (conn && conn.open) {
      conn.send({
        type: 'REQUEST_STREAM',
        requesterId: state.myPeerId,
        force: true
      });
      requestedCount++;
    }
  });

  // Se nós mesmos estivermos transmitindo, também reforça o envio para todos na sala
  if (state.localScreenStream) {
    state.dataConns.forEach((_, peerId) => {
      callPeerWithScreen(peerId, true);
    });
  }

  if (requestedCount > 0) {
    showToast('Sincronizando e reconectando transmissões da sala...');
  } else {
    showToast('Aguardando outros participantes na sala para sincronizar.');
  }
}

// =========================================================
// INTEGRAÇÃO PS5 / PSN (TWITCH, YOUTUBE & PLACA DE CAPTURA)
// =========================================================
function parsePs5StreamInput(input) {
  const host = window.location.hostname || 'localhost';

  // Verifica se é link do YouTube (watch?v=, live/, youtu.be/)
  const ytMatch = input.match(
    /(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (ytMatch) {
    return {
      platform: 'YouTube',
      embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1&playsinline=1`
    };
  }

  // Verifica se é URL da Twitch (twitch.tv/canal)
  const twitchUrlMatch = input.match(/twitch\.tv\/([a-zA-Z0-9_]{2,30})/i);
  if (twitchUrlMatch) {
    const channel = twitchUrlMatch[1];
    return {
      platform: 'Twitch',
      embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(host)}&autoplay=true`
    };
  }

  // Se digitou apenas o @canal ou nome do canal da Twitch diretamente
  const cleanChannel = input.replace(/^@/, '').trim();
  if (/^[a-zA-Z0-9_]{2,30}$/.test(cleanChannel)) {
    return {
      platform: 'Twitch',
      embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(cleanChannel)}&parent=${encodeURIComponent(host)}&autoplay=true`
    };
  }

  return null;
}

function addPs5EmbedTile(tileId, embedUrl, label, ownerId, broadcast = false) {
  // Garante que se for embed da Twitch, o parâmetro parent= corresponda ao domínio atual de quem está assistindo
  let finalEmbedUrl = embedUrl;
  try {
    const currentHost = window.location.hostname || 'localhost';
    if (finalEmbedUrl.includes('player.twitch.tv')) {
      const urlObj = new URL(finalEmbedUrl);
      urlObj.searchParams.set('parent', currentHost);
      finalEmbedUrl = urlObj.toString();
    }
  } catch (_) {}

  state.ps5Embeds.set(tileId, { tileId, embedUrl: finalEmbedUrl, label, ownerId });
  state.screenStreams.set(tileId, 'embed');

  let tile = document.getElementById(`stream-tile-${tileId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `stream-tile-${tileId}`;
    tile.className = 'stream-tile';
    tile.dataset.peerId = tileId;

    tile.innerHTML = `
      <div class="tile-header">
        <div class="streamer-tag">
          <span class="live-pill">PS5 LIVE</span>
          <span class="streamer-name"></span>
        </div>
        <div class="stream-stats-badge">PSN • Console</div>
      </div>

      <iframe
        class="stream-iframe"
        src="${finalEmbedUrl}"
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        allowfullscreen
      ></iframe>

      <div class="tile-controls">
        <div class="volume-group">
          <span style="font-size: 0.72rem; color: #9ca3af;">Controle de som no player acima</span>
        </div>
        <div class="tile-actions">
          <button class="tile-btn btn-focus-tile" type="button">
            <span>Destacar</span>
          </button>
          <button class="tile-btn btn-fullscreen-tile" type="button">
            <span>Tela Cheia</span>
          </button>
          <button class="tile-btn btn-close-embed" type="button" title="Remover tela PS5 da sala">
            <span>✕ Fechar</span>
          </button>
        </div>
      </div>
    `;

    dom.streamsGrid.appendChild(tile);

    const focusBtn = tile.querySelector('.btn-focus-tile');
    const fsBtn = tile.querySelector('.btn-fullscreen-tile');
    const closeBtn = tile.querySelector('.btn-close-embed');

    focusBtn.addEventListener('click', () => {
      if (state.layoutMode === 'spotlight' && state.spotlightPeerId === tileId) {
        setLayoutMode('grid');
      } else {
        state.spotlightPeerId = tileId;
        setLayoutMode('spotlight');
      }
    });

    fsBtn.addEventListener('click', () => {
      toggleFullscreen(tile);
    });

    closeBtn.addEventListener('click', () => {
      removePs5EmbedTile(tileId, true);
    });
  }

  tile.querySelector('.streamer-name').textContent = label || 'PS5 Stream';

  if (!state.spotlightPeerId) {
    state.spotlightPeerId = tileId;
  }

  refreshStageVisibility();

  if (broadcast) {
    broadcastData({
      type: 'PS5_EMBED_ADD',
      tileId,
      embedUrl,
      label,
      ownerId
    });
  }
}

function removePs5EmbedTile(tileId, broadcast = false) {
  state.ps5Embeds.delete(tileId);
  removeScreenStreamTile(tileId);

  if (broadcast) {
    broadcastData({
      type: 'PS5_EMBED_REMOVE',
      tileId
    });
  }
}

async function populateCaptureDevices(requestPermission = false) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    if (requestPermission) {
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((d) => d.kind === 'videoinput');

    dom.selectCaptureDevice.innerHTML = '';
    if (videoDevices.length === 0) {
      dom.selectCaptureDevice.innerHTML = '<option value="">Nenhum dispositivo de vídeo USB encontrado</option>';
      return;
    }

    videoDevices.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Dispositivo de Captura / Vídeo #${idx + 1}`;
      dom.selectCaptureDevice.appendChild(opt);
    });
  } catch (err) {
    showToast('Permita o acesso à câmera/dispositivo para listar a Placa de Captura HDMI.');
  }
}

async function startPs5CaptureCardStream() {
  const deviceId = dom.selectCaptureDevice.value;
  const fpsValue = parseInt(dom.selectFps.value, 10) || 60;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: fpsValue, max: 60 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    if (state.localScreenStream) {
      stopScreenShare();
    }

    state.localScreenStream = stream;
    addOrUpdateScreenStreamTile(state.myPeerId, stream, true);

    state.dataConns.forEach((_, peerId) => {
      callPeerWithScreen(peerId);
    });

    updateStreamControlsUI(true);
    broadcastMyState();
    dom.ps5Modal.classList.add('hidden');
    showToast('Transmitindo PS5 via Placa de Captura HDMI em 60 FPS!');
  } catch (err) {
    console.error('Erro ao iniciar Placa de Captura:', err);
    showToast('Não foi possível abrir o dispositivo de captura selecionado.');
  }
}

// Inicializa tudo ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
  initLobby();
  bindRoomEvents();
});