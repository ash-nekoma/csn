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
    .then(async () => {
        console.log('✅ Connected to MongoDB Database');
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await new User({ username: 'admin', password: 'Kenm44ashley', role: 'Admin', credits: 10000 }).save();
            console.log('🛡️ Default Admin Account Created');
        }
    })
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
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, ref: String,
    status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({
    batchId: String, amount: Number, code: String,
    redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);

// NEW: Ledger Schema to track all credit movements
const creditLogSchema = new mongoose.Schema({
    username: String,
    action: String, 
    amount: Number,
    details: String,
    date: { type: Date, default: Date.now }
});
const CreditLog = mongoose.model('CreditLog', creditLogSchema);

// ==========================================
// 3. CASINO ENGINE & GLOBAL HISTORY / STATS
// ==========================================
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };
let connectedUsers = {}; 

let globalResults = { dice: [], coinflip: [], blackjack: [], baccarat: [], perya: [], dt: [], sicbo: [] };

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
    if (v === 'A') dt = 1; else if (v === 'K') dt = 13; else if (v === 'Q') dt = 12; else if (v === 'J') dt = 11; else dt = parseInt(v);

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

            setTimeout(async () => {
                let dtD = drawCard(), dtT = drawCard();
                let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
                logGlobalResult('dt', `${dtWin.toUpperCase()} WIN (${dtD.raw} TO ${dtT.raw})`);
                gameStats.dt.total++; gameStats.dt[dtWin]++;
                
                let sbR = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
                let sbSum = sbR[0] + sbR[1] + sbR[2];
                let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
                let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
                logGlobalResult('sicbo', sbTrip ? `TRIPLE ${sbR[0]}` : `${sbWin.toUpperCase()} (${sbSum})`);
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
                logGlobalResult('baccarat', `${bacWin.toUpperCase()} (${pS} TO ${bS})`);
                gameStats.baccarat.total++; gameStats.baccarat[bacWin]++;

                // Map Payouts and Build Ledger
                let playerStats = {}; 
                sharedTables.bets.forEach(b => {
                    let payout = 0;
                    if (b.room === 'dt') {
                        if (b.choice === dtWin) payout = b.amount * (dtWin === 'Tie' ? 9 : 2);
                    } 
                    else if (b.room === 'sicbo') {
                        if (b.choice === sbWin) payout = b.amount * 2;
                    } 
                    else if (b.room === 'perya') {
                        let matches = pyR.filter(c => c === b.choice).length;
                        if (matches > 0) payout = b.amount + (b.amount * matches);
                    } 
                    else if (b.room === 'baccarat') {
                        if (bacWin === 'Tie') {
                            if (b.choice === 'Tie') payout = b.amount * 9; 
                            else if (b.choice === 'Player' || b.choice === 'Banker') payout = b.amount * 1; 
                        } else if (bacWin === 'Player') {
                            if (b.choice === 'Player') payout = b.amount * 2;
                        } else if (bacWin === 'Banker') {
                            if (b.choice === 'Banker') payout = b.amount * 1.95; 
                        }
                    }

                    if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0, room: b.room };
                    playerStats[b.userId].amountBet += b.amount;
                    playerStats[b.userId].amountWon += payout;
                });

                Object.keys(playerStats).forEach(async (userId) => {
                    let st = playerStats[userId];
                    let user = await User.findById(userId);
                    if (user) {
                        user.credits += st.amountWon;
                        await user.save();
                        
                        let net = st.amountWon - st.amountBet;
                        if(net !== 0) {
                            await new CreditLog({ username: user.username, action: 'Game', amount: net, details: `Shared Table (${st.room})` }).save();
                        }

                        setTimeout(() => {
                            io.to(st.socketId).emit('balanceUpdateData', user.credits);
                        }, 1500);
                    }
                });

                io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin });
                io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin });
                io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR });
                io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, p3Drawn: p3Drawn, b3Drawn: b3Drawn });

            }, 500);

            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); 
                pushAdminData();
            }, 9000); 
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

    socket.on('requestBalanceRefresh', async () => {
        if(socket.user) {
            let u = await User.findById(socket.user._id);
            if(u) socket.emit('balanceUpdateData', u.credits);
        }
    });

    socket.on('getWalletLogs', async () => {
        if(socket.user) {
            const logs = await CreditLog.find({ username: socket.user.username }).sort({ date: -1 }).limit(50);
            socket.emit('walletLogsData', logs);
        }
    });

    socket.on('adminLogin', async (data) => {
        const user = await User.findOne({ username: data.username, password: data.password });
        if (user && user.role === 'Admin') {
            socket.join('admin_room'); 
            socket.emit('adminLoginSuccess', { username: user.username, role: user.role });
            await pushAdminData(socket);
        } else { 
            socket.emit('authError', 'Invalid Admin Credentials.'); 
        }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.rooms.has('admin_room')) return; 
        try {
            if (data.type === 'editUser') { await User.findByIdAndUpdate(data.id, { credits: data.credits, role: data.role }); }
            else if (data.type === 'ban') { await User.findByIdAndUpdate(data.id, { status: 'Banned' }); }
            else if (data.type === 'unban') { await User.findByIdAndUpdate(data.id, { status: 'Active' }); }
            else if (data.type === 'sendUpdate') { io.emit('notification', { title: 'System Announcement', msg: data.msg, type: 'ps-glow' }); }
            else if (data.type === 'giftCredits') {
                if (data.target === 'all_registered') {
                    await User.updateMany({}, { $inc: { credits: data.amount } });
                    io.emit('notification', { title: 'Gift Received!', msg: `Admin has gifted everyone ${data.amount} TC!`, type: 'success' });
                    io.emit('refreshBalance'); 
                } 
                else if (data.target === 'all_active') {
                    await User.updateMany({ status: 'Active' }, { $inc: { credits: data.amount } });
                    io.emit('notification', { title: 'Gift Received!', msg: `Admin has gifted all active players ${data.amount} TC!`, type: 'success' });
                    io.emit('refreshBalance');
                } 
                else {
                    let u = await User.findOne({ username: new RegExp('^' + data.target + '$', 'i') });
                    if (u) {
                        u.credits += data.amount; await u.save();
                        await new CreditLog({ username: u.username, action: 'Gift', amount: data.amount, details: `From Admin` }).save();
                        let targetSocketId = connectedUsers[u.username];
                        if (targetSocketId) {
                            io.to(targetSocketId).emit('notification', { title: 'Gift Received!', msg: `Admin has gifted you ${data.amount} TC!`, type: 'success' });
                            io.to(targetSocketId).emit('balanceUpdateData', u.credits);
                        }
                    }
                }
            }
            else if (data.type === 'resolveTx') {
                let tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; await tx.save();
                    let targetSocketId = connectedUsers[tx.username];
                    if (tx.type === 'Deposit' && data.status === 'Approved') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            u.credits += tx.amount; await u.save();
                            await new CreditLog({ username: u.username, action: 'Deposit', amount: tx.amount, details: `Approved` }).save();
                            if (targetSocketId) {
                                io.to(targetSocketId).emit('notification', { title: 'Deposit Approved', msg: `Your deposit of ${tx.amount} TC has been added to your balance.`, type: 'success' });
                                io.to(targetSocketId).emit('balanceUpdateData', u.credits);
                            }
                        }
                    }
                    else if (data.status === 'Rejected') {
                        if (tx.type === 'Withdrawal') {
                            let u = await User.findOne({ username: tx.username });
                            if (u) { 
                                u.credits += tx.amount; await u.save(); 
                                await new CreditLog({ username: u.username, action: 'Refund', amount: tx.amount, details: `Withdrawal Rejected` }).save();
                                if (targetSocketId) io.to(targetSocketId).emit('balanceUpdateData', u.credits); 
                            }
                        }
                        if (targetSocketId) { io.to(targetSocketId).emit('notification', { title: `${tx.type} Rejected`, msg: `Your ${tx.type} request for ${tx.amount} TC was rejected.`, type: 'error' }); }
                    }
                }
            }
            else if (data.type === 'createBatch') {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let existingBatches = await GiftCode.distinct('batchId');
                let nextNum = existingBatches.length + 1;
                let batchId = 'BATCH-' + String(nextNum).padStart(3, '0');
                
                for(let i=0; i<data.count; i++) {
                    let code = '';
                    for(let j=0; j<10; j++) code += chars.charAt(Math.floor(Math.random() * chars.length));
                    await new GiftCode({ batchId, amount: data.amount, code }).save();
                }
            }
            else if (data.type === 'deleteBatch') { await GiftCode.deleteMany({ batchId: data.batchId }); }
            await pushAdminData();
        } catch(e) { console.error("Admin Action Error:", e); }
    });

    socket.on('login', async (data) => {
        try {
            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            if (isNaN(user.credits) || user.credits === null) user.credits = 0;

            user.status = 'Active'; await user.save(); socket.user = user;
            connectedUsers[user.username] = socket.id;
            pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            
            socket.emit('loginSuccess', { username: user.username, credits: user.credits, role: user.role, daily: { canClaim, day, nextClaim } });
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
        
        await new CreditLog({ username: user.username, action: 'Daily', amount: amt, details: `Day ${day} Claim` }).save();
        pushAdminData();
        socket.emit('dailyClaimed', { amt, newBalance: user.credits, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    });

    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOne({ code: code });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid Code' });
            if (gc.redeemedBy) return socket.emit('promoResult', { success: false, msg: 'Code already used' });

            gc.redeemedBy = socket.user.username; await gc.save();
            const user = await User.findById(socket.user._id);
            user.credits += gc.amount; await user.save();
            
            await new CreditLog({ username: user.username, action: 'Promo', amount: gc.amount, details: `Code Redeemed` }).save();
            pushAdminData();
            socket.emit('promoResult', { success: true, amt: gc.amount });
            socket.emit('balanceUpdateData', user.credits);
        } catch(e) { socket.emit('promoResult', { success: false, msg: 'Server error' }); }
    });

    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: gameStats[game] || { total: 0 } });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        
        let isNewBet = (data.game === 'dice' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
        if (isNewBet) {
            if (!data.bet || data.bet <= 0 || user.credits < data.bet) return socket.emit('toast', { msg: 'Insufficient TC or Invalid Bet', type: 'error' });
            user.credits -= data.bet; await user.save();
        }

        let payout = 0;

        if (data.game === 'dice') {
            gameStats.dice.total++;
            let roll = Math.floor(Math.random() * 100) + 1;
            if (roll > 50) { payout = data.bet * 2; gameStats.dice.Win++; } else { gameStats.dice.Lose++; }
            user.credits += payout; await user.save();
            await new CreditLog({ username: user.username, action: 'Game', amount: payout - data.bet, details: `Solo Dice` }).save();
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
            await new CreditLog({ username: user.username, action: 'Game', amount: payout - data.bet, details: `Solo Coinflip` }).save();
            logGlobalResult('coinflip', result);
            pushAdminData();
            socket.emit('coinResult', { result, payout, bet: data.bet, newBalance: user.credits });
        }
        else if (data.game === 'blackjack') {
            if (data.action === 'start') {
                gameStats.blackjack.total++; 
                socket.bjState = { bet: data.bet, pHand: [drawCard(), drawCard()], dHand: [drawCard(), drawCard()] };
                let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                
                if (pS === 21) {
                    let msg = dS === 21 ? 'Push' : 'Blackjack!';
                    payout = dS === 21 ? data.bet : data.bet * 2.5;
                    if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++;
                    user.credits += payout; await user.save();
                    await new CreditLog({ username: user.username, action: 'Game', amount: payout - data.bet, details: `Solo Blackjack` }).save();
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
                let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                
                if (pS > 21) {
                    gameStats.blackjack.Lose++;
                    await new CreditLog({ username: user.username, action: 'Game', amount: -socket.bjState.bet, details: `Solo Blackjack` }).save();
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
                await new CreditLog({ username: user.username, action: 'Game', amount: payout - socket.bjState.bet, details: `Solo Blackjack` }).save();
                let logMsg = (dS > 21) ? 'DEALER BUSTS!' : msg.toUpperCase();
                logGlobalResult('blackjack', `${logMsg} (${pS} TO ${dS})`);
                pushAdminData();
                socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: socket.bjState.bet, newBalance: user.credits });
                socket.bjState = null;
            }
        }
    });

    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); rooms[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; rooms[room]++; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); socket.currentRoom = null;
        if (rooms[room] > 0) rooms[room]--; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', (data) => { 
        if (socket.user && socket.currentRoom) { 
            io.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); 
        } 
    });
    
    socket.on('placeSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        const user = await User.findById(socket.user._id);
        if (user.credits < data.amount) return;
        user.credits -= data.amount; await user.save();
        sharedTables.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: data.amount });
    });

    socket.on('submitTransaction', async (data) => { 
        if (socket.user) {
            await new Transaction({ username: socket.user.username, type: data.type, amount: data.amount, ref: data.ref }).save(); 
            if(data.type === 'Withdrawal') {
                await new CreditLog({ username: socket.user.username, action: 'Withdrawal', amount: -data.amount, details: `Requested` }).save();
            }
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); 
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
            delete connectedUsers[socket.user.username];
        }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) {
            rooms[socket.currentRoom]--;
            io.emit('playerCount', rooms);
        }
        pushAdminData();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
