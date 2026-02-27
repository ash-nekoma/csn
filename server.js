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

// --- MONGODB SETUP ---
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(e => console.log('❌ DB Error:', e));

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, // Strictly starts at 0
    status: { type: String, default: 'Offline' },
    joinDate: { type: Date, default: Date.now },
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, ref: String, status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({
    batchId: String, amount: Number, code: String, redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);

// --- CASINO ENGINE & HISTORY ---
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };

// Global Results History (Last 25 per game)
let globalResults = { dice: [], coinflip: [], blackjack: [], baccarat: [], perya: [], dt: [], sicbo: [] };

function logGlobalResult(game, resultStr) {
    globalResults[game].unshift({ result: resultStr, time: new Date() });
    if(globalResults[game].length > 25) globalResults[game].pop();
}

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'], ss = ['♠','♣','♥','♦'];
    let v = vs[Math.floor(Math.random() * vs.length)], s = ss[Math.floor(Math.random() * ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    return { val: v, suit: s, bacVal: bac, bjVal: bj };
}

// Global 15-Second Loop
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            // --- RNG OUTCOMES ---
            let dtD = drawCard(), dtT = drawCard();
            let dtWin = dtD.bjVal > dtT.bjVal ? 'Dragon' : (dtT.bjVal > dtD.bjVal ? 'Tiger' : 'Tie');
            logGlobalResult('dt', `${dtWin} Win`);
            
            let sbR = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
            let sbSum = sbR[0] + sbR[1] + sbR[2], sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
            let sbWin = sbTrip ? 'None' : (sbSum <= 10 ? 'Small' : 'Big');
            logGlobalResult('sicbo', sbTrip ? `Triple ${sbR[0]}` : `${sbWin} (${sbSum})`);

            const cols = ['Yellow','White','Pink','Blue','Red','Green'];
            let pyR = [cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)]];
            logGlobalResult('perya', pyR.join(', '));

            let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
            let pS = (pC[0].bacVal + pC[1].bacVal) % 10, bS = (bC[0].bacVal + bC[1].bacVal) % 10;
            if (pS < 8 && bS < 8) {
                let p3Val = -1;
                if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; }
                let bDraws = false;
                if (pC.length === 2) { if (bS <= 5) bDraws = true; }
                else {
                    if (bS <= 2) bDraws = true;
                    else if (bS === 3 && p3Val !== 8) bDraws = true;
                    else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                    else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                    else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
                }
                if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; }
            }
            let bacWin = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
            logGlobalResult('baccarat', `${bacWin} Win`);

            // --- CALCULATE PAYOUTS ---
            let playerPayouts = {}; 
            
            sharedTables.bets.forEach(b => {
                let payout = 0;
                if(b.room === 'dt' && b.choice === dtWin) payout = b.amount * (dtWin === 'Tie' ? 8 : 2);
                if(b.room === 'sicbo' && b.choice === sbWin) payout = b.amount * 2;
                if(b.room === 'perya') { let matches = pyR.filter(c => c === b.choice).length; if(matches > 0) payout = b.amount + (b.amount * matches); }
                if(b.room === 'baccarat' && b.choice === bacWin) payout = b.amount * (bacWin === 'Tie' ? 8 : (bacWin === 'Banker' ? 1.95 : 2));

                if(payout > 0) {
                    if(!playerPayouts[b.userId]) playerPayouts[b.userId] = { socketId: b.socketId, amount: 0 };
                    playerPayouts[b.userId].amount += payout;
                }
            });

            // Delay Database Payout & Balance Update (Wait for animations to finish!)
            Object.keys(playerPayouts).forEach(async (userId) => {
                let user = await User.findById(userId);
                if(user) {
                    user.credits += playerPayouts[userId].amount;
                    await user.save();
                    
                    setTimeout(() => {
                        io.to(playerPayouts[userId].socketId).emit('balanceUpdate', user.credits);
                    }, 5000); // Trigger balance update perfectly timed with animation end
                }
            });

            // --- BROADCAST RESULTS ---
            io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin });
            io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin });
            io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR });
            io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, winner: bacWin });

            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound');
            }, 6000); 
        }
    }
}, 1000);

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);

    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.username, password: data.password });
        if (!user) return socket.emit('authError', 'Invalid login credentials.');
        if (user.status === 'Banned') return socket.emit('authError', 'This account is banned.');
        user.status = 'Active'; await user.save();
        socket.user = user;
        
        let now = new Date(), nextClaim = null, canClaim = true, day = 1;
        if (user.dailyReward.lastClaim) {
            let diffHours = (now - user.dailyReward.lastClaim) / 36e5;
            if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 3600000); } 
            else if (diffHours > 48) user.dailyReward.streak = 0;
            day = (user.dailyReward.streak % 7) + 1;
        }

        socket.emit('loginSuccess', { username: user.username, credits: user.credits, daily: { canClaim, day, nextClaim } });
    });

    socket.on('register', async (data) => {
        if(await User.findOne({ username: data.username })) return socket.emit('authError', 'Username taken.');
        await new User({ username: data.username, password: data.password }).save();
        socket.emit('registerSuccess', 'Account created! Please login.');
    });

    socket.on('claimDaily', async () => {
        if(!socket.user) return;
        const user = await User.findById(socket.user._id);
        let now = new Date();
        if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim)/36e5 < 24) return;

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [25, 50, 100, 200, 500, 750, 1000];
        let amt = rewards[day - 1];

        user.credits += amt; user.dailyReward.lastClaim = now; user.dailyReward.streak += 1; await user.save();
        let nextClaim = new Date(now.getTime() + 24 * 3600000);
        
        socket.emit('dailyClaimed', { amt, newBalance: user.credits, nextClaim });
        socket.emit('balanceUpdate', user.credits);
    });

    socket.on('redeemPromo', async (code) => {
        if(!socket.user) return;
        const gc = await GiftCode.findOne({ code: code });
        if(!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid Code' });
        if(gc.redeemedBy) return socket.emit('promoResult', { success: false, msg: 'Used' });

        gc.redeemedBy = socket.user.username; await gc.save();
        const user = await User.findById(socket.user._id);
        user.credits += gc.amount; await user.save();
        
        socket.emit('promoResult', { success: true, amt: gc.amount });
        socket.emit('balanceUpdate', user.credits);
    });

    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { game: game, results: globalResults[game] });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        if(!socket.user) return;
        const user = await User.findById(socket.user._id);
        
        if(user.credits < data.bet) return socket.emit('toast', {msg:'Insufficient TC', type:'error'});
        user.credits -= data.bet;
        let payout = 0;

        if(data.game === 'dice') {
            let roll = Math.floor(Math.random() * 100) + 1;
            if(roll > 50) payout = data.bet * 2;
            user.credits += payout; await user.save();
            logGlobalResult('dice', `Rolled ${roll}`);
            socket.emit('diceResult', { roll, payout, bet: data.bet, newBalance: user.credits });
        } 
        else if(data.game === 'coinflip') {
            let result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            if(data.choice === result) payout = data.bet * 2;
            user.credits += payout; await user.save();
            logGlobalResult('coinflip', result);
            socket.emit('coinResult', { result, payout, bet: data.bet, newBalance: user.credits });
        }
        else if(data.game === 'blackjack') {
            if(data.action === 'start') {
                await user.save();
                socket.bjState = { bet: data.bet, pHand: [drawCard(), drawCard()], dHand: [drawCard(), drawCard()] };
                
                // Instant Bust check on Deal
                let pS = socket.bjState.pHand.reduce((a,b)=>a+b.bjVal,0);
                if(pS === 21) {
                    let dS = socket.bjState.dHand.reduce((a,b)=>a+b.bjVal,0);
                    let msg = dS === 21 ? 'Push' : 'Blackjack!';
                    payout = dS === 21 ? data.bet : data.bet * 2.5;
                    user.credits += payout; await user.save();
                    logGlobalResult('blackjack', msg);
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: data.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand });
                }
            }
            if(data.action === 'hit' && socket.bjState) {
                socket.bjState.pHand.push(drawCard());
                let pS = socket.bjState.pHand.reduce((a,b)=>a+b.bjVal,0);
                
                if(pS > 21) {
                    // Instant Bust
                    logGlobalResult('blackjack', 'Bust!');
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', bet: socket.bjState.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand });
                }
            }
            if(data.action === 'stand' && socket.bjState) {
                let pS = socket.bjState.pHand.reduce((a,b)=>a+b.bjVal,0);
                while(socket.bjState.dHand.reduce((a,b)=>a+b.bjVal,0) < 17) socket.bjState.dHand.push(drawCard());
                let dS = socket.bjState.dHand.reduce((a,b)=>a+b.bjVal,0);
                let msg = '';
                
                if(pS > 21) msg = 'Bust!';
                else if(dS > 21 || pS > dS) { payout = socket.bjState.bet * 2; msg = 'You Win!'; }
                else if(pS === dS) { payout = socket.bjState.bet; msg = 'Push'; }
                else msg = 'Dealer Wins';
                
                user.credits += payout; await user.save();
                logGlobalResult('blackjack', msg);
                socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: socket.bjState.bet, newBalance: user.credits });
                socket.bjState = null;
            }
        }
    });

    socket.on('joinRoom', (room) => { socket.join(room); rooms[room]++; io.emit('playerCount', rooms); });
    socket.on('leaveRoom', (room) => { socket.leave(room); if(rooms[room]>0) rooms[room]--; io.emit('playerCount', rooms); });
    socket.on('sendChat', (data) => { if(socket.user) io.to(data.room).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); });

    socket.on('placeSharedBet', async (data) => {
        if(!socket.user || sharedTables.status !== 'BETTING') return;
        const user = await User.findById(socket.user._id);
        if(user.credits < data.amount) return socket.emit('toast', {msg:'Insufficient TC', type:'error'});
        user.credits -= data.amount; await user.save();
        sharedTables.bets.push({ userId: user._id, socketId: socket.id, room: data.room, choice: data.choice, amount: data.amount });
    });

    // Cashier
    socket.on('submitTransaction', async (data) => { if(socket.user) await new Transaction({ username: socket.user.username, type: data.type, amount: data.amount, ref: data.ref }).save(); });
    socket.on('getTransactions', async () => { if(socket.user) socket.emit('transactionsData', await Transaction.find({ username: socket.user.username }).sort({ date: -1 })); });

    socket.on('adminLogin', async (data) => {
        if (data.username === 'admin' && data.password === 'admin') {
            socket.emit('adminLoginSuccess', { username: 'Admin Boss', role: 'Head Admin' });
            const users = await User.find(); const txs = await Transaction.find(); const gcs = await GiftCode.find();
            socket.emit('adminDataSync', { users, transactions: txs, giftBatches: gcs, stats: { economy: users.reduce((a,b)=>a+b.credits,0) } });
        } else { socket.emit('authError', 'Invalid Admin Credentials.'); }
    });

    socket.on('disconnect', async () => { if(socket.user) await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); });
});

server.listen(process.env.PORT || 3000, () => console.log('🚀 Server running.'));
