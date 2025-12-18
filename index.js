const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve public files
app.use(express.static('public'));

// Veidošanas reģistrācija (spēlētāju attēli un uzvaras)
let players = {};

io.on('connection', (socket) => {
    console.log('Player connected');
    
    // Izsauc spēlētāju, kad viņš pievienojas
    socket.on('joinGame', (playerData) => {
        players[socket.id] = playerData;
        io.emit('playerList', players); // Nosūta visiem spēlētājiem reāllaika spēlētāju sarakstu
    });

    // Nosūta spēlētāju informāciju katram klientam
    socket.emit('playerInfo', players[socket.id]);

    // Spēlētāja kustība
    socket.on('move', (data) => {
        console.log('Move received:', data);
        io.emit('move', data);  // Nosūta visiem spēlētājiem spēles kustības
    });

    // Izmanto spēles beigu stāvokli
    socket.on('gameOver', (result) => {
        io.emit('gameOver', result);  // Nosūta visiem spēlētājiem
    });

    // Atvieno spēlētāju
    socket.on('disconnect', () => {
        console.log('Player disconnected');
        delete players[socket.id];
        io.emit('playerList', players);  // Atjaunina spēlētāju sarakstu
    });
});

// Startējot serveri
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
