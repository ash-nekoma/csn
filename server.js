require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB SETUP ---
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, // DEFAULT SET TO 0
    status: { type: String, default: 'Offline' },
    joinDate: { type: Date, default: Date.now },
    dailyReward: {
        lastClaim: { type: Date, default: null },
        streak: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

// --- SHARED TABLES ENGINE ---
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };

// Generate random card helper
function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'], ss = ['♠','♣','♥','♦'];
    let v = vs[Math.floor(Math.random() * vs.length)], s = ss[Math.floor(Math.random() * ss.length)];
    let bac = parseInt(v); if (isNaN(bac) || v === '10') bac = 0; if (v === 'A') bac = 1;
    let bj = parseInt(v); if (['J','Q','K'].includes(v)) bj = 10; if (v === 'A') bj = 11;
    return { val: v, suit: s, bacVal: bac, bjVal: bj };
}

// Global Casino Clock
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            // Resolve Dragon Tiger
            let dtD = drawCard(), dtT = drawCard();
            let dtWin = dtD.bjVal > dtT.bjVal ? 'Dragon' : (dtT.bjVal > dtD.bjVal ? 'Tiger' : 'Tie');
            
            // Resolve Sic Bo
            let sbR = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
            let sbSum = sbR[0]+sbR[1]+sbR[2];
            let sbTrip = (sbR[0]===sbR[1] && sbR[1]===sbR[2]);
            let sbWin = sbTrip ? 'None' : (sbSum <= 10 ? 'Small' : 'Big');

            // Resolve Color Game
            const cols = ['Yellow','White','Pink','Blue','Red','Green'];
            let peryaR = [cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)]];

            // Payout Logic
            sharedTables.bets.forEach(async (b) => {
                let user = await User.findById(b.userId);
                if(!user) return;
                let payout = 0;
                if(b.room === 'dt' && b.choice === dtWin) payout = b.amount * (dtWin==='Tie'?8:2);
                if(b.room === 'sicbo' && b.choice === sbWin) payout = b.amount * 2;
                if(b.room === 'perya') {
                    let matches = peryaR.filter(c => c === b.choice).length;
                    if(matches > 0) payout = b.amount + (b.amount * matches);
                }

                if(payout > 0) {
                    user.credits += payout;
                    await user.save();
                    io.to(b.socketId).emit('balanceUpdate', user.credits);
                }
            });

            // Broadcast Results
            io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin });
            io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin });
            io.to('perya').emit('sharedResults', { room: 'perya', roll: peryaR });

            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound');
            }, 6000);
        }
    }
}, 1000);

// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);

    // Login
    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.username, password: data.password });
        if (!user) return socket.emit('authError', 'Invalid login.');
        user.status = 'Active'; await user.save();
        socket.user = user;
        
        // Calculate Daily Reward Status
        let nextRewardDay = 1;
        let canClaim = true;
        if (user.dailyReward.lastClaim) {
            let hoursPassed = Math.abs(new Date() - user.dailyReward.lastClaim) / 36e5;
            if (hoursPassed < 24) canClaim = false;
            else if (hoursPassed > 48) user.dailyReward.streak = 0; // Reset streak
            nextRewardDay = (user.dailyReward.streak % 7) + 1;
        }

        socket.emit('loginSuccess', { 
            username: user.username, credits: user.credits, 
            daily: { canClaim: canClaim, day: nextRewardDay } 
        });
        io.emit('chatMessage', { user: 'System', text: `${user.username} entered the casino.`, sys: true });
    });

    // Register
    socket.on('register', async (data) => {
        const exists = await User.findOne({ username: data.username });
        if (exists) return socket.emit('authError', 'Username taken.');
        const newUser = new User({ username: data.username, password: data.password });
        await newUser.save();
        socket.emit('registerSuccess', 'Account created! Please login.');
    });

    // Daily Reward
    socket.on('claimDaily', async () => {
        if(!socket.user) return;
        const user = await User.findById(socket.user._id);
        
        if (user.dailyReward.lastClaim) {
            let hoursPassed = Math.abs(new Date() - user.dailyReward.lastClaim) / 36e5;
            if (hoursPassed < 24) return socket.emit('toast', {msg: 'Come back tomorrow!', type: 'error'});
            if (hoursPassed > 48) user.dailyReward.streak = 0;
        }

        let currentDay = (user.dailyReward.streak % 7) + 1;
        const rewards = [25, 50, 100, 200, 500, 750, 1000];
        let amt = rewards[currentDay - 1];

        user.credits += amt;
        user.dailyReward.lastClaim = new Date();
        user.dailyReward.streak += 1;
        await user.save();

        socket.emit('dailyClaimed', { amt: amt, newBalance: user.credits });
    });

    // Shared Tables
    socket.on('joinRoom', (room) => { socket.join(room); rooms[room]++; io.emit('playerCount', rooms); });
    socket.on('leaveRoom', (room) => { socket.leave(room); if(rooms[room]>0) rooms[room]--; io.emit('playerCount', rooms); });
    socket.on('sendChat', (data) => { if(socket.user) io.to(data.room).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); });

    socket.on('placeSharedBet', async (data) => {
        if(!socket.user || sharedTables.status !== 'BETTING') return;
        const user = await User.findById(socket.user._id);
        if(user.credits < data.amount) return;
        
        user.credits -= data.amount; await user.save();
        socket.emit('balanceUpdate', user.credits);
        sharedTables.bets.push({ userId: user._id, socketId: socket.id, room: data.room, choice: data.choice, amount: data.amount });
    });

    // Solo Games: Dice & Coin
    socket.on('playSolo', async (data) => {
        if(!socket.user) return;
        const user = await User.findById(socket.user._id);
        if(user.credits < data.bet) return socket.emit('toast', {msg: 'Insufficient TC', type: 'error'});

        user.credits -= data.bet;
        let payout = 0;

        if(data.game === 'dice') {
            let roll = Math.floor(Math.random() * 100) + 1;
            if(roll > 50) payout = data.bet * 2;
            user.credits += payout; await user.save();
            socket.emit('diceResult', { roll, payout, bet: data.bet });
            socket.emit('balanceUpdate', user.credits);
        }
        else if(data.game === 'coinflip') {
            let result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            if(data.choice === result) payout = data.bet * 2;
            user.credits += payout; await user.save();
            socket.emit('coinResult', { result, payout, bet: data.bet });
            socket.emit('balanceUpdate', user.credits);
        }
    });

    socket.on('disconnect', async () => {
        if(socket.user) await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Casino running on port ${PORT}`));
