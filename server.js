const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Cors 허용 설정 (오더기와 태블릿 간의 통신 벽 해제)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 정적 파일 위치 설정 (public 폴더 안의 파일들을 컴퓨터가 읽을 수 있게 함)
app.use(express.static(path.join(__dirname, 'public')));

// 🔗 1. 기본 주소로 접속 시 -> 직원용 오더기(index.html) 제공
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔗 2. /pos 주소로 접속 시 -> 주방 태블릿(pos.html) 제공
app.get('/pos', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pos.html'));
});

// 실시간 데이터 임시 저장소 (서버 켜져있는 동안 유지)
let sharedDb = { tables: {}, totalSales: 0, itemSales: {}, history: [], soldOut: {}, checkedItems: {} };

// 소켓 실시간 데이터 핑퐁 처리
io.on('connection', (socket) => {
    console.log('📱 기기 새로 연결됨:', socket.id);
    
    // 연결되자마자 최신 데이터 전송
    socket.emit('orderUpdate', sharedDb);

    // 오더기나 태블릿이 데이터를 보냈을 때 전체 기기로 살포
    socket.on('newOrder', (data) => {
        if(data) {
            sharedDb = data;
            io.emit('orderUpdate', sharedDb); // 모든 기기에 실시간 전송
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ 기기 연결 해제됨:', socket.id);
    });
});

// 축제용 포트 3000번 개방
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상 작동 중입니다!`);
});