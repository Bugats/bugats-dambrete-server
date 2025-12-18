const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let players = [];
let leaderboard = [];

app.use(express.static('public'));  // Servē front-end failus

io.on('connection', (socket) => {
  console.log('A player connected');

  // Piešķir spēlētājam sākotnējo avataru
  players.push({ id: socket.id, xp: 0, avatar: 'default-avatar.png' });

  // Atjaunina spēlētāju skaitu
  io.emit('playerCount', players.length);

  // Atjaunina leaderboard
  io.emit('leaderboardUpdate', leaderboard);

  // Spēlētāja diskešanas gadījumā
  socket.on('disconnect', () => {
    players = players.filter(player => player.id !== socket.id);
    io.emit('playerCount', players.length);
  });

  // Iestatīt avatāru
  socket.on('setAvatar', (avatar) => {
    const player = players.find(player => player.id === socket.id);
    if (player) {
      player.avatar = avatar;
    }
  });

  // Pievienot XP un atjaunināt leaderboard
  socket.on('playerMove', (moveData) => {
    let winner = determineWinner(moveData);
    if (winner) {
      let player = leaderboard.find(player => player.id === winner.id);
      if (player) {
        player.xp += 10;
      } else {
        leaderboard.push({ id: winner.id, name: winner.name, xp: 10 });
      }
      io.emit('leaderboardUpdate', leaderboard);
    }
  });
});

// Funkcija, lai noteiktu uzvarētāju
function determineWinner(moveData) {
  // Loģika, lai noteiktu uzvarētāju
  // Atgriež uzvarētāju, ja ir uzvarētājs
  return { id: moveData.playerId, name: moveData.playerName };
}

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
