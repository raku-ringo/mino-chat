const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let chatMessages = [];
let users = []; 

app.get('/api/messages', (req, res) => {
  res.json(chatMessages);
});

app.post('/api/messages', (req, res) => {
  const { username, message, time, reactions, seed } = req.body;
  if (!username || !message || !time || !seed) {
    return res.status(400).json({ error: 'Missing required fields (username, message, time, seed)' });
  }
  const userSeed = seed;
  const newMessage = {
    username,
    message,
    time,
    reactions: reactions || { "👍": 0, "😡": 0 },
    seed: userSeed
  };
  chatMessages.push(newMessage);
  io.emit("newMessage", newMessage);
  res.status(201).json(newMessage);
});


app.get('/user', (req, res) => {
  res.json({
    userCount: users.length,
    userIds: users
  });
});

app.all('/api/pass', (req, res, next) => {
  const isPostMethod = req.method === 'POST';
  const requestedWith = req.headers['x-requested-with'];
  if (!isPostMethod || !requestedWith || requestedWith !== 'fetch') {
    return res.sendFile(path.join(__dirname, 'public', 'gisou.html'));
  }
  next();
});

app.post('/api/pass', (req, res) => {
  const { password } = req.body;
  if (password === "min113") {
    chatMessages = [];
    io.emit("clearMessages");
    return res.status(200).json({ message: "全てのメッセージを削除しました。" });
  } else {
    return res.status(403).json({ error: "パスワードが違います。" });
  }
});


io.on('connection', (socket) => {
  console.log('ユーザーが接続しました: ' + socket.id);
  users.push(socket.id); 


  socket.on('sendMessage', (data) => {
    chatMessages.push(data);
    io.emit("newMessage", data);
  });

  socket.on('updateReaction', ({ messageId, reaction }) => {
    if (messageId >= 0 && messageId < chatMessages.length) {
      let msg = chatMessages[messageId];
      if (msg.reactions && msg.reactions.hasOwnProperty(reaction)) {
        msg.reactions[reaction] += 1;
      } else {
        msg.reactions[reaction] = 1;
      }
      io.emit("updateReaction", { messageId, reactions: msg.reactions });
    }
  });

  socket.on('disconnect', () => {
    console.log('ユーザーが切断しました: ' + socket.id);
    users = users.filter(id => id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動中 http://localhost:${PORT}`);
});
