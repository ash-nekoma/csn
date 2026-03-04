require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const formatTC = (amount) => Math.round(amount * 10) / 10;

async function deductBet(user, betAmount) {
    let amt = formatTC(betAmount);
    if (amt <= 0) return false;
    
    let totalBal = formatTC(user.credits + user.playableCredits);
    if (totalBal < amt) return false;

    if (user.playableCredits >= amt) {
        user.playableCredits = formatTC(user.playableCredits - amt);
    } else {
        let remainder = formatTC(amt - user.playableCredits);
        user.playableCredits = 0;
        user.credits = formatTC(user.credits - remainder);
    }
    return true;
}

// ==========================================
// MONGODB SETUP
// ==========================================
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB Database');
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
        await new User({ username: 'admin', password: 'Kenm44ashley', role: 'Admin', credits: 10000, playableCredits: 0 }).save();
    }
}).catch(err => console.error(err));

// ==========================================
// SCHEMAS
// ==========================================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    sessionToken: { type: String, default: null },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    playableCredits: { type: Number, default: 0 }, 
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
    batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' },
    redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);

const creditLogSchema = new mongoose.Schema({
    username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now }
});
const CreditLog = mongoose.model('CreditLog', creditLogSchema);

// ==========================================
// ENGINE & STATS
// ==========================================
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };
let connectedUsers = {}; 
let globalResults = { d20: [], coinflip: [], blackjack: [], baccarat: [], perya: [], dt: [], sicbo: [] };

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
    dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
    perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 },
    d20: { total: 0, Win: 0, Lose: 0 },
    blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

function logGlobalResult(game, resultStr) {
    globalResults[game].unshift({ result: resultStr, time: new Date() });
    if (globalResults[game].length > 5) globalResults[game].pop(); 
}

function checkResetStats(game) {
    if (gameStats[game].total >= 100) Object.keys(gameStats[game]).forEach(key => gameStats[game][key] = 0);
}

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[Math.floor(Math.random() * vs.length)];
    let s = ss[Math.floor(Math.random() * ss.length)];
    
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = (v === 'A') ? 1 : (v === 'K' ? 13 : (v === 'Q' ? 12 : (v === 'J' ? 11 : parseInt(v))));
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { 
        score += card.bjVal; 
        if (card.val === 'A') aces += 1; 
    }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// ==========================================
// SHARED TABLES LOOP
// ==========================================
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            setTimeout(async () => {
                // DRAGON TIGER
                let dtD = drawCard(), dtT = drawCard();
                let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
                let dtResStr = dtWin === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `DRAGON (${dtD.raw} TO ${dtT.raw})`;
                if(dtWin==='Tiger') dtResStr = `TIGER (${dtT.raw} TO ${dtD.raw})`;
                logGlobalResult('dt', dtResStr);
                gameStats.dt.total++; gameStats.dt[dtWin]++;
                
                // SIC BO
                let sbR = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
                let sbSum = sbR[0] + sbR[1] + sbR[2];
                let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
                let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
                let sbResStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${sbWin.toUpperCase()} (${sbSum})`;
                logGlobalResult('sicbo', sbResStr);
                gameStats.sicbo.total++; gameStats.sicbo[sbWin]++;

                // PERYA
                const cols = ['Yellow','White','Pink','Blue','Red','Green'];
                let pyR = [cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)], cols[Math.floor(Math.random()*6)]];
                logGlobalResult('perya', pyR.join(','));
                gameStats.perya.total++; pyR.forEach(c => gameStats.perya[c]++);

                // BACCARAT
                let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
                let pS = (pC[0].bacVal + pC[1].bacVal) % 10; let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
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
                let bacResStr = bacWin === 'Tie' ? `TIE (${pS} TO ${bS})` : `${bacWin.toUpperCase()} (${bacWin==='Player'?pS:bS} TO ${bacWin==='Player'?bS:pS})`;
                logGlobalResult('baccarat', bacResStr);
                gameStats.baccarat.total++; gameStats.baccarat[bacWin]++;

                let playerStats = {}; 
                sharedTables.bets.forEach(b => {
                    let payout = 0;
                    if (b.room === 'dt') { 
                        if (dtWin === 'Tie') { payout = (b.choice === 'Tie') ? b.amount * 9 : b.amount; } 
                        else if (b.choice === dtWin) payout = b.amount * 2;
                    } 
                    else if (b.room === 'sicbo') { if (b.choice === sbWin) payout = b.amount * 2; } 
                    else if (b.room === 'perya') {
                        let matches = pyR.filter(c => c === b.choice).length;
                        if (matches > 0) payout = b.amount + (b.amount * matches);
                    } 
                    else if (b.room === 'baccarat') {
                        if (bacWin === 'Tie') { payout = (b.choice === 'Tie') ? b.amount * 9 : b.amount; } 
                        else if (bacWin === 'Player' && b.choice === 'Player') { payout = b.amount * 2; } 
                        else if (bacWin === 'Banker' && b.choice === 'Banker') { payout = b.amount * 1.95; }
                    }

                    if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0, room: b.room };
                    playerStats[b.userId].amountBet += b.amount;
                    playerStats[b.userId].amountWon += formatTC(payout);
                });

                let roomNames = { 'perya': 'COLOR GAME', 'dt': 'DRAGON TIGER', 'sicbo': 'SIC BO', 'baccarat': 'BACCARAT' };

                Object.keys(playerStats).forEach(async (userId) => {
                    let st = playerStats[userId];
                    let user = await User.findById(userId);
                    if (user && st.amountWon > 0) {
                        user.credits = formatTC(user.credits + st.amountWon);
                        await user.save();
                        let net = formatTC(st.amountWon - st.amountBet);
                        if(net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: roomNames[st.room] }).save();
                    }
                });

                io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin, resStr: dtResStr, stats: gameStats.dt });
                io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin, resStr: sbResStr, stats: gameStats.sicbo });
                io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR, stats: gameStats.perya });
                io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, resStr: bacResStr, p3Drawn: p3Drawn, b3Drawn: b3Drawn, stats: gameStats.baccarat });

                checkResetStats('dt'); checkResetStats('sicbo'); checkResetStats('perya'); checkResetStats('baccarat');

            }, 500);

            setTimeout(() => {
                sharedTables.time = 15; sharedTables.status = 'BETTING'; sharedTables.bets = [];
                io.emit('newRound'); pushAdminData();
            }, 9000); 
        }
    }
}, 1000);

async function pushAdminData(target = io.to('admin_room')) {
    try {
        const users = await User.find(); 
        const txs = await Transaction.find().sort({ date: -1 }); 
        const gcs = await GiftCode.find().sort({ date: -1 });
        let totalEconomy = formatTC(users.reduce((a, b) => a + (b.credits || 0) + (b.playableCredits || 0), 0));
        let approvedDeposits = txs.filter(t => t.type === 'Deposit' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);

        target.emit('adminDataSync', { users, transactions: txs, giftBatches: gcs, stats: { economy: totalEconomy, approvedDeposits: formatTC(approvedDeposits), limit: 2000000 } });
    } catch(e) {}
}

io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);

    socket.on('tokenLogin', async (token) => {
        const user = await User.findOne({ sessionToken: token, status: { $ne: 'Banned' } });
        if(user) {
            user.status = 'Active'; await user.save(); socket.user = user;
            connectedUsers[user.username] = socket.id;
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            socket.emit('loginSuccess', { username: user.username, credits: formatTC(user.credits), playable: formatTC(user.playableCredits), role: user.role, sessionToken: user.sessionToken, daily: { canClaim, day, nextClaim } });
        }
    });

    socket.on('requestBalanceRefresh', async () => {
        if(socket.user) {
            let u = await User.findById(socket.user._id);
            if(u) socket.emit('balanceUpdateData', { credits: formatTC(u.credits), playable: formatTC(u.playableCredits) });
        }
    });

    socket.on('getWalletLogs', async () => {
        if(socket.user) {
            const logs = await CreditLog.find({ username: socket.user.username }).sort({ date: -1 }).limit(50);
            const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
            const todayLogs = await CreditLog.find({ username: socket.user.username, date: { $gte: startOfDay }});
            let dailyProfit = 0; todayLogs.forEach(l => { if (l.action === 'GAME') dailyProfit += l.amount; });
            socket.emit('walletLogsData', { logs, dailyProfit: formatTC(dailyProfit) });
        }
    });

    socket.on('clearWalletLogs', async () => {
        if(socket.user) {
            await CreditLog.deleteMany({ username: socket.user.username });
            socket.emit('walletLogsData', { logs: [], dailyProfit: 0 });
        }
    });

    socket.on('fetchUserLogs', async (username) => {
        if (!socket.rooms.has('admin_room')) return;
        const logs = await CreditLog.find({ username }).sort({ date: -1 }).limit(100);
        socket.emit('userLogsData', { username, logs });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        if (!socket.user) return;
        
        try {
            const user = await User.findById(socket.user._id);
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            
            if (isNewBet) {
                if (!data.bet || isNaN(data.bet) || data.bet <= 0) return socket.emit('localGameError', { msg: 'INVALID BET', game: data.game });
                let betSuccess = await deductBet(user, data.bet);
                if (!betSuccess) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game });
                await user.save();
            }

            let payout = 0;

            if (data.game === 'd20') {
                gameStats.d20.total++;
                let roll = Math.floor(Math.random() * 20) + 1;
                let win = false, multiplier = 0;
                
                if (data.guessType === 'exact') { if (roll === parseInt(data.guessValue)) { win = true; multiplier = 18; } } 
                else if (data.guessType === 'highlow') { if ((data.guessValue === 'high' && roll >= 11) || (data.guessValue === 'low' && roll <= 10)) { win = true; multiplier = 1.95; } } 
                else if (data.guessType === 'oddeven') { if ((data.guessValue === 'even' && roll % 2 === 0) || (data.guessValue === 'odd' && roll % 2 !== 0)) { win = true; multiplier = 1.95; } }
                
                if (win) { payout = formatTC(data.bet * multiplier); gameStats.d20.Win++; } else { gameStats.d20.Lose++; }
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `D20` }).save();
                let resStr = `ROLLED ${roll}`; logGlobalResult('d20', resStr); pushAdminData();
                socket.emit('d20Result', { roll, payout, bet: data.bet, guessType: data.guessType, guessValue: data.guessValue, resStr, newBalance: { credits: user.credits, playable: user.playableCredits }, stats: gameStats.d20 });
                checkResetStats('d20');
            } 
            else if (data.game === 'coinflip') {
                gameStats.coinflip.total++;
                let result = Math.random() < 0.5 ? 'Heads' : 'Tails';
                gameStats.coinflip[result]++;
                if (data.choice === result) payout = formatTC(data.bet * 1.95);
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `COIN FLIP` }).save();
                let resStr = `LANDED ${result.toUpperCase()}`; logGlobalResult('coinflip', resStr); pushAdminData();
                socket.emit('coinResult', { result, payout, bet: data.bet, choice: data.choice, resStr, newBalance: { credits: user.credits, playable: user.playableCredits }, stats: gameStats.coinflip });
                checkResetStats('coinflip');
            }
            else if (data.game === 'blackjack') {
                if (data.action === 'start') {
                    gameStats.blackjack.total++; 
                    let dCard1 = drawCard(), dCardHidden = drawCard(); 
                    socket.bjState = { bet: data.bet, pHand: [drawCard(), drawCard()], dHand: [dCard1, dCardHidden] };
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    
                    if (pS === 21) {
                        let msg = dS === 21 ? 'Push' : 'Blackjack!';
                        payout = formatTC(dS === 21 ? data.bet : data.bet * 2.5);
                        if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++;
                        user.credits = formatTC(user.credits + payout); await user.save();
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `BLACKJACK` }).save();
                        
                        let resStr = `BLACKJACK! (21 TO ${dS})`; logGlobalResult('blackjack', resStr); pushAdminData();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr, bet: data.bet, newBalance: { credits: user.credits, playable: user.playableCredits }, stats: gameStats.blackjack });
                        socket.bjState = null; checkResetStats('blackjack');
                    } else {
                        // Mask the hidden card securely for the client payload
                        let maskedDHand = [dCard1, {val: '?', suit: '?', raw: '?', suitHtml: `<div class="card-back" style="width:100%;height:100%;border-radius:6px;"></div>`, bacVal: 0, bjVal: 0, dtVal: 0}];
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: maskedDHand });
                    }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard());
                    let pS = getBJScore(socket.bjState.pHand); 
                    
                    if (pS > 21) {
                        gameStats.blackjack.Lose++;
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `BLACKJACK` }).save();
                        
                        let dS = getBJScore(socket.bjState.dHand);
                        let resStr = `BUST (${pS} TO ${dS})`; logGlobalResult('blackjack', resStr);
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }, stats: gameStats.blackjack });
                        socket.bjState = null; checkResetStats('blackjack');
                    } else {
                        socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand });
                    }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    
                    let dS = getBJScore(socket.bjState.dHand); let msg = '';
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win!'; gameStats.blackjack.Win++; } 
                    else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; gameStats.blackjack.Push++; } 
                    else { msg = 'Dealer Wins'; gameStats.blackjack.Lose++; }
                    
                    user.credits = formatTC(user.credits + payout); await user.save();
                    await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `BLACKJACK` }).save();
                    
                    let resStr = (dS > 21) ? `DEALER BUSTS (${pS} TO ${dS})` : `PLAYER (${pS} TO ${dS})`;
                    if (dS >= pS && dS <= 21) resStr = `DEALER (${dS} TO ${pS})`;
                    if (pS === dS) resStr = `PUSH (${pS} TO ${dS})`;

                    logGlobalResult('blackjack', resStr); pushAdminData();
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }, stats: gameStats.blackjack });
                    socket.bjState = null; checkResetStats('blackjack');
                }
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); rooms[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; rooms[room]++; io.emit('playerCount', rooms); 
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); socket.currentRoom = null;
        if (rooms[room] > 0) rooms[room]--; io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', (data) => { 
        if (socket.user && socket.currentRoom) { 
            let safeText = data.msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            io.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: safeText, sys: false }); 
        } 
    });
    
    socket.on('placeSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        if (data.amount <= 0) return socket.emit('localGameError', { msg: 'INVALID BET', game: data.room });
        
        try {
            const user = await User.findById(socket.user._id);
            let betSuccess = await deductBet(user, data.amount);
            if (!betSuccess) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room });
            
            await user.save();
            sharedTables.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: formatTC(data.amount) });
        } catch(e) {}
    });

    socket.on('undoSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        try {
            for (let i = sharedTables.bets.length - 1; i >= 0; i--) {
                let b = sharedTables.bets[i];
                if (b.userId.toString() === socket.user._id.toString() && b.room === data.room) {
                    let user = await User.findById(socket.user._id);
                    if (user) {
                        user.credits = formatTC(user.credits + b.amount); await user.save();
                        socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                        socket.emit('undoSuccess', { choice: b.choice, amount: b.amount });
                    }
                    sharedTables.bets.splice(i, 1);
                    break;
                }
            }
        } catch(e) {}
    });

    socket.on('submitTransaction', async (data) => { 
        if (socket.user) {
            let amount = formatTC(data.amount);
            if(amount <= 0) return;
            await new Transaction({ username: socket.user.username, type: data.type, amount: amount, ref: data.ref }).save(); 
            await new CreditLog({ username: socket.user.username, action: data.type.toUpperCase(), amount: (data.type === 'Withdrawal' ? -amount : amount), details: `PENDING` }).save();
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); 
        }
    });

    socket.on('getTransactions', async () => { 
        if (socket.user) socket.emit('transactionsData', await Transaction.find({ username: socket.user.username }).sort({ date: -1 }));
    });

    socket.on('clearResolvedRequests', async () => {
        if (socket.user) {
            await Transaction.deleteMany({ username: socket.user.username, status: { $in: ['Approved', 'Rejected'] } });
            socket.emit('transactionsData', await Transaction.find({ username: socket.user.username }).sort({ date: -1 }));
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
            if (data.type === 'editUser') { await User.findByIdAndUpdate(data.id, { credits: formatTC(data.credits), playableCredits: formatTC(data.playableCredits), role: data.role }); }
            else if (data.type === 'ban') { await User.findByIdAndUpdate(data.id, { status: 'Banned' }); }
            else if (data.type === 'unban') { await User.findByIdAndUpdate(data.id, { status: 'Active' }); }
            else if (data.type === 'clearUserLogs') {
                await CreditLog.deleteMany({ username: data.username });
                const logs = await CreditLog.find({ username: data.username }).sort({ date: -1 }).limit(100);
                socket.emit('userLogsData', { username: data.username, logs });
            }
            else if (data.type === 'sendUpdate') { 
                io.emit('silentNotification', { id: Date.now(), title: 'System Announcement', msg: data.msg, date: new Date() }); 
            }
            else if (data.type === 'giftCredits') {
                let amount = formatTC(data.amount);
                let updateQuery = data.creditType === 'playable' ? { $inc: { playableCredits: amount } } : { $inc: { credits: amount } };
                let notifMsg = `Admin has gifted you ${amount} ${data.creditType === 'playable' ? 'Playable TC' : 'TC'}!`;

                if (data.target === 'all_registered') {
                    await User.updateMany({}, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('refreshBalance'); 
                } 
                else if (data.target === 'all_active') {
                    await User.updateMany({ status: 'Active' }, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('refreshBalance');
                } 
                else {
                    let u = await User.findOne({ username: new RegExp('^' + data.target + '$', 'i') });
                    if (u) {
                        if(data.creditType === 'playable') u.playableCredits = formatTC(u.playableCredits + amount);
                        else u.credits = formatTC(u.credits + amount);
                        await u.save();
                        await new CreditLog({ username: u.username, action: 'GIFT', amount: amount, details: `ADMIN GIFT` }).save();
                        let targetSocketId = connectedUsers[u.username];
                        if (targetSocketId) {
                            io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                            io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
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
                            u.credits = formatTC(u.credits + tx.amount); await u.save();
                            await new CreditLog({ username: u.username, action: 'DEPOSIT', amount: tx.amount, details: `APPROVED` }).save();
                            if (targetSocketId) {
                                io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Deposit Approved', msg: `Your deposit of ${tx.amount} TC has been added to your balance.`, date: new Date() });
                                io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                            }
                        }
                    }
                    else if (data.status === 'Rejected') {
                        if (tx.type === 'Withdrawal') {
                            let u = await User.findOne({ username: tx.username });
                            if (u) { 
                                u.credits = formatTC(u.credits + tx.amount); await u.save(); 
                                await new CreditLog({ username: u.username, action: 'WITHDRAWAL', amount: tx.amount, details: `REJECTED (REFUND)` }).save();
                                if (targetSocketId) io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); 
                            }
                        }
                        if (targetSocketId) { io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: `${tx.type} Rejected`, msg: `Your request was rejected.`, date: new Date() }); }
                    }
                }
            }
            else if (data.type === 'createBatch') {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let prefix = data.creditType === 'playable' ? 'PB-' : 'RB-';
                let existingBatches = await GiftCode.find({ batchId: new RegExp('^' + prefix) }).distinct('batchId');
                let nextNum = existingBatches.length + 1;
                let batchId = prefix + String(nextNum).padStart(3, '0');
                
                for(let i=0; i<data.count; i++) {
                    let code = '';
                    for(let j=0; j<10; j++) code += chars.charAt(Math.floor(Math.random() * chars.length));
                    await new GiftCode({ batchId, amount: formatTC(data.amount), code, creditType: data.creditType }).save();
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
            if (isNaN(user.playableCredits) || user.playableCredits === null) user.playableCredits = 0;

            user.status = 'Active'; 
            user.sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36); // Generate persistent session
            await user.save(); 
            socket.user = user; connectedUsers[user.username] = socket.id;
            pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            
            socket.emit('loginSuccess', { username: user.username, credits: formatTC(user.credits), playable: formatTC(user.playableCredits), role: user.role, sessionToken: user.sessionToken, daily: { canClaim, day, nextClaim } });
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
        let amt = formatTC(rewards[day - 1]);

        // Fix: Funnels directly to Playable Credits
        user.playableCredits = formatTC(user.playableCredits + amt); 
        user.dailyReward.lastClaim = now; user.dailyReward.streak += 1;
        await user.save();
        
        await new CreditLog({ username: user.username, action: 'GIFT', amount: amt, details: `DAILY REWARD` }).save();
        pushAdminData();
        socket.emit('dailyClaimed', { amt, newBalance: { credits: user.credits, playable: user.playableCredits }, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    });

    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOne({ code: code });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid Code' });
            if (gc.redeemedBy) return socket.emit('promoResult', { success: false, msg: 'Code already used' });

            gc.redeemedBy = socket.user.username; await gc.save();
            const user = await User.findById(socket.user._id);
            
            if(gc.creditType === 'playable') {
                user.playableCredits = formatTC(user.playableCredits + gc.amount);
            } else {
                user.credits = formatTC(user.credits + gc.amount);
            }
            await user.save();
            
            await new CreditLog({ username: user.username, action: 'CODE', amount: gc.amount, details: `REDEEMED` }).save();
            pushAdminData();
            socket.emit('promoResult', { success: true, amt: gc.amount, type: gc.creditType });
            socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
        } catch(e) { socket.emit('promoResult', { success: false, msg: 'Server error' }); }
    });

    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: gameStats[game] || { total: 0 } });
    });

    socket.on('disconnect', async () => {
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            delete connectedUsers[socket.user.username];
        }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) {
            rooms[socket.currentRoom]--; io.emit('playerCount', rooms);
        }
        pushAdminData();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
