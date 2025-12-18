const socket = io("https://bugats-dambrete-server.onrender.com");

const connEl = document.getElementById("dz-connection-status");
const nickInput = document.getElementById("dz-nickname");
const connectBtn = document.getElementById("dz-connect-btn");
const createRoomBtn = document.getElementById("dz-create-room-btn");
const lobbyListEl = document.getElementById("dz-lobby-list");
const yourInfoEl = document.getElementById("dz-your-info");

const roomTitleEl = document.getElementById("dz-room-title");
const leaveRoomBtn = document.getElementById("dz-leave-room-btn");
const statusEl = document.getElementById("dz-status");
const boardEl = document.getElementById("dz-board");

const SIZE = 8;

const state = {
  connected: false,
  nickname: null,
  yourColor: null,
  roomId: null,
  board: [],
  currentPlayer: null,
  mustContinueJump: false,
  forceFrom: null,
  gameOver: false,
  selected: null,
  validMoves: [],
};

socket.on("connect", () => {
  setConnectionUi(true);
  const nickname = state.nickname || nickInput.value || "Spēlētājs";
  socket.emit("joinLobby", { nickname });
});

socket.on("disconnect", () => {
  setConnectionUi(false);
  resetRoomState();
});

socket.on("lobbyState", (payload) => {
  renderLobby(payload);
});

socket.on("roomJoined", (data) => {
  const { room, yourColor } = data;
  state.roomId = room.id;
  state.yourColor = yourColor;
  syncRoomState(room);
  roomTitleEl.textContent = `Istaba ${room.id}`;
  leaveRoomBtn.disabled = false;
  renderYourInfo();
});

socket.on("roomState", (room) => {
  if (!state.roomId || state.roomId !== room.id) return;
  syncRoomState(room);
});

socket.on("leftRoom", () => {
  resetRoomState();
});

socket.on("errorMessage", (payload) => {
  if (payload && payload.message) {
    statusEl.textContent = payload.message;
  }
});

socket.on("invalidMove", (payload) => {
  const reason = payload && payload.reason;
  if (reason === "notYourTurn") return;
  statusEl.textContent = "Nederīgs gājiens.";
});

function setConnectionUi(online) {
  state.connected = online;
  if (online) {
    connEl.textContent = "Online";
    connEl.classList.add("dz-online");
    connectBtn.disabled = true;
    createRoomBtn.disabled = false;
  } else {
    connEl.textContent = "Atvienots";
    connEl.classList.remove("dz-online");
    connectBtn.disabled = false;
    createRoomBtn.disabled = true;
  }
}

function renderYourInfo() {
  if (!state.nickname) {
    yourInfoEl.textContent = "";
    return;
  }
  const colorText =
    state.yourColor === "b"
      ? "Tu spēlē ar melnajiem (augšā)."
      : state.yourColor === "w"
      ? "Tu spēlē ar baltajiem (apakšā)."
      : "Tu vēl neesi istabā.";
  yourInfoEl.textContent = `${state.nickname} – ${colorText}`;
}

function renderLobby(lobby) {
  lobbyListEl.innerHTML = "";
  if (!lobby || !lobby.rooms || lobby.rooms.length === 0) {
    lobbyListEl.textContent = "Pašlaik nav nevienas istabas.";
    return;
  }
  lobby.rooms.forEach((room) => {
    const row = document.createElement("div");
    row.className = "dz-room-row";

    const meta = document.createElement("div");
    meta.className = "dz-room-meta";

    const idSpan = document.createElement("div");
    idSpan.className = "dz-room-id";
    idSpan.textContent = `Istaba ${room.id}`;

    const playersSpan = document.createElement("div");
    playersSpan.className = "dz-room-players";

    const listNames =
      room.players && room.players.length
        ? room.players.map((p) => `${p.nickname} (${p.color})`).join(", ")
        : "tukša";
    playersSpan.textContent = `${room.playerCount}/2 – ${listNames}`;

    meta.appendChild(idSpan);
    meta.appendChild(playersSpan);

    const joinBtn = document.createElement("button");
    joinBtn.className = "dz-room-join-btn";
    joinBtn.textContent = "Pievienoties";
    joinBtn.disabled = room.playerCount >= 2;

    joinBtn.addEventListener("click", () => {
      if (!state.connected) return;
      socket.emit("joinRoom", { roomId: room.id });
    });

    row.appendChild(meta);
    row.appendChild(joinBtn);
    lobbyListEl.appendChild(row);
  });
}

function resetRoomState() {
  state.roomId = null;
  state.yourColor = null;
  state.board = [];
  state.currentPlayer = null;
  state.mustContinueJump = false;
  state.forceFrom = null;
  state.gameOver = false;
  state.selected = null;
  state.validMoves = [];
  roomTitleEl.textContent = "Nav pieslēgts istabai";
  leaveRoomBtn.disabled = true;
  statusEl.classList.remove("dz-gameover");
  statusEl.textContent =
    "Pieslēdzies serverim, izvēlies istabu vai izveido jaunu.";
  renderBoard();
  renderYourInfo();
}

// ===== Socket.IO Event handlers =====

socket.emit("createRoom");
