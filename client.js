const socket = io("https://bugats-dambrete-server.onrender.com");

const boardEl = document.getElementById("dz-board");
const statusEl = document.getElementById("dz-status");
const newGameBtn = document.getElementById("dz-new-game");

const SIZE = 8;
let board = [];
let currentPlayer = "b"; // melnie
let selected = null;
let validMoves = [];
let mustContinueJump = false;
let gameOver = false;

socket.on("connect", () => {
  socket.emit("joinLobby", { nickname: "Spēlētājs" });
});

socket.on("roomState", (room) => {
  board = room.board;
  currentPlayer = room.currentPlayer;
  renderBoard();
});

function renderBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const square = document.createElement("div");
      square.classList.add(
        "dz-square",
        (r + c) % 2 === 0 ? "dz-square-light" : "dz-square-dark"
      );
      square.dataset.row = r;
      square.dataset.col = c;

      // Highlight for selected
      if (selected && selected.row === r && selected.col === c) {
        square.classList.add("dz-selected");
      }

      const piece = board[r][c];
      if (piece) {
        const pieceEl = document.createElement("div");
        pieceEl.classList.add(
          "dz-piece",
          piece.color === "b" ? "dz-piece-black" : "dz-piece-white"
        );
        square.appendChild(pieceEl);
      }

      boardEl.appendChild(square);
    }
  }
}

boardEl.addEventListener("click", (e) => {
  if (gameOver) return;

  const square = e.target.closest(".dz-square");
  if (!square) return;

  const row = parseInt(square.dataset.row, 10);
  const col = parseInt(square.dataset.col, 10);

  if (selected) {
    socket.emit("makeMove", {
      roomId: "some-room-id",
      from: selected,
      to: { row, col },
    });
    selected = null;
  } else {
    selected = { row, col };
  }

  renderBoard();
});

newGameBtn.addEventListener("click", () => {
  socket.emit("createRoom");
});
