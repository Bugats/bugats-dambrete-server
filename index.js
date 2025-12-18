const express = require('express');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Statiskie faili (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Ielādē index.html, kad tiek apmeklēta mājas lapa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO komunikācija
let players = [];
let leaderboard = [];

io.on('connection', (socket) => {
  console.log('A player connected');

  // Saglabā spēlētāju un norāda avataru
  players.push({ id: socket.id, xp: 0, avatar: 'default-avatar.png' });

  // Nosūta spēlētāju skaitu visiem spēlētājiem
  io.emit('playerCount', players.length);

  // Nosūta leaderboard visiem spēlētājiem
  io.emit('leaderboardUpdate', leaderboard);

  // Spēlētāja atvienošanās
  socket.on('disconnect', () => {
    players = players.filter(player => player.id !== socket.id);
    io.emit('playerCount', players.length);
  });

  // Spēlētāja avatāra iestatīšana
  socket.on('setAvatar', (avatar) => {
    const player = players.find(player => player.id === socket.id);
    if (player) {
      player.avatar = avatar;
    }
  });

  // Spēlētāja gājiena paziņošana
  socket.on('playerMove', (moveData) => {
    let winner = determineWinner(moveData);
    if (winner) {
      let player = leaderboard.find(player => player.id === winner.id);
      if (player) {
        player.xp += 10; // Pievieno XP
      } else {
        leaderboard.push({ id: winner.id, name: winner.name, xp: 10 });
      }
      io.emit('leaderboardUpdate', leaderboard);
    }
  });
});

// Funkcija, lai noteiktu uzvarētāju (pamata loģika)
function determineWinner(moveData) {
  // Piemēram, uzvarētājs tiek noteikts pēc gājiena
  // Tev būs jāievieš konkrēta spēles loģika
  return { id: moveData.playerId, name: moveData.playerName };
}

// Servera palaišana
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
