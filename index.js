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

// --- ボット対策ミドルウェア ---
// 明らかなボット（User-Agentがない、または特定のキーワードを含む）を弾く
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  const lowerUA = ua.toLowerCase();
  // 一般的なブラウザ以外のアクセスや、不審なクローラーをブロック
  if (!ua || lowerUA.includes('curl') || lowerUA.includes('bot') || lowerUA.includes('spider') || lowerUA.includes('wget')) {
    return res.status(403).send('Access Denied: Bot detected.');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let chatMessages = []; 
const rooms = {}; 
const roomCreationOrder = []; // ルーム作成の順番を記録する配列（最大100件管理用）
const admins = new Set(); 

const ADMIN_PASSWORD = 'pluscrown';
const ADMIN_REDIRECT_URL = 'https://mino-security.netlify.app';

function nowISO(){ return new Date().toISOString(); }

// --- レートリミット関連 ---
const RATE_WINDOW_MS = 5000; // チャット用: 5秒
const RATE_MAX = 10;         // チャット用: 10コメントまで
const ipMessageLog = new Map();

// ルーム作成用レートリミット: 1IPにつき3秒に1回
const ROOM_CREATE_COOLDOWN_MS = 3000;
const ipRoomCreateLog = new Map();

function getIpFromReq(req){
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff)) return xff[0];
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function getIpFromSocket(socket){
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff)) return xff[0];
  return socket.handshake.address || 'unknown';
}

function isRateLimited(ip){
  const now = Date.now();
  if (!ipMessageLog.has(ip)) ipMessageLog.set(ip, []);
  const arr = ipMessageLog.get(ip).filter(ts => now - ts <= RATE_WINDOW_MS);
  arr.push(now);
  ipMessageLog.set(ip, arr);
  return arr.length > RATE_MAX;
}

// オセロロジック
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
function determineWinner(board){
  const counts = countPieces(board);
  if(counts.black > counts.white) return { winner: 1, counts };
  if(counts.white > counts.black) return { winner: 2, counts };
  return { winner: 0, counts };
}

// --- REST API ---
app.get('/api/messages', (req,res) => res.json(chatMessages));

app.post('/api/messages', (req,res) => {
  const { username, message, time, reactions, seed } = req.body;
  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Invalid message' });
  }

  const ip = getIpFromReq(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: '短時間にコメントを送りすぎています。少し時間をおいてから再度お試しください。' });
  }
  
  const newMsg = {
    id: uuidv4(),
    username: String(username || '匿名').substring(0, 20),
    message: String(message).substring(0, 200),
    time: time || nowISO(),
    seed: seed ? String(seed).substring(0, 50) : '',
    reactions: reactions || {},
    isAdmin: (seed === ADMIN_PASSWORD)
  };
  
  chatMessages.push(newMsg);
  io.emit('newMessage', newMsg);
  res.status(201).json(newMsg);
});

app.post('/api/admin-login', (req,res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  if (password === ADMIN_PASSWORD) {
    const adminId = uuidv4();
    admins.add(adminId);
    io.emit('adminUpdate', Array.from(admins));
    return res.json({ ok: true, url: ADMIN_REDIRECT_URL, adminId });
  } else {
    return res.status(403).json({ ok: false, error: 'Invalid password' });
  }
});

app.get('/api/admins', (req,res) => {
  res.json(Array.from(admins));
});

app.post('/api/pass', (req,res) => {
  const { password } = req.body;
  if (password === "pluscrown") {
    chatMessages = [];
    io.emit('clearMessages');
    return res.status(200).json({ message: "全てのメッセージを削除しました。" });
  } else {
    return res.status(403).json({ error: "パスワードが違います。" });
  }
});

app.get('/api/rooms', (req,res) => {
  const list = Object.keys(rooms).map(id => ({
    id,
    players: Object.values(rooms[id].players || {}),
    hasGame: !!rooms[id].game,
    gameStatus: rooms[id].game ? rooms[id].game.status : null
  }));
  res.json(list);
});

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// --- Socket.IO ---
io.on('connection', (socket) => {
  // Socket接続時の簡易ボットチェック
  const ua = socket.handshake.headers['user-agent'] || '';
  if (!ua || ua.toLowerCase().includes('bot') || ua.toLowerCase().includes('curl')) {
    socket.disconnect(true);
    return;
  }

  socket.on('sendMessage', (data) => {
    if (!data || typeof data.message !== 'string') return;
    const ip = getIpFromSocket(socket);
    if (isRateLimited(ip)) return;

    const newMsg = {
      id: uuidv4(),
      username: String(data.username || '匿名').substring(0, 20),
      message: String(data.message).substring(0, 200),
      time: data.time || nowISO(),
      seed: data.seed ? String(data.seed).substring(0, 50) : '',
      reactions: {},
      isAdmin: (data.seed === ADMIN_PASSWORD)
    };
    chatMessages.push(newMsg);
    io.emit('newMessage', newMsg);
  });

  socket.on('updateReaction', ({ messageId, reaction }) => {
    if (typeof messageId !== 'string' || typeof reaction !== 'string') return;
    const msg = chatMessages.find(m => m.id === messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || {};
    msg.reactions[reaction] = (msg.reactions[reaction] || 0) + 1;
    io.emit('updateReaction', { messageId, reactions: msg.reactions });
  });

  socket.on('banUser', (data) => {
    io.emit('banned', data);
  });

  socket.on('joinRoom', ({ roomId, username }) => {
    if (typeof roomId !== 'string' || !roomId) return;
    roomId = roomId.substring(0, 30); // 異常に長いIDを制限
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { players: {}, chat: [], game: null };
    rooms[roomId].players[socket.id] = String(username || '匿名').substring(0, 20);
    io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
    if (rooms[roomId].game) socket.emit('gameState', enrichGameState(rooms[roomId].game));
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (typeof roomId !== 'string' || !roomId || !rooms[roomId]) return;
    socket.leave(roomId);
    if (rooms[roomId].players) delete rooms[roomId].players[socket.id];
    io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
    if (Object.keys(rooms[roomId].players).length === 0) {
      delete rooms[roomId];
      const idx = roomCreationOrder.indexOf(roomId);
      if (idx !== -1) roomCreationOrder.splice(idx, 1);
    }
  });

  socket.on('createGame', ({ roomId, username }) => {
    if (typeof roomId !== 'string' || !roomId) return;
    roomId = roomId.substring(0, 30);
    const ip = getIpFromSocket(socket);
    const now = Date.now();

    // 1. 同一IPからのルーム作成レートリミット (3秒に1回)
    const lastCreate = ipRoomCreateLog.get(ip) || 0;
    if (now - lastCreate < ROOM_CREATE_COOLDOWN_MS) {
      socket.emit('serverError', '部屋の作成は3秒に1回に制限されています。');
      return;
    }
    ipRoomCreateLog.set(ip, now);

    // 2. ルーム数の上限チェック (最大100個)
    if (!rooms[roomId] && Object.keys(rooms).length >= 100) {
      const oldestRoomId = roomCreationOrder.shift(); // 一番古いルームIDを取得
      if (oldestRoomId && rooms[oldestRoomId]) {
        io.to(oldestRoomId).emit('serverMessage', 'サーバー制限（最大100部屋）に達したため、この古い部屋は削除されました。');
        io.to(oldestRoomId).emit('roomClosed'); // クライアントに退出を促す
        io.in(oldestRoomId).socketsLeave(oldestRoomId); // 全員を強制退出
        delete rooms[oldestRoomId];
      }
    }

    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, chat: [], game: null };
      roomCreationOrder.push(roomId); // 新しいルームをキューに追加
    }

    rooms[roomId].game = {
      board: createInitialBoard(),
      turn: 1,
      status: 'waiting',
      players: {},
      lastMove: null,
      counts: countPieces(createInitialBoard())
    };
    
    const sysMsg = {
      id: uuidv4(),
      username: 'システム',
      message: `${String(username || '誰か').substring(0, 20)} が部屋 "${roomId}" を作成しました。対戦相手を募集中です！`,
      time: nowISO(),
      seed: '',
      reactions: {},
      isAdmin: true
    };
    chatMessages.push(sysMsg);
    io.emit('newMessage', sysMsg);

    io.to(roomId).emit('gameState', enrichGameState(rooms[roomId].game));
  });

  socket.on('joinGame', ({ roomId, username }) => {
    if (typeof roomId !== 'string' || !roomId || !rooms[roomId]) return;
    const game = rooms[roomId].game;
    if (!game) return;

    const uname = String(username || '匿名').substring(0, 20);
    if (game.players[1] === uname || game.players[2] === uname) { 
      io.to(roomId).emit('gameState', enrichGameState(game)); 
      return; 
    }
    if (!game.players[1]) game.players[1] = uname;
    else if (!game.players[2]) game.players[2] = uname;
    
    if (game.players[1] && game.players[2]) {
      game.status = 'playing';
      game.turn = 1;
      game.counts = countPieces(game.board);
    }
    io.to(roomId).emit('gameState', enrichGameState(game));
  });

  socket.on('makeMove', ({ roomId, r, c, color }) => {
    if (typeof roomId !== 'string' || !roomId || !rooms[roomId] || !rooms[roomId].game) return;
    if (typeof r !== 'number' || typeof c !== 'number' || typeof color !== 'number') return;

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
    else {
      game.status = 'finished';
      game.turn = null;
      const result = determineWinner(game.board);
      game.winner = result.winner;
      game.counts = result.counts;
    }
    io.to(roomId).emit('gameState', enrichGameState(game));
  });

  socket.on('requestGameState', ({ roomId }) => {
    if (typeof roomId !== 'string' || !roomId || !rooms[roomId]) return;
    if (rooms[roomId].game) socket.emit('gameState', enrichGameState(rooms[roomId].game));
  });

  socket.on('disconnect', () => {
    for (const roomId of Object.keys(rooms)) {
      if (rooms[roomId].players && rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        io.to(roomId).emit('roomUpdate', { players: Object.values(rooms[roomId].players), roomId });
      }
      const g = rooms[roomId] && rooms[roomId].game;
      if (g && g.players) {
        let changed = false;
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
        const idx = roomCreationOrder.indexOf(roomId);
        if (idx !== -1) roomCreationOrder.splice(idx, 1);
      }
    }
  });
});

function enrichGameState(game){
  const copy = {
    board: game.board,
    turn: game.turn,
    status: game.status,
    players: game.players,
    lastMove: game.lastMove,
    counts: game.counts || countPieces(game.board),
    legalMoves: game.turn ? computeLegalMoves(game.board, game.turn) : [],
    winner: game.winner !== undefined ? game.winner : null
  };
  return copy;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
