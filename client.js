const SERVER_URL = "https://bugats-dambrete-server.onrender.com";
const socket = io(SERVER_URL, { autoConnect: false });

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
  yourColor: null, // "b" | "w"
  roomId: null,
  board: [],
  currentPlayer: null,
  mustContinueJump: false,
  forceFrom: null, // {row,col}
  gameOver: false,

  selected: null,
  validMoves: [],
};

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
    const idSpan = document.createElement("div");
    idSpan.className = "dz-room-id";
    idSpan.textContent = `Istaba ${room.id}`;

    const playersSpan = document.createElement("div");
    playersSpan.className = "dz-room-players";
    playersSpan.textContent = `${room.playerCount}/2`;
    const joinBtn = document.createElement("button");
    joinBtn.className = "dz-room-join-btn";
    joinBtn.textContent = "Pievienoties";
    joinBtn.disabled = room.playerCount >= 2;

    joinBtn.addEventListener("click", () => {
      if (!state.connected) return;
      socket.emit("joinRoom", { roomId: room.id });
    });

    row.appendChild(idSpan);
    row.appendChild(playersSpan);
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

// ===== Board render / klikšķi =====

function renderBoard() {
  boardEl.innerHTML = "";
  const board = state.board.length ? state.board : createEmptyBoard();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const square = document.createElement("div");
      square.className =
        "dz-square " + ((r + c) % 2 === 0 ? "dz-square-light" : "dz-square-dark");
      square.dataset.row = r;
      square.dataset.col = c;

      if (state.selected && state.selected.row === r && state.selected.col === c) {
        square.classList.add("dz-selected");
      }

      if (
        state.validMoves.some(
          (m) => m.to.row === r && m.to.col === c
        )
      ) {
        square.classList.add("dz-move");
      }

      const piece = board[r][c];
      if (piece) {
        const pEl = document.createElement("div");
        pEl.className =
          "dz-piece " +
          (piece.color === "b" ? "dz-piece-black" : "dz-piece-white");
        if (piece.king) pEl.classList.add("dz-piece-king");
        square.appendChild(pEl);
      }

      boardEl.appendChild(square);
    }
  }
}

function createEmptyBoard() {
  const b = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push(null);
    b.push(row);
  }
  return b;
}

boardEl.addEventListener("click", (e) => {
  if (!state.roomId || !state.yourColor) return;
  if (state.currentPlayer !== state.yourColor) return;
  if (state.gameOver) return;

  const square = e.target.closest(".dz-square");
  if (!square) return;
  const row = parseInt(square.dataset.row, 10);
  const col = parseInt(square.dataset.col, 10);

  // mēģinām noslēgt gājienu
  if (state.selected && state.validMoves.length > 0) {
    const chosen = state.validMoves.find(
      (m) => m.to.row === row && m.to.col === col
    );
    if (chosen) {
      // sūtām uz serveri, dēli maina tikai serveris
      socket.emit("makeMove", {
        roomId: state.roomId,
        from: chosen.from,
        to: chosen.to,
      });
      // klienta pusē atslēdzam highlight
      state.selected = null;
      state.validMoves = [];
      renderBoard();
      return;
    }
  }

  // ja jāturpina ķēdes ņemšana – drīkst tikai ar vienu kauliņu
  if (state.mustContinueJump) {
    if (
      !state.forceFrom ||
      state.forceFrom.row !== row ||
      state.forceFrom.col !== col
    ) {
      return;
    }
  }

  // jauna izvēle
  const moves = getValidMovesForPieceClient(row, col);
  if (moves.length === 0) {
    state.selected = null;
    state.validMoves = [];
    renderBoard();
    return;
  }

  state.selected = { row, col };
  state.validMoves = moves;
  renderBoard();
});

// ===== Socket.IO notikumi =====

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

socket.on("roomJoined", (payload) => {
  const { room, yourColor } = payload;
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
  // ja ļoti vajag, var uzrakstīt
  statusEl.textContent = "Nederīgs gājiens.";
});

// ===== Stāvokļa sinhronizācija no servera =====

function syncRoomState(room) {
  state.board = room.board || [];
  state.currentPlayer = room.currentPlayer;
  state.mustContinueJump = room.mustContinueJump;
  state.forceFrom = room.forceFrom;
  state.gameOver = room.gameOver;

  state.selected = null;
  state.validMoves = [];

  const whoTurn =
    room.currentPlayer === "b" ? "melnie (augšā)" : "baltie (apakšā)";

  if (room.gameOver) {
    statusEl.classList.add("dz-gameover");
    const winner =
      room.winner === "b"
        ? "melnie (augšā)"
        : room.winner === "w"
        ? "baltie (apakšā)"
        : "nezināms";
    statusEl.textContent = `Spēle beigusies – uzvarēja ${winner}.`;
  } else if (state.mustContinueJump && state.forceFrom) {
    statusEl.classList.remove("dz-gameover");
    statusEl.textContent = `Dubultnieciens: turpini ņemt ar to pašu kauliņu (${whoTurn}).`;
  } else {
    statusEl.classList.remove("dz-gameover");
    statusEl.textContent = `Gājiens: ${whoTurn}`;
  }

  renderBoard();
}

// ===== UI event listeners =====

connectBtn.addEventListener("click", () => {
  if (state.connected) return;
  const nick = nickInput.value.trim() || "Spēlētājs";
  state.nickname = nick;
  localStorage.setItem("dz-nick", nick);
  setConnectionUi(false);
  socket.connect();
  renderYourInfo();
});

createRoomBtn.addEventListener("click", () => {
  if (!state.connected) return;
  socket.emit("createRoom");
});

leaveRoomBtn.addEventListener("click", () => {
  if (!state.connected || !state.roomId) return;
  socket.emit("leaveRoom");
});

const savedNick = localStorage.getItem("dz-nick");
if (savedNick) {
  nickInput.value = savedNick;
  state.nickname = savedNick;
  renderYourInfo();
}

resetRoomState();
