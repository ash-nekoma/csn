require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let isMaintenanceMode = false;
let globalBankVault = 2000000;
let currentRadio = { url: null, startTime: 0, requestedBy: null };

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const formatTC = (amount) => Math.round(parseFloat(amount) * 10) / 10;

function sendPulse(msg, type='info') { io.to('admin_room').emit('adminPulse', { msg, type, time: Date.now() }); }

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Database');
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) await new User({ username: 'admin', password: 'adminpassword', discord: 'admin', role: 'Admin', credits: 10000 }).save();
        pushAdminData();
    }).catch(err => { console.error('❌ MongoDB Connection Error.', err); });

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord: { type: String, required: true },
    referredBy: { type: String, default: null },
    firstDepositMade: { type: Boolean, default: false },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    playableCredits: { type: Number, default: 0 }, 
    status: { type: String, default: 'Offline' },
    ipAddress: { type: String, default: 'Unknown' },
    joinDate: { type: Date, default: Date.now },
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } },
    soloBaseline: { game: { type: String, default: null }, amount: { type: Number, default: 0 }, active: { type: Boolean, default: false } }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, sntUser: String, discordUser: String,
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

const adminLogSchema = new mongoose.Schema({
    adminName: String, action: String, details: String, date: { type: Date, default: Date.now }
});
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [], roundId: Date.now() };
let connectedUsers = {}; 
let globalResults = { baccarat: [], perya: [], dt: [], sicbo: [] }; 
let gameStats = { baccarat: {total:0,Player:0,Banker:0,Tie:0}, dt: {total:0,Dragon:0,Tiger:0,Tie:0}, sicbo: {total:0,Big:0,Small:0,Triple:0}, perya: {total:0,Yellow:0,White:0,Pink:0,Blue:0,Red:0,Green:0}, coinflip: {total:0,Heads:0,Tails:0}, d20: {total:0,Win:0,Lose:0}, blackjack: {total:0,Win:0,Lose:0,Push:0} };

function logGlobalResult(game, resultStr) {
    if(globalResults[game]) {
        globalResults[game].unshift({ result: resultStr, roundId: sharedTables.roundId, time: new Date() });
        if (globalResults[game].length > 10) globalResults[game].pop(); 
    }
}
function checkResetStats(game) { if (gameStats[game].total >= 100) Object.keys(gameStats[game]).forEach(key => gameStats[game][key] = 0); }
function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'], ss = ['♠','♣','♥','♦'];
    let v = vs[crypto.randomInt(vs.length)], s = ss[crypto.randomInt(ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = (v === 'A') ? 1 : (v === 'K' ? 13 : (v === 'Q' ? 12 : (v === 'J' ? 11 : parseInt(v))));
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}
function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { score += card.bjVal; if (card.val === 'A') aces += 1; }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// SHARED TABLE LOOP
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--; io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            setTimeout(async () => {
                let dtD = drawCard(), dtT = drawCard();
                let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
                let dtResStr = dtWin === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `${dtWin.toUpperCase()} (${dtD.raw} TO ${dtT.raw})`;
                
                let sbR = [crypto.randomInt(1, 7), crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
                let sbSum = sbR[0] + sbR[1] + sbR[2];
                let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
                let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
                let sbResStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${sbWin.toUpperCase()} (${sbSum})`;

                const cols = ['Yellow','White','Pink','Blue','Red','Green'];
                let pyR = [cols[crypto.randomInt(6)], cols[crypto.randomInt(6)], cols[crypto.randomInt(6)]];

                let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
                let pS = (pC[0].bacVal + pC[1].bacVal) % 10, bS = (bC[0].bacVal + bC[1].bacVal) % 10;
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
                let bacResStr = bacWin === 'Tie' ? `TIE (${pS} TO ${bS})` : `${bacWin.toUpperCase()} (${pS} TO ${bS})`;

                let playerStats = {}; 
                sharedTables.bets.forEach(b => {
                    let payout = 0;
                    if (b.room === 'dt') { payout = (dtWin === 'Tie') ? (b.choice === 'Tie' ? b.amount * 9 : b.amount) : (b.choice === dtWin ? b.amount * 2 : 0); } 
                    else if (b.room === 'sicbo') { payout = (b.choice === sbWin) ? b.amount * 2 : 0; } 
                    else if (b.room === 'perya') { let matches = pyR.filter(c => c === b.choice).length; if (matches > 0) payout = b.amount + (b.amount * matches); } 
                    else if (b.room === 'baccarat') {
                        if (bacWin === 'Tie') payout = (b.choice === 'Tie' ? b.amount * 9 : (b.choice !== 'Tie' ? b.amount : 0));
                        else if (bacWin === 'Player') payout = (b.choice === 'Player' ? b.amount * 2 : 0);
                        else if (bacWin === 'Banker') payout = (b.choice === 'Banker' ? b.amount * 1.95 : 0);
                    }
                    if (!playerStats[b.userId]) playerStats[b.userId] = { username: b.username, amountWon: 0, amountBet: 0, room: b.room };
                    playerStats[b.userId].amountBet += b.amount; playerStats[b.userId].amountWon += formatTC(payout);
                });

                Object.keys(playerStats).forEach(async (userId) => {
                    let st = playerStats[userId];
                    let user = await User.findById(userId);
                    if (user) {
                        if (st.amountWon > 0) { user.credits = formatTC(user.credits + st.amountWon); await user.save(); }
                        let net = formatTC(st.amountWon - st.amountBet);
                        if (net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: st.room.toUpperCase() }).save();
                    }
                });

                io.to('dt').emit('sharedResults', { room: 'dt', roundId: sharedTables.roundId, dCard: dtD, tCard: dtT, winner: dtWin, resStr: dtResStr });
                io.to('sicbo').emit('sharedResults', { room: 'sicbo', roundId: sharedTables.roundId, roll: sbR, sum: sbSum, winner: sbWin, resStr: sbResStr });
                io.to('perya').emit('sharedResults', { room: 'perya', roundId: sharedTables.roundId, roll: pyR });
                io.to('baccarat').emit('sharedResults', { room: 'baccarat', roundId: sharedTables.roundId, pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, resStr: bacResStr, p3Drawn: p3Drawn, b3Drawn: b3Drawn });

                setTimeout(() => { logGlobalResult('dt', dtResStr); gameStats.dt.total++; gameStats.dt[dtWin]++; checkResetStats('dt'); }, 2500);
                setTimeout(() => { logGlobalResult('sicbo', sbResStr); gameStats.sicbo.total++; gameStats.sicbo[sbWin]++; checkResetStats('sicbo'); }, 2500);
                setTimeout(() => { logGlobalResult('perya', pyR.join(',')); gameStats.perya.total++; pyR.forEach(c => gameStats.perya[c]++); checkResetStats('perya'); }, 2500);
                setTimeout(() => { logGlobalResult('baccarat', bacResStr); gameStats.baccarat.total++; gameStats.baccarat[bacWin]++; checkResetStats('baccarat'); }, 4500);

            }, 500);

            setTimeout(() => {
                sharedTables.time = 15; sharedTables.status = 'BETTING'; sharedTables.bets = []; sharedTables.roundId = Date.now();
                io.emit('newRound', { roundId: sharedTables.roundId }); 
                pushAdminData();
            }, 9000); 
        }
    }
}, 1000);

async function pushAdminData(targetSocket = null) {
    try {
        const users = await User.find(); 
        const txs = await Transaction.find().sort({ date: -1 }); 
        const gcs = await GiftCode.find().sort({ date: -1 });
        
        let totalMainCredits = formatTC(users.reduce((a, b) => a + (b.credits || 0), 0)); 
        
        // MongoDB Aggregation for blazing fast Vault Calc
        const depAgg = await Transaction.aggregate([{ $match: { type: 'Deposit', status: 'Approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const witAgg = await Transaction.aggregate([{ $match: { type: 'Withdrawal', status: 'Approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        let approvedDeposits = depAgg.length > 0 ? depAgg[0].total : 0;
        let approvedWithdrawals = witAgg.length > 0 ? witAgg[0].total : 0;

        globalBankVault = formatTC(2000000 + approvedDeposits - approvedWithdrawals - totalMainCredits);

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const gameLogs = await CreditLog.find({ action: 'GAME', date: { $gte: oneDayAgo } });
        let houseProfit24h = formatTC(-(gameLogs.reduce((sum, l) => sum + l.amount, 0)));

        const adminLogs = await AdminLog.find().sort({ date: -1 }).limit(100);

        let payload = { 
            users, transactions: txs, giftBatches: gcs, adminLogs,
            stats: { economy: totalMainCredits, approvedDeposits: formatTC(approvedDeposits), limit: globalBankVault, houseProfit: houseProfit24h },
            isMaintenance: isMaintenanceMode
        };

        if(targetSocket) { targetSocket.emit('adminDataSync', payload); }
        else { io.to('admin_room').emit('adminDataSync', payload); }
    } catch(e) { console.error(e); }
}

io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);
    socket.emit('maintenanceToggle', isMaintenanceMode); 
    socket.emit('radioSync', currentRadio);

    socket.isCashier = false;
    socket.isAuth = false;

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
        if(socket.user) { await CreditLog.deleteMany({ username: socket.user.username }); socket.emit('walletLogsData', { logs: [], dailyProfit: 0 }); }
    });

    socket.on('fetchUserLogs', async (username) => {
        if (!socket.rooms.has('admin_room')) return;
        const logs = await CreditLog.find({ username }).sort({ date: -1 }).limit(100);
        socket.emit('userLogsData', { username, logs });
    });

    socket.on('playSolo', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.game });
        if (!socket.user) return;

        try {
            let user = await User.findById(socket.user._id);
            if (!user) return;
            
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            
            if (isNewBet) {
                let amt = formatTC(data.bet || 0);
                let maxPotentialMultiplier = 1;

                if (data.game === 'd20') {
                    if (!Array.isArray(data.bets) || data.bets.length === 0) return socket.emit('localGameError', { msg: 'Select at least one bet', game: 'd20' });
                    let totalD20Bet = 0;
                    for (let b of data.bets) { let a = formatTC(b.amount); if(isNaN(a) || a < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: 'd20' }); totalD20Bet += a; }
                    amt = totalD20Bet; maxPotentialMultiplier = 1.95 * data.bets.length; 
                } else {
                    if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game });
                    if (data.game === 'coinflip') maxPotentialMultiplier = 1.95;
                    if (data.game === 'blackjack') maxPotentialMultiplier = 2.5;
                }
                if (amt > 50000) return socket.emit('localGameError', { msg: 'MAX TOTAL BET IS 50K TC', game: data.game });

                // PERSISTENT ANTI-MARTINGALE DYNAMIC SPREAD LIMITER
                if (!user.soloBaseline || !user.soloBaseline.active || user.soloBaseline.game !== data.game) {
                    user.soloBaseline = { game: data.game, amount: amt, active: true };
                } else {
                    let spreadLimit = user.soloBaseline.amount * 8; 
                    if (amt > spreadLimit && amt > 500) { 
                        return socket.emit('localGameError', { msg: `MARTINGALE CAP: MAX ${formatTC(spreadLimit)} TC`, game: data.game });
                    }
                }
                
                if ((amt * maxPotentialMultiplier) > globalBankVault) return socket.emit('localGameError', { msg: 'VAULT LIMIT REACHED.', game: data.game });

                // ATOMIC WALLET DEDUCTION (PREVENTS DOUBLE TAB RACE CONDITION)
                let fromPlayable = Math.min(user.playableCredits, amt);
                let fromMain = formatTC(amt - fromPlayable);
                
                const updatedUser = await User.findOneAndUpdate(
                    { _id: user._id, credits: { $gte: fromMain }, playableCredits: { $gte: fromPlayable } },
                    { $inc: { credits: -fromMain, playableCredits: -fromPlayable }, $set: { soloBaseline: user.soloBaseline } },
                    { new: true }
                );

                if (!updatedUser) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC (Atomic Lock)', game: data.game });
                user = updatedUser; // Update local ref
                sendPulse(`${user.username} bet ${amt} TC on ${data.game.toUpperCase()}`, 'bet');

                if (data.game === 'blackjack') socket.bjState = { bet: amt, pHand: [drawCard(), drawCard()], dHand: [drawCard(), drawCard()], fromPlayable, fromMain };
            }

            let payout = 0;

            if (data.game === 'd20') {
                let roll = crypto.randomInt(1, 21); let wonAny = false;
                for(let b of data.bets) {
                    let win = false; let val = b.guessValue;
                    if (val === 'high' && roll >= 11) win = true;
                    if (val === 'low' && roll <= 10) win = true;
                    if (val === 'even' && roll % 2 === 0) win = true;
                    if (val === 'odd' && roll % 2 !== 0) win = true;
                    if(win) { payout += formatTC(b.amount * 1.95); wonAny = true; }
                }
                payout = formatTC(payout);
                
                if (payout > 0) user.soloBaseline.active = false;
                user.credits = formatTC(user.credits + payout); await user.save();
                
                let net = formatTC(payout - data.bet);
                await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `D20` }).save();
                
                pushAdminData();
                socket.emit('d20Result', { roll, payout, bet: data.bet, resStr: `ROLLED ${roll}`, newBalance: { credits: user.credits, playable: user.playableCredits }});
                setTimeout(() => { gameStats.d20.total++; if (wonAny) gameStats.d20.Win++; else gameStats.d20.Lose++; checkResetStats('d20'); }, 2000);
            } 
            else if (data.game === 'coinflip') {
                let result = crypto.randomInt(2) === 0 ? 'Heads' : 'Tails';
                if (data.choice === result) { payout = formatTC(data.bet * 1.95); user.soloBaseline.active = false; }
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `Coin Flip` }).save();
                
                pushAdminData();
                socket.emit('coinResult', { result, payout, bet: data.bet, resStr: `${result.toUpperCase()}`, newBalance: { credits: user.credits, playable: user.playableCredits }});
                setTimeout(() => { gameStats.coinflip.total++; gameStats.coinflip[result]++; checkResetStats('coinflip'); }, 2000);
            }
            else if (data.game === 'blackjack') {
                if (data.action === 'start') {
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    if (pS === 21) {
                        user.soloBaseline.active = false;
                        let msg = dS === 21 ? 'Push' : 'Blackjack!';
                        payout = formatTC(dS === 21 ? socket.bjState.bet : socket.bjState.bet * 2.5);
                        
                        if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } 
                        else { user.credits = formatTC(user.credits + payout); }
                        await user.save();

                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        pushAdminData();
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, naturalBJ: true, payout, msg, resStr: `${msg.toUpperCase()} (${pS} TO ${dS})`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }});
                        socket.bjState = null;
                        setTimeout(() => { gameStats.blackjack.total++; if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++; checkResetStats('blackjack'); }, 2500);
                    } else { socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand }); }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard()); let pS = getBJScore(socket.bjState.pHand);
                    if (pS > 21) {
                        await user.save(); // Save the streak active state
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', resStr: `PLAYER BUSTS!`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null;
                        setTimeout(() => { gameStats.blackjack.total++; gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 2500);
                    } else { socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand }); }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    let dS = getBJScore(socket.bjState.dHand); let msg = '';
                    
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win!'; } 
                    else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } 
                    else { msg = 'Dealer Wins'; }
                    
                    if (msg === 'You Win!' || msg === 'Push') user.soloBaseline.active = false;

                    if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } 
                    else { user.credits = formatTC(user.credits + payout); }
                    await user.save();

                    await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                    let resStr = (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win!' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`));
                    
                    pushAdminData();
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    socket.bjState = null;
                    setTimeout(() => { gameStats.blackjack.total++; if (dS > 21 || pS > dS) gameStats.blackjack.Win++; else if (pS === dS) gameStats.blackjack.Push++; else gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 2500);
                }
            }
        } catch(e) { console.error(e); }
    });

    socket.on('joinRoom', (room) => { if(socket.currentRoom) { socket.leave(socket.currentRoom); rooms[socket.currentRoom]--; } socket.join(room); socket.currentRoom = room; rooms[room]++; io.emit('playerCount', rooms); });
    socket.on('leaveRoom', (room) => { socket.leave(room); socket.currentRoom = null; if (rooms[room] > 0) rooms[room]--; io.emit('playerCount', rooms); });
    
    socket.on('sendChat', (data) => { 
        if (!socket.user) return;
        if (data.msg.startsWith('/play ')) {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') { if (socket.currentRoom) io.to(socket.id).emit('chatMessage', { user: 'System', text: 'Only VIPs and Admins can use the DJ Radio.', sys: true }); return; }
            let url = data.msg.replace('/play ', '').trim();
            currentRadio = { url, startTime: Date.now(), requestedBy: socket.user.username };
            io.emit('radioPlay', currentRadio); io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] ${socket.user.username} started playing a track!` }); return;
        }
        if (data.msg === '/stop') {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') return;
            currentRadio = { url: null, startTime: 0, requestedBy: null };
            io.emit('radioStop'); io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] DJ turned off by ${socket.user.username}.` }); return;
        }
        if (socket.currentRoom) { io.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false, role: socket.user.role }); } 
    });
    
    socket.on('getRoomPlayers', (room) => {
        let playersInRoom = [];
        for (let username in connectedUsers) { let sId = connectedUsers[username]; let s = io.sockets.sockets.get(sId); if (s && s.rooms.has(room)) playersInRoom.push(username); }
        socket.emit('roomPlayersList', playersInRoom);
    });
    
    socket.on('placeSharedBet', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.room });
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        
        try {
            const user = await User.findById(socket.user._id); if (!user) return;
            let amt = formatTC(data.amount);
            if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room });

            let currentTileBet = sharedTables.bets.filter(b => b.userId.toString() === user._id.toString() && b.room === data.room && b.choice === data.choice).reduce((sum, b) => sum + b.amount, 0);
            if (currentTileBet + amt > 50000) return socket.emit('localGameError', { msg: 'MAX 50K TC PER TILE', game: data.room });

            let maxMultiplier = { 'baccarat': 9, 'dt': 9, 'sicbo': 2, 'perya': 4 }[data.room] || 2;
            if ((amt * maxMultiplier) > globalBankVault) return socket.emit('localGameError', { msg: 'VAULT LIMIT REACHED.', game: data.room });
            
            // ATOMIC WALLET DEDUCTION
            let fromPlayable = Math.min(user.playableCredits, amt);
            let fromMain = formatTC(amt - fromPlayable);
            
            const updatedUser = await User.findOneAndUpdate(
                { _id: user._id, credits: { $gte: fromMain }, playableCredits: { $gte: fromPlayable } },
                { $inc: { credits: -fromMain, playableCredits: -fromPlayable } },
                { new: true }
            );

            if (!updatedUser) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room });
            sendPulse(`${user.username} placed ${amt} TC on ${data.room.toUpperCase()}`, 'bet');
            
            sharedTables.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: amt, fromPlayable: fromPlayable, fromMain: fromMain });
            socket.emit('sharedBetConfirmed', { choice: data.choice, amount: amt, room: data.room, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits } });
        } catch(e) { console.error(e); }
    });

    socket.on('undoSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        try {
            for (let i = sharedTables.bets.length - 1; i >= 0; i--) {
                let b = sharedTables.bets[i];
                if (b.userId.toString() === socket.user._id.toString() && b.room === data.room) {
                    let user = await User.findById(socket.user._id);
                    if (user) {
                        user.playableCredits = formatTC((user.playableCredits || 0) + b.fromPlayable);
                        user.credits = formatTC((user.credits || 0) + b.fromMain);
                        await user.save();
                        socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                        socket.emit('undoSuccess', { choice: b.choice, amount: b.amount });
                    }
                    sharedTables.bets.splice(i, 1);
                    break;
                }
            }
        } catch(e) { console.error(e); }
    });

    socket.on('submitTransaction', async (data) => { 
        if (!socket.user) return;
        if (socket.isCashier) return;
        socket.isCashier = true;

        try {
            let amount = formatTC(data.amount);
            if(isNaN(amount) || amount <= 0) return;
            if (data.type === 'Deposit' && amount < 1000) return socket.emit('localGameError', { msg: 'MIN DEPOSIT IS 1,000 TC', game: 'cashier' });
            if (data.type === 'Withdrawal' && amount < 10000) return socket.emit('localGameError', { msg: 'MIN WITHDRAWAL IS 10,000 TC', game: 'cashier' });
            if (data.type === 'Deposit' && amount > 100000) return socket.emit('localGameError', { msg: 'MAX DEPOSIT IS 100,000 TC', game: 'cashier' });
            if (data.type === 'Withdrawal' && amount > 100000) return socket.emit('localGameError', { msg: 'MAX WITHDRAWAL IS 100,000 TC', game: 'cashier' });

            if(data.type === 'Withdrawal') {
                const user = await User.findOneAndUpdate({ _id: socket.user._id, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
                if (!user) return socket.emit('localGameError', { msg: 'Insufficient TC.', game: 'cashier' });
                socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }

            let tx = await new Transaction({ username: socket.user.username, type: data.type, amount: amount, sntUser: data.sntUser, discordUser: data.discordUser }).save(); 
            
            if(data.type === 'Withdrawal') await new CreditLog({ username: socket.user.username, action: 'WITHDRAWAL', amount: -amount, details: `Pending` }).save();
            else await new CreditLog({ username: socket.user.username, action: 'DEPOSIT', amount: amount, details: `Pending` }).save();
            
            sendPulse(`${socket.user.username} submitted a ${data.type} request for ${amount} TC.`, 'alert');
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); 
        } catch(e) { console.error(e); } finally { socket.isCashier = false; }
    });

    socket.on('adminLogin', async (data) => {
        try {
            if (socket.isAuth) return;
            socket.isAuth = true;

            const user = await User.findOne({ username: data.username, password: data.password });
            if (user && (user.role === 'Admin' || user.role === 'Moderator')) {
                // SESSION ENFORCER
                if (connectedUsers[user.username]) io.to(connectedUsers[user.username]).emit('forceLogout', 'Session active in another tab.');
                socket.join('admin_room'); 
                user.ipAddress = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address; await user.save();
                socket.user = user; connectedUsers[user.username] = socket.id;
                socket.emit('adminLoginSuccess', { username: user.username, role: user.role });
                await pushAdminData(socket);
            } else { socket.emit('authError', 'Invalid Admin Credentials.'); }
        } catch(e) { socket.emit('authError', 'System Error'); } finally { socket.isAuth = false; }
    });

    socket.on('login', async (data) => {
        try {
            if (socket.isAuth) return;
            socket.isAuth = true;

            const user = await User.findOne({ username: new RegExp('^' + data.username + '$', 'i'), password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            // SINGLE SESSION ENFORCER
            if (connectedUsers[user.username]) {
                io.to(connectedUsers[user.username]).emit('forceLogout', 'You logged in from another tab or device.');
            }

            user.ipAddress = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address; user.status = 'Active'; await user.save(); 
            socket.user = user; connectedUsers[user.username] = socket.id;
            
            sendPulse(`${user.username} logged in.`, 'info'); pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            socket.emit('loginSuccess', { username: user.username, credits: formatTC(user.credits), playable: formatTC(user.playableCredits), role: user.role, daily: { canClaim, day, nextClaim } });
        } catch(e) { socket.emit('authError', 'System Error'); } finally { socket.isAuth = false; }
    });

    socket.on('register', async (data) => {
        try {
            if (socket.isAuth) return;
            socket.isAuth = true;

            if (data.username.length < 4 || data.username.length > 12) return socket.emit('authError', 'Username must be 4-12 characters.');
            if (data.password.length < 4 || data.password.length > 12) return socket.emit('authError', 'Password must be 4-12 characters.');
            if (!data.discord || data.discord.trim().length < 2) return socket.emit('authError', 'Discord Username is required.');

            const exists = await User.findOne({ username: new RegExp('^' + data.username + '$', 'i') });
            if (exists) return socket.emit('authError', 'Username is already taken.');
            
            let refUser = null;
            if (data.referral) {
                refUser = await User.findOne({ username: new RegExp('^' + data.referral + '$', 'i') });
                if (!refUser) return socket.emit('authError', 'Invalid Referral Code.');
            }
            
            let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            await new User({ username: data.username, password: data.password, discord: data.discord, referredBy: refUser ? refUser.username : null, ipAddress: ip }).save();
            
            sendPulse(`New account created: ${data.username}`, 'success'); pushAdminData();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { socket.emit('authError', 'System Error'); } finally { socket.isAuth = false; }
    });

    socket.on('claimDaily', async () => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        let now = new Date();
        if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim) / (1000 * 60 * 60) < 24) return; 

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [100, 250, 500, 750, 1000, 1500, 2000];
        
        // VIP DOUBLE REWARD
        let multiplier = user.role === 'VIP' ? 2 : 1;
        let amt = formatTC(rewards[day - 1] * multiplier);

        user.playableCredits = formatTC((user.playableCredits || 0) + amt); 
        user.dailyReward.lastClaim = now; user.dailyReward.streak += 1; await user.save();
        
        await new CreditLog({ username: user.username, action: 'GIFT', amount: amt, details: `Daily Reward` }).save();
        sendPulse(`${user.username} claimed Day ${day} Daily Reward.`, 'info'); pushAdminData();
        socket.emit('dailyClaimed', { amt, newBalance: { credits: user.credits, playable: user.playableCredits }, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    });

    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOneAndUpdate({ code: code, redeemedBy: null }, { redeemedBy: socket.user.username }, { new: true });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid or already used' });
            const user = await User.findById(socket.user._id);
            if(gc.creditType === 'playable') { user.playableCredits = formatTC((user.playableCredits || 0) + gc.amount); } 
            else { user.credits = formatTC((user.credits || 0) + gc.amount); }
            await user.save();
            await new CreditLog({ username: user.username, action: 'CODE', amount: gc.amount, details: `Redeemed` }).save();
            sendPulse(`${socket.user.username} redeemed Promo Code for ${gc.amount}.`, 'success'); pushAdminData();
            socket.emit('promoResult', { success: true, amt: gc.amount, type: gc.creditType });
            socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
        } catch(e) { socket.emit('promoResult', { success: false, msg: 'Server error' }); }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.rooms.has('admin_room')) return; 
        try {
            const adminName = socket.user ? socket.user.username : 'System';

            if (data.type === 'toggleMaintenance') {
                isMaintenanceMode = !isMaintenanceMode; io.emit('maintenanceToggle', isMaintenanceMode);
                sendPulse(`Maintenance Mode is now ${isMaintenanceMode ? 'ON' : 'OFF'}`, 'alert');
                socket.emit('adminSuccess', `Maintenance Mode: ${isMaintenanceMode ? 'ACTIVE' : 'DISABLED'}`);
            }
            else if (data.type === 'editUser') { 
                let u = await User.findById(data.id);
                if (u) {
                    u.credits = formatTC(data.credits); u.playableCredits = formatTC(data.playableCredits); u.role = data.role; await u.save();
                    await new AdminLog({ adminName, action: 'EDIT USER', details: `Updated balances for ${u.username}` }).save();
                    let tSock = connectedUsers[u.username];
                    if (tSock) { io.to(tSock).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); io.to(tSock).emit('silentNotification', { title: 'Balance Updated', msg: 'An admin has adjusted your balance.' }); }
                    socket.emit('adminSuccess', `Successfully updated ${u.username}.`);
                }
            }
            else if (data.type === 'assetWipe') {
                let u = await User.findById(data.id);
                if(u) {
                    u.credits = 0; u.playableCredits = 0; await u.save();
                    await new AdminLog({ adminName, action: 'ASSET WIPE', details: `Wiped all assets for ${u.username}` }).save();
                    sendPulse(`${adminName} ASSET WIPED ${u.username}`, 'alert');
                    let tSock = connectedUsers[u.username];
                    if (tSock) { io.to(tSock).emit('balanceUpdateData', { credits: 0, playable: 0 }); io.to(tSock).emit('silentNotification', { title: 'ASSET WIPE', msg: 'Your account assets have been confiscated due to a TOS violation.' }); }
                    socket.emit('adminSuccess', `Asset Wipe applied to ${u.username}.`);
                }
            }
            else if (data.type === 'ban') { 
                let u = await User.findById(data.id);
                if(u) { u.status = 'Banned'; await u.save(); await new AdminLog({ adminName, action: 'BAN', details: `Banned user ${u.username}` }).save(); if(connectedUsers[u.username]) io.to(connectedUsers[u.username]).emit('forceLogout', 'Your account has been banned.'); socket.emit('adminSuccess', `Banned ${u.username}.`); }
            }
            else if (data.type === 'unban') { 
                let u = await User.findById(data.id);
                if(u) { u.status = 'Active'; await u.save(); await new AdminLog({ adminName, action: 'UNBAN', details: `Unbanned user ${u.username}` }).save(); socket.emit('adminSuccess', `Unbanned ${u.username}.`); }
            }
            else if (data.type === 'clearUserLogs') {
                await CreditLog.deleteMany({ username: data.username });
                const logs = await CreditLog.find({ username: data.username }).sort({ date: -1 }).limit(100);
                socket.emit('userLogsData', { username: data.username, logs });
                await new AdminLog({ adminName, action: 'CLEAR LOGS', details: `Cleared logs for ${data.username}` }).save();
                socket.emit('adminSuccess', `Cleared logs for ${data.username}.`);
            }
            else if (data.type === 'sendUpdate') { 
                io.emit('silentNotification', { title: 'System Announcement', msg: data.msg }); 
                await new AdminLog({ adminName, action: 'BROADCAST', details: `Msg: ${data.msg}` }).save();
                socket.emit('adminSuccess', `Broadcast sent successfully.`);
            }
            else if (data.type === 'resolveTx') {
                let tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; await tx.save();
                    await new AdminLog({ adminName, action: 'RESOLVE TX', details: `Marked ${tx.type} for ${tx.username} as ${data.status}` }).save();
                    
                    let targetSocketId = connectedUsers[tx.username];
                    if (tx.type === 'Deposit' && data.status === 'Approved') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            u.credits = formatTC((u.credits || 0) + tx.amount);
                            
                            // 10% REFERRAL COMMISSION ENGINE
                            if (!u.firstDepositMade) {
                                u.firstDepositMade = true;
                                if (u.referredBy) {
                                    let referrer = await User.findOne({ username: new RegExp('^' + u.referredBy + '$', 'i') });
                                    if (referrer) {
                                        let comm = formatTC(tx.amount * 0.10);
                                        referrer.playableCredits = formatTC((referrer.playableCredits || 0) + comm);
                                        await referrer.save();
                                        await new CreditLog({ username: referrer.username, action: 'AFFILIATE', amount: comm, details: `${u.username} 1st Dep` }).save();
                                        if (connectedUsers[referrer.username]) {
                                            io.to(connectedUsers[referrer.username]).emit('silentNotification', { title: 'Affiliate Bonus!', msg: `You received ${comm} P from ${u.username}'s first deposit!` });
                                            io.to(connectedUsers[referrer.username]).emit('balanceUpdateData', { credits: referrer.credits, playable: referrer.playableCredits });
                                        }
                                    }
                                }
                            }
                            await u.save();
                            await new CreditLog({ username: u.username, action: 'DEPOSIT', amount: tx.amount, details: `Approved` }).save();
                            if (targetSocketId) { io.to(targetSocketId).emit('silentNotification', { title: 'Deposit Approved', msg: `Your deposit of ${tx.amount} TC has been added.`}); io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); }
                        }
                    }
                    else if (data.status === 'Rejected') {
                        if (tx.type === 'Withdrawal') {
                            let u = await User.findOne({ username: tx.username });
                            if (u) { u.credits = formatTC((u.credits || 0) + tx.amount); await u.save(); await new CreditLog({ username: u.username, action: 'REFUND', amount: tx.amount, details: `Withdrawal Rejected` }).save(); if (targetSocketId) io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); }
                        }
                        if (targetSocketId) { io.to(targetSocketId).emit('silentNotification', { title: `${tx.type} Rejected`, msg: `Your request was rejected.` }); }
                    }
                    socket.emit('adminSuccess', `Transaction marked as ${data.status}.`);
                }
            }
            await pushAdminData();
        } catch(e) { console.error("Admin Action Error:", e); socket.emit('adminError', "Server Error"); }
    });

    socket.on('getGlobalResults', (game) => { socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: gameStats[game] || { total: 0 } }); });
    
    socket.on('disconnect', async () => {
        if (socket.user) { await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); delete connectedUsers[socket.user.username]; }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) { rooms[socket.currentRoom]--; io.emit('playerCount', rooms); }
        pushAdminData();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
