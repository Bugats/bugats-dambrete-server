body {
  font-family: Arial, sans-serif;
  background-color: #181818;
  color: white;
  text-align: center;
}

#game {
  margin-top: 50px;
}

#gameBoard {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  gap: 2px;
  width: 400px;
  margin: 0 auto;
}

.row {
  display: flex;
}

.cell {
  width: 50px;
  height: 50px;
  background-color: #deb887;
  display: flex;
  justify-content: center;
  align-items: center;
}

.cell.black {
  background-color: #000;
}

#onlineCount, #topPlayers {
  color: white;
}

button {
  background-color: #007bff;
  color: white;
  border: none;
  padding: 10px;
  cursor: pointer;
}

button:hover {
  background-color: #0056b3;
}
