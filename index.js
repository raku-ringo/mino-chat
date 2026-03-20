// index.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// In-memory stores
let chatMessages = []; // global chat messages
const rooms = {}; // roomId -> { players: { socketId: username }, chat: [], game: {...} }

// Utilities
function nowISO(){ return new Date().toISOString(); }

// Othello helpers
const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
function createInitialBoard(){
  const b = Array.from({length:8},()=>Array(8).fill(0));
  b[3][3]=2; b[3][4]=1; b[4][3]=1; b[4][4]=2;
  return b;
}
function isOnBoard(r,c){ return r>=0 && r<8 && c>=0 && c<8; }
function getFlips(board,r,c,color){
  if(board[r][c] !== 0) return [];
  const opp = color===1?2:1;
  const flips = [];
  for(const [dr,dc] of DIRS){
    let rr=r+dr, cc=c+dc;
    const line=[];
    while(isOnBoard(rr,cc) && board[rr][cc]===opp){
      line.push([rr,cc]); rr+=dr; cc+=dc;
    }
    if(line.length>0 && isOnBoard(rr,cc) && board[rr][cc]===color){
      flips.push(...line);
    }
  }
  return flips;
}
function hasAnyLegalMove(board,color){
  for(let r=0;r<8;r++) for(let c=0;c<8;c++) if(getFlips(board,r,c,color).length>0) return true;
  return false;
}
function countPieces(board){
  let black=0, white=0;
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    if(board[r][c]===1) black++;
    if(board[r][c]===2) white++;
  }
  return { black, white };
}
function computeLegalMoves(board, color){
  const moves = [];
  for(let r=0;r<8;r++){
    for(let c=0;c<8;c++){
      if(getFlips(board,r,c,color).length>0) moves.push([r,c]);
    }
  }
  return moves;
}

// --- REST API (global chat) ---
app.get('/api/messages', (req,res) => res.json(chatMessages));

app.post('/api/messages', (req,res) => {
  const { username, message, time, reactions, seed } = req.body;
  if (!username || !message || !time) {
    return res.status(400).json({ error: 'Missing required fields (username, message, time)' });
  }
  const newMsg = {
    id: uuidv4(),
    username,
    message,
    time,
    seed: seed || '',
    reactions: reactions || {}
  };
  chatMessages.push(newMsg);
  io.emit('newMessage', newMsg);
  res.status(201).json(newMsg);
});

app.post('/api/pass', (req,res) => {
  const { password } = req.body;
  if (password === "min113") {
    chatMessages = [];
    io.emit('clearMessages');
    return res.status(200).json({ message: "全てのメッセージを削除しました。" });
  } else {
    return res.status(403).json({ error: "パスワードが違います。" });
  }
});

// Rooms list
app.get('/api/rooms', (req,res) => {
  const list = Object.keys(rooms).map(id => ({
    id,
    players: Object.values(rooms[id].players || {}),
    hasGame: !!rooms[id].game,
    gameStatus: rooms[id].game ? rooms[id].game.status : null
  }));
  res.json(list);
});

// Serve index
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('connected', socket.id);

  // Global chat via socket
  socket.on('sendMessage', (data) => {
    const newMsg = {
      id: uuidv4(),
      username: data.username || '匿名',
      message: data.message || '',
      time: data.time || nowISO(),
      seed: data.seed || '',
      reactions: {}
    };
    chatMessages.push(newMsg);
    io.emit('newMessage', newMsg);
  });

  socket.on('updateReaction', ({ messageId, reaction }) => {
    const msg = chatMessages.find(m => m.id === messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || {};
    msg.reactions[reaction] = (msg.reactions[reaction] || 0) + 1;
    io.emit('updateReaction', { messageId, reactions: msg.reactions });
  });

  // Room join/leave for chat & presence
  socket.on('joinRoom', ({ roomId, username }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { players: {}, chat: [], game: null };
    rooms[roomId].players[socket.id] = username || '匿名';
    io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
    socket.emit('chatHistory', rooms[roomId].chat || []);
    if (rooms[roomId].game) socket.emit('gameState', enrichGameState(rooms[roomId].game));
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (!roomId || !rooms[roomId]) return;
    socket.leave(roomId);
    delete rooms[roomId].players[socket.id];
    io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
    if (Object.keys(rooms[roomId].players).length === 0) delete rooms[roomId];
  });

  // Room chat
  socket.on('roomMessage', (data) => {
    const { roomId } = data;
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { players: {}, chat: [], game: null };
    const msg = { id: uuidv4(), ...data };
    rooms[roomId].chat.push(msg);
    io.to(roomId).emit('newRoomMessage', msg);
  });

  // Create game in room
  socket.on('createGame', ({ roomId }) => {
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { players: {}, chat: [], game: null };
    rooms[roomId].game = {
      board: createInitialBoard(),
      turn: 1,
      status: 'waiting', // waiting -> playing -> finished
      players: {}, // color -> username
      lastMove: null,
      counts: countPieces(createInitialBoard())
    };
    io.to(roomId).emit('gameState', enrichGameState(rooms[roomId].game));
  });

  // Join game (assign color). When two players assigned, start playing immediately.
  socket.on('joinGame', ({ roomId, username }) => {
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { players: {}, chat: [], game: null };
    if (!rooms[roomId].game) {
      rooms[roomId].game = {
        board: createInitialBoard(),
        turn: 1,
        status: 'waiting',
        players: {},
        lastMove: null,
        counts: countPieces(createInitialBoard())
      };
    }
    const game = rooms[roomId].game;
    // If username already assigned to a color, ignore
    if (game.players[1] === username || game.players[2] === username) {
      io.to(roomId).emit('gameState', enrichGameState(game));
      return;
    }
    // Assign color if available
    if (!game.players[1]) game.players[1] = username;
    else if (!game.players[2]) game.players[2] = username;
    // If both players present, start the game
    if (game.players[1] && game.players[2]) {
      game.status = 'playing';
      game.turn = 1; // black starts
      game.counts = countPieces(game.board);
    }
    io.to(roomId).emit('gameState', enrichGameState(game));
  });

  // Make move
  socket.on('makeMove', ({ roomId, r, c, color }) => {
    if (!roomId || !rooms[roomId] || !rooms[roomId].game) return;
    const game = rooms[roomId].game;
    if (game.status !== 'playing') return;
    if (game.turn !== color) return;
    const flips = getFlips(game.board, r, c, color);
    if (flips.length === 0) return;
    game.board[r][c] = color;
    for (const [fr,fc] of flips) game.board[fr][fc] = color;
    game.lastMove = { r, c, color, time: nowISO() };
    game.counts = countPieces(game.board);
    const opponent = color === 1 ? 2 : 1;
    if (hasAnyLegalMove(game.board, opponent)) game.turn = opponent;
    else if (hasAnyLegalMove(game.board, color)) game.turn = color;
    else { game.status = 'finished'; game.turn = null; }
    io.to(roomId).emit('gameState', enrichGameState(game));
  });

  socket.on('requestGameState', ({ roomId }) => {
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].game) socket.emit('gameState', enrichGameState(rooms[roomId].game));
  });

  // Disconnect cleanup: remove from rooms and if they were a game player, remove assignment and set waiting
  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      if (rooms[roomId].players && rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
      }
      const g = rooms[roomId] && rooms[roomId].game;
      if (g && g.players) {
        let changed = false;
        // If a player name is no longer present in room presence, remove assignment
        const presentNames = Object.values(rooms[roomId].players || {});
        if (g.players[1] && presentNames.indexOf(g.players[1]) === -1) { delete g.players[1]; changed = true; }
        if (g.players[2] && presentNames.indexOf(g.players[2]) === -1) { delete g.players[2]; changed = true; }
        if (changed) {
          g.status = 'waiting';
          g.turn = 1;
          io.to(roomId).emit('gameState', enrichGameState(g));
        }
      }
      if (rooms[roomId] && Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
      }
    }
    console.log('disconnected', socket.id);
  });
});

// Enrich game state with legalMoves for current turn and for both colors (optional)
function enrichGameState(game){
  const copy = {
    board: game.board,
    turn: game.turn,
    status: game.status,
    players: game.players,
    lastMove: game.lastMove,
    counts: game.counts || countPieces(game.board),
    legalMoves: game.turn ? computeLegalMoves(game.board, game.turn) : []
  };
  return copy;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
