require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Database'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// 2. DATABASE SCHEMAS
// ==========================================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    status: { type: String, default: 'Offline' },
    joinDate: { type: Date, default: Date.now },
    dailyReward: {
        lastClaim: { type: Date, default: null },
        streak: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String,
    type: String, 
    amount: Number,
    ref: String,
    status: { type: String, default: 'Pending' },
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({
    batchId: String,
    amount: Number,
    code: String,
    redeemedBy: { type: String, default: null },
    date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);


// ==========================================
// 3. CASINO ENGINE & GLOBAL HISTORY / STATS
// ==========================================
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };

let globalResults = { 
    dice: [], coinflip: [], blackjack: [], 
    baccarat: [], perya: [], dt: [], sicbo: [] 
};

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
    dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
    perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 },
    dice: { total: 0, Win: 0, Lose: 0 },
    blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

function logGlobalResult(game, resultStr) {
    globalResults[game].unshift({ result: resultStr, time: new Date() });
    if (globalResults[game].length > 25) globalResults[game].pop();
}

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[Math.floor(Math.random() * vs.length)];
    let s = ss[Math.floor(Math.random() * ss.length)];
    
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    
    let dt = 0;
    if (v === 'A') dt = 14;
    else if (v === 'K') dt = 13;
    else if (v === 'Q') dt = 12;
    else if (v === 'J') dt = 11;
    else dt = parseInt(v);

    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { score += card.bjVal; if (card.val === 'A') aces += 1; }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// ==========================================
// 4. SHARED TABLES REAL-TIME LOOP
// ==========================================
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            let dtD = drawCard(), dtT = drawCard();
            let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
            logGlobalResult('dt', `${dtWin} Win`);
            gameStats.dt.total++; gameStats.dt[dtWin]++;
            
            let sbR = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
            let sbSum = sbR[0] + sbR[1] + sbR[2];
            let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
            let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
            logGlobalResult('sicbo', sbTrip ? `Triple ${sbR[0]}` : `${sbWin} (${sbSum})`);
            gameStats.sicbo.total++; gameStats.sicbo[sbWin]++;

            const cols = ['Yellow','White','Pink','Blue','Red','Green'];
            let pyR = [cols[Math.floor(Math.random() * 6)], cols[Math.floor(Math.random() * 6)], cols[Math.floor(Math.random() * 6)]];
            logGlobalResult('perya', pyR.join(','));
            gameStats.perya.total++; pyR.forEach(c => gameStats.perya[c]++);

            let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
            let pS = (pC[0].bacVal + pC[1].bacVal) % 10;
            let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
            let p3Drawn = false, b3Drawn = false;

            if (pS < 8 && bS < 8) {
                let p3Val = -1;
                if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; p3Drawn = true; }
                let bDraws = false;
                if (pC.length === 2) { if (bS <= 5) bDraws = true; } 
                else {
                    if (bS <= 2) bDraws = true;
                    else if (bS === 3 && p3Val !== 8) bDraws = true;
                    else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                    else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                    else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
                }
                if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; b3Drawn = true; }
            }
            let bacWin = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
            logGlobalResult('baccarat', `${bacWin} (${pS} to ${bS})`);
            gameStats.baccarat.total++; gameStats.baccarat[bacWin]++;

            let playerPayouts = {}; 
            sharedTables.bets.forEach(b => {
                let payout = 0;
                if (b.room === 'dt' && b.choice === dtWin) payout = b.amount * (dtWin === 'Tie' ? 8 : 2);
                else if (b.room === 'sicbo' && b.choice === (sbWin === 'Triple' ? 'None' : sbWin)) payout = b.amount * 2;
                else if (b.room === 'perya') {
                    let matches = pyR.filter(c => c === b.choice).length;
                    if (matches > 0) payout = b.amount + (b.amount * matches);
                }
                else if (b.room === 'baccarat' && b.choice === bacWin) payout = b.amount * (bacWin === 'Tie' ? 8 : 2);

                if (payout > 0) {
                    if (!playerPayouts[b.userId]) playerPayouts[b.userId] = { socketId: b.socketId, username: b.username, amount: 0 };
                    playerPayouts[b.userId].amount += payout;
                }
            });

            Object.keys(playerPayouts).forEach(async (userId) => {
                let user = await User.findById(userId);
                if (user) {
                    user.credits += playerPayouts[userId].amount;
                    await user.save();
                }
            });

            io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin });
            io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin });
            io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR });
            io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, p3Drawn: p3Drawn, b3Drawn: b3Drawn });

            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); 
                pushAdminData(); // Refresh admin stats
            }, 8000); 
        }
    }
}, 1000);

// ==========================================
// 5. HELPER: PUSH ADMIN DATA
// ==========================================
async function pushAdminData(target = io.to('admin_room')) {
    try {
        const users = await User.find(); 
        const txs = await Transaction.find().sort({ date: -1 }); 
        const gcs = await GiftCode.find().sort({ date: -1 });
        let totalEconomy = users.reduce((a, b) => a + (b.credits || 0), 0);
        target.emit('adminDataSync', { users, transactions: txs, giftBatches: gcs, stats: { economy: totalEconomy } });
    } catch(e) { console.error(e); }
}

// ==========================================
// 6. CLIENT SOCKET COMMUNICATION
// ==========================================
io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);

    // --- ADMIN MODULE ---
    socket.on('adminLogin', async (data) => {
        if (data.username === 'admin' && data.password === 'admin') {
            socket.join('admin_room'); // Lock admin into secure room
            socket.emit('adminLoginSuccess', { username: 'Admin Boss', role: 'Head Admin' });
            await pushAdminData(socket);
        } else { 
            socket.emit('authError', 'Invalid Admin Credentials.'); 
        }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.rooms.has('admin_room')) return; // Block non-admins

        try {
            if (data.type === 'editUser') {
                await User.findByIdAndUpdate(data.id, { credits: data.credits, role: data.role });
            }
            else if (data.type === 'ban') {
                await User.findByIdAndUpdate(data.id, { status: 'Banned' });
            }
            else if (data.type === 'unban') {
                await User.findByIdAndUpdate(data.id, { status: 'Active' });
            }
            else if (data.type === 'resolveTx') {
                let tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; 
                    await tx.save();
                    
                    // Add funds to player if deposit approved
                    if (tx.type === 'Deposit' && data.status === 'Approved') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            u.credits += tx.amount;
                            await u.save();
                            io.emit('balanceUpdateForUser', { username: u.username, newBalance: u.credits, action: "Deposit Approved" });
                        }
                    }
                    // Refund player if withdrawal rejected
                    if (tx.type === 'Withdrawal' && data.status === 'Rejected') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            u.credits += tx.amount;
                            await u.save();
                            io.emit('balanceUpdateForUser', { username: u.username, newBalance: u.credits, action: "Withdrawal Rejected" });
                        }
                    }
                }
            }
            else if (data.type === 'createBatch') {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let batchId = 'B-' + Math.floor(Math.random() * 10000);
                for(let i=0; i<data.count; i++) {
                    let code = '';
                    for(let j=0; j<10; j++) code += chars.charAt(Math.floor(Math.random() * chars.length));
                    await new GiftCode({ batchId, amount: data.amount, code }).save();
                }
            }
            else if (data.type === 'deleteBatch') {
                await GiftCode.findByIdAndDelete(data.id);
            }
            
            // Sync all connected admin panels live
            await pushAdminData();

        } catch(e) { console.error("Admin Action Error:", e); }
    });

    // --- AUTHENTICATION ---
    socket.on('login', async (data) => {
        try {
            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            user.status = 'Active'; await user.save(); socket.user = user;
            pushAdminData(); // Update admin live
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }

            socket.emit('loginSuccess', { username: user.username, credits: user.credits, daily: { canClaim, day, nextClaim } });
        } catch(e) { socket.emit('authError', 'Server Error.'); }
    });

    socket.on('register', async (data) => {
        try {
            const exists = await User.findOne({ username: data.username });
            if (exists) return socket.emit('authError', 'Username is already taken.');
            await new User({ username: data.username, password: data.password }).save();
            pushAdminData();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { socket.emit('authError', 'Server Error.'); }
    });

    // --- DAILY REWARD ---
    socket.on('claimDaily', async () => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        let now = new Date();
        if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim) / (1000 * 60 * 60) < 24) return; 

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [25, 50, 100, 200, 500, 750, 1000];
        let amt = rewards[day - 1];

        user.credits += amt; user.dailyReward.lastClaim = now; user.dailyReward.streak += 1;
        await user.save();
        pushAdminData();
        socket.emit('dailyClaimed', { amt, newBalance: user.credits, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    });

    // --- PROMO CODES ---
    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOne({ code: code });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid Code' });
            if (gc.redeemedBy) return socket.emit('promoResult', { success: false, msg: 'Code already used' });

            gc.redeemedBy = socket.user.username; await gc.save();
            const user = await User.findById(socket.user._id);
            user.credits += gc.amount; await user.save();
            pushAdminData();
            socket.emit('promoResult', { success: true, amt: gc.amount });
            socket.emit('balanceUpdateData', user.credits);
        } catch(e) { socket.emit('promoResult', { success: false, msg: 'Server error' }); }
    });

    // --- GLOBAL RESULTS ---
    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: gameStats[game] || { total: 0 } });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        if (user.credits < data.bet) return socket.emit('toast', { msg: 'Insufficient TC', type: 'error' });
        
        user.credits -= data.bet; 
        let payout = 0;

        if (data.game === 'dice') {
            gameStats.dice.total++;
            let roll = Math.floor(Math.random() * 100) + 1;
            if (roll > 50) { payout = data.bet * 2; gameStats.dice.Win++; } 
            else { gameStats.dice.Lose++; }
            user.credits += payout; await user.save();
            logGlobalResult('dice', `Rolled ${roll}`);
            pushAdminData();
            socket.emit('diceResult', { roll, payout, bet: data.bet, newBalance: user.credits });
        } 
        else if (data.game === 'coinflip') {
            gameStats.coinflip.total++;
            let result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            gameStats.coinflip[result]++;
            if (data.choice === result) payout = data.bet * 2;
            user.credits += payout; await user.save();
            logGlobalResult('coinflip', result);
            pushAdminData();
            socket.emit('coinResult', { result, payout, bet: data.bet, newBalance: user.credits });
        }
        else if (data.game === 'blackjack') {
            if (data.action === 'start') {
                gameStats.blackjack.total++; await user.save(); 
                socket.bjState = { bet: data.bet, pHand: [drawCard(), drawCard()], dHand: [drawCard(), drawCard()] };
                
                let pS = getBJScore(socket.bjState.pHand);
                let dS = getBJScore(socket.bjState.dHand);
                
                if (pS === 21) {
                    let msg = dS === 21 ? 'Push' : 'Blackjack!';
                    payout = dS === 21 ? data.bet : data.bet * 2.5;
                    if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++;
                    user.credits += payout; await user.save();
                    logGlobalResult('blackjack', `${msg.toUpperCase()} (${pS} TO ${dS})`);
                    pushAdminData();
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: data.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand });
                }
            }
            else if (data.action === 'hit' && socket.bjState) {
                socket.bjState.pHand.push(drawCard());
                let pS = getBJScore(socket.bjState.pHand);
                let dS = getBJScore(socket.bjState.dHand);
                
                if (pS > 21) {
                    gameStats.blackjack.Lose++;
                    logGlobalResult('blackjack', `BUST! (${pS} TO ${dS})`);
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', bet: socket.bjState.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand });
                }
            }
            else if (data.action === 'stand' && socket.bjState) {
                let pS = getBJScore(socket.bjState.pHand);
                while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                
                let dS = getBJScore(socket.bjState.dHand);
                let msg = '';
                if (dS > 21 || pS > dS) { payout = socket.bjState.bet * 2; msg = 'You Win!'; gameStats.blackjack.Win++; } 
                else if (pS === dS) { payout = socket.bjState.bet; msg = 'Push'; gameStats.blackjack.Push++; } 
                else { msg = 'Dealer Wins'; gameStats.blackjack.Lose++; }
                
                user.credits += payout; await user.save();
                let logMsg = (dS > 21) ? 'DEALER BUSTS!' : msg.toUpperCase();
                logGlobalResult('blackjack', `${logMsg} (${pS} TO ${dS})`);
                pushAdminData();
                socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: socket.bjState.bet, newBalance: user.credits });
                socket.bjState = null;
            }
        }
    });

    // --- SHARED TABLES NETWORKING ---
    socket.on('joinRoom', (room) => { socket.join(room); rooms[room]++; io.emit('playerCount', rooms); });
    socket.on('leaveRoom', (room) => { socket.leave(room); if (rooms[room] > 0) rooms[room]--; io.emit('playerCount', rooms); });
    socket.on('sendChat', (data) => { if (socket.user) { io.to(data.room).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); } });
    
    socket.on('placeSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        const user = await User.findById(socket.user._id);
        if (user.credits < data.amount) return;
        user.credits -= data.amount; await user.save();
        sharedTables.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: data.amount });
    });

    // --- CASHIER ACTIONS ---
    socket.on('submitTransaction', async (data) => { 
        if (socket.user) {
            await new Transaction({ username: socket.user.username, type: data.type, amount: data.amount, ref: data.ref }).save(); 
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); // Alert admin of new transaction live
        }
    });
    socket.on('getTransactions', async () => { 
        if (socket.user) {
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
        }
    });

    socket.on('disconnect', async () => {
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            pushAdminData();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
