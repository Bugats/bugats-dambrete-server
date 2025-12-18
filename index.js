const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Saglabā spēlētāju datus
let players = {};

// Izveido servera sakaru ar klientu
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Pieprasījums pievienot spēlētāju
    socket.on('joinGame', (playerData) => {
        players[socket.id] = playerData; // Saglabā spēlētāja informāciju
        io.emit('playerList', players);  // Nosūta spēlētāju sarakstu visiem spēlētājiem
        console.log(`${playerData.name} joined the game!`);
    });

    // Spēlētāja attēla nosūtīšana
    socket.on('updateImage', (image) => {
        if (players[socket.id]) {
            players[socket.id].image = image; // Atjaunina attēlu
        }
    });

    // Atvieno spēlētāju
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete players[socket.id]; // Noņem spēlētāju no saraksta
        io.emit('playerList', players); // Nosūta atjaunoto sarakstu
    });
});

// Serve HTML failu
app.use(express.static(path.join(__dirname, 'public')));

// Servera uzsākšana
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
