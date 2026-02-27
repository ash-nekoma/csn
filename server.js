require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve frontend files from the "public" folder
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

// Player Accounts
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

// Cashier Requests (Deposits & Withdrawals)
const txSchema = new mongoose.Schema({
    username: String,
    type: String, 
    amount: Number,
    ref: String, // Proof of Payment (filename) or Account Details (Name)
    status: { type: String, default: 'Pending' },
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

// Promo & Gift Codes
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

// Global Results Feed (Stores the last 25 results per game)
let globalResults = { 
    dice: [], coinflip: [], blackjack: [], 
    baccarat: [], perya: [], dt: [], sicbo: [] 
};

// Global Stats Tracker (For the percentage UI in the feed)
let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
    dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
    perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 },
    dice: { total: 0, Win: 0, Lose: 0 },
    blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

// Helper: Logs results and trims the array to max 25 items (No Time string needed here anymore, frontend formats it)
function logGlobalResult(game, resultStr) {
    globalResults[game].unshift({ result: resultStr, time: new Date() });
    if (globalResults[game].length > 25) {
        globalResults[game].pop();
    }
}

// Helper: Generates a random card with Baccarat and Blackjack base values attached
function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[Math.floor(Math.random() * vs.length)];
    let s = ss[Math.floor(Math.random() * ss.length)];
    
    // Baccarat Values (Face cards = 0, Ace = 1)
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    
    // Blackjack Base Values (Face cards = 10, Ace = 11 initially)
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    
    return { val: v, suit: s, bacVal: bac, bjVal: bj };
}

// REAL BLACKJACK SCORING (Handles Aces dynamically switching from 11 to 1)
function getBJScore(hand) {
    let score = 0;
    let aces = 0;
    for (let card of hand) {
        score += card.bjVal;
        if (card.val === 'A') aces += 1;
    }
    while (score > 21 && aces > 0) {
        score -= 10;
        aces -= 1;
    }
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
            
            // Lock UI buttons on frontend immediately
            io.emit('lockBets');

            // ------------------------------------
            // A. GENERATE GAME OUTCOMES & TRACK STATS
            // ------------------------------------
            
            // Dragon Tiger
            let dtD = drawCard(), dtT = drawCard();
            let dtWin = dtD.bjVal > dtT.bjVal ? 'Dragon' : (dtT.bjVal > dtD.bjVal ? 'Tiger' : 'Tie');
            logGlobalResult('dt', `${dtWin} Win`);
            gameStats.dt.total++;
            gameStats.dt[dtWin]++;
            
            // Sic Bo
            let sbR = [
                Math.floor(Math.random() * 6) + 1, 
                Math.floor(Math.random() * 6) + 1, 
                Math.floor(Math.random() * 6) + 1
            ];
            let sbSum = sbR[0] + sbR[1] + sbR[2];
            let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
            let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
            logGlobalResult('sicbo', sbTrip ? `Triple ${sbR[0]}` : `${sbWin} (${sbSum})`);
            gameStats.sicbo.total++;
            gameStats.sicbo[sbWin]++;

            // Color Game (Perya) - Format sent as array so frontend can render 2D Dice easily
            const cols = ['Yellow','White','Pink','Blue','Red','Green'];
            let pyR = [
                cols[Math.floor(Math.random() * 6)], 
                cols[Math.floor(Math.random() * 6)], 
                cols[Math.floor(Math.random() * 6)]
            ];
            logGlobalResult('perya', pyR.join(','));
            gameStats.perya.total++; 
            pyR.forEach(color => gameStats.perya[color]++);

            // Baccarat
            let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
            let pS = (pC[0].bacVal + pC[1].bacVal) % 10;
            let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
            
            let p3Drawn = false, b3Drawn = false;

            if (pS < 8 && bS < 8) {
                let p3Val = -1;
                // Player draws on 0-5
                if (pS <= 5) { 
                    pC.push(drawCard()); 
                    p3Val = pC[2].bacVal; 
                    pS = (pS + p3Val) % 10; 
                    p3Drawn = true;
                }
                
                // Banker draws based on Player's 3rd card rules
                let bDraws = false;
                if (pC.length === 2) { 
                    if (bS <= 5) bDraws = true; 
                } else {
                    if (bS <= 2) bDraws = true;
                    else if (bS === 3 && p3Val !== 8) bDraws = true;
                    else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                    else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                    else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
                }
                
                if (bDraws) { 
                    bC.push(drawCard()); 
                    bS = (bS + bC[bC.length-1].bacVal) % 10; 
                    b3Drawn = true;
                }
            }
            let bacWin = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
            logGlobalResult('baccarat', `${bacWin} (${pS} to ${bS})`);
            gameStats.baccarat.total++;
            gameStats.baccarat[bacWin]++;


            // ------------------------------------
            // B. CALCULATE WINNINGS 
            // ------------------------------------
            let playerPayouts = {}; 
            
            sharedTables.bets.forEach(b => {
                let payout = 0;
                
                if (b.room === 'dt' && b.choice === dtWin) {
                    payout = b.amount * (dtWin === 'Tie' ? 8 : 2);
                }
                else if (b.room === 'sicbo' && b.choice === (sbWin === 'Triple' ? 'None' : sbWin)) {
                    payout = b.amount * 2;
                }
                else if (b.room === 'perya') {
                    let matches = pyR.filter(c => c === b.choice).length;
                    if (matches > 0) payout = b.amount + (b.amount * matches);
                }
                else if (b.room === 'baccarat' && b.choice === bacWin) {
                    payout = b.amount * (bacWin === 'Tie' ? 8 : (bacWin === 'Banker' ? 1.95 : 2));
                }

                if (payout > 0) {
                    if (!playerPayouts[b.userId]) {
                        playerPayouts[b.userId] = { socketId: b.socketId, amount: 0 };
                    }
                    playerPayouts[b.userId].amount += payout;
                }
            });

            // ------------------------------------
            // C. BROADCAST RESULTS & DELAY PAYOUT
            // ------------------------------------
            
            // Send outcomes to frontend immediately so specific card/dice animations start playing
            io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin });
            io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin });
            io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR });
            io.to('baccarat').emit('sharedResults', { 
                room: 'baccarat', 
                pCards: pC, bCards: bC, 
                pScore: pS, bScore: bS,
                winner: bacWin,
                p3Drawn: p3Drawn, b3Drawn: b3Drawn
            });

            // WAIT 5 SECONDS (Allows visual animations to finish BEFORE adding money)
            setTimeout(() => {
                Object.keys(playerPayouts).forEach(async (userId) => {
                    let user = await User.findById(userId);
                    if (user) {
                        user.credits += playerPayouts[userId].amount;
                        await user.save();
                        // Tell player to officially update their nav-bar balance
                        io.to(playerPayouts[userId].socketId).emit('balanceUpdateData', user.credits);
                    }
                });
            }, 5000);

            // WAIT 8 SECONDS total to fully clear the table (reset cards to '?', reset bets) and restart timer
            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); 
            }, 8000); 
        }
    }
}, 1000);


// ==========================================
// 5. CLIENT SOCKET COMMUNICATION
// ==========================================

io.on('connection', (socket) => {
    
    // Sync clock immediately on connect
    socket.emit('timerUpdate', sharedTables.time);

    // --- AUTHENTICATION ---
    socket.on('login', async (data) => {
        try {
            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            user.status = 'Active';
            await user.save();
            socket.user = user;
            
            // Daily Reward Logic & Timers
            let now = new Date();
            let canClaim = true;
            let day = 1;
            let nextClaim = null;

            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) {
                    canClaim = false;
                    nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000);
                } else if (diffHours > 48) {
                    user.dailyReward.streak = 0; // Streak broken, reset to Day 1
                }
                day = (user.dailyReward.streak % 7) + 1;
            }

            socket.emit('loginSuccess', { 
                username: user.username, 
                credits: user.credits, 
                daily: { canClaim, day, nextClaim } 
            });
            
        } catch(e) { 
            socket.emit('authError', 'Server Error.'); 
        }
    });

    socket.on('register', async (data) => {
        try {
            const exists = await User.findOne({ username: data.username });
            if (exists) return socket.emit('authError', 'Username is already taken.');
            
            const newUser = new User({ username: data.username, password: data.password });
            await newUser.save();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { 
            socket.emit('authError', 'Server Error.'); 
        }
    });

    // --- DAILY REWARD ---
    socket.on('claimDaily', async () => {
        if (!socket.user) return;
        
        const user = await User.findById(socket.user._id);
        let now = new Date();

        if (user.dailyReward.lastClaim) {
            let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
            if (diffHours < 24) return; 
        }

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [25, 50, 100, 200, 500, 750, 1000];
        let amt = rewards[day - 1];

        user.credits += amt;
        user.dailyReward.lastClaim = now;
        user.dailyReward.streak += 1;
        await user.save();

        let nextClaim = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        
        socket.emit('dailyClaimed', { amt, newBalance: user.credits, nextClaim });
        socket.emit('balanceUpdateData', user.credits);
    });

    // --- PROMO CODES ---
    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOne({ code: code });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid Code' });
            if (gc.redeemedBy) return socket.emit('promoResult', { success: false, msg: 'Code already used' });

            gc.redeemedBy = socket.user.username; 
            await gc.save();

            const user = await User.findById(socket.user._id);
            user.credits += gc.amount; 
            await user.save();
            
            socket.emit('promoResult', { success: true, amt: gc.amount });
            socket.emit('balanceUpdateData', user.credits);
        } catch(e) { 
            socket.emit('promoResult', { success: false, msg: 'Server error' }); 
        }
    });

    // --- GLOBAL RESULTS FETCH WITH STATS ---
    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { 
            game: game, 
            results: globalResults[game] || [],
            stats: gameStats[game] || { total: 0 }
        });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        
        // Strict balance check before game starts
        if (user.credits < data.bet) {
            return socket.emit('toast', { msg: 'Insufficient TC', type: 'error' });
        }
        
        // Deduct upfront locally in DB
        user.credits -= data.bet; 
        let payout = 0;

        if (data.game === 'dice') {
            gameStats.dice.total++;
            let roll = Math.floor(Math.random() * 100) + 1;
            
            if (roll > 50) {
                payout = data.bet * 2;
                gameStats.dice.Win++;
            } else {
                gameStats.dice.Lose++;
            }
            
            user.credits += payout; 
            await user.save();
            
            logGlobalResult('dice', `Rolled ${roll}`);
            socket.emit('diceResult', { roll, payout, bet: data.bet, newBalance: user.credits });
        } 
        else if (data.game === 'coinflip') {
            gameStats.coinflip.total++;
            let result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            gameStats.coinflip[result]++;

            if (data.choice === result) payout = data.bet * 2;
            
            user.credits += payout; 
            await user.save();
            
            logGlobalResult('coinflip', result);
            socket.emit('coinResult', { result, payout, bet: data.bet, newBalance: user.credits });
        }
        else if (data.game === 'blackjack') {
            if (data.action === 'start') {
                gameStats.blackjack.total++;
                await user.save(); 
                
                socket.bjState = { 
                    bet: data.bet, 
                    pHand: [drawCard(), drawCard()], 
                    dHand: [drawCard(), drawCard()] 
                };
                
                // Natural Blackjack Check
                let pS = getBJScore(socket.bjState.pHand);
                if (pS === 21) {
                    let dS = getBJScore(socket.bjState.dHand);
                    let msg = dS === 21 ? 'Push' : 'Blackjack!';
                    payout = dS === 21 ? data.bet : data.bet * 2.5;
                    
                    if(msg === 'Blackjack!') gameStats.blackjack.Win++;
                    else gameStats.blackjack.Push++;

                    user.credits += payout; 
                    await user.save();
                    
                    logGlobalResult('blackjack', msg);
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: data.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand });
                }
            }
            else if (data.action === 'hit' && socket.bjState) {
                socket.bjState.pHand.push(drawCard());
                let pS = getBJScore(socket.bjState.pHand);
                
                if (pS > 21) {
                    gameStats.blackjack.Lose++;
                    logGlobalResult('blackjack', 'Bust!');
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', bet: socket.bjState.bet, newBalance: user.credits });
                    socket.bjState = null;
                } else {
                    socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand });
                }
            }
            else if (data.action === 'stand' && socket.bjState) {
                let pS = getBJScore(socket.bjState.pHand);
                
                // Dealer draws until 17
                while (getBJScore(socket.bjState.dHand) < 17) {
                    socket.bjState.dHand.push(drawCard());
                }
                
                let dS = getBJScore(socket.bjState.dHand);
                let msg = '';
                
                if (dS > 21 || pS > dS) { 
                    payout = socket.bjState.bet * 2; 
                    msg = 'You Win!'; 
                    gameStats.blackjack.Win++;
                } else if (pS === dS) { 
                    payout = socket.bjState.bet; 
                    msg = 'Push'; 
                    gameStats.blackjack.Push++;
                } else {
                    msg = 'Dealer Wins';
                    gameStats.blackjack.Lose++;
                }
                
                user.credits += payout; 
                await user.save();
                
                logGlobalResult('blackjack', msg);
                socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, bet: socket.bjState.bet, newBalance: user.credits });
                socket.bjState = null;
            }
        }
    });

    // --- SHARED TABLES NETWORKING ---
    socket.on('joinRoom', (room) => { 
        socket.join(room); 
        rooms[room]++; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); 
        if (rooms[room] > 0) rooms[room]--; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', (data) => { 
        if (socket.user) {
            io.to(data.room).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); 
        }
    });

    socket.on('placeSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        
        const user = await User.findById(socket.user._id);
        if (user.credits < data.amount) return;
        
        user.credits -= data.amount; 
        await user.save();
        
        sharedTables.bets.push({ userId: user._id, socketId: socket.id, room: data.room, choice: data.choice, amount: data.amount });
    });


    // --- CASHIER ACTIONS ---
    socket.on('submitTransaction', async (data) => { 
        if (socket.user) {
            await new Transaction({ 
                username: socket.user.username, 
                type: data.type, 
                amount: data.amount, 
                ref: data.ref 
            }).save(); 
            
            // Instantly refresh modal data for the user
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
        }
    });
    
    socket.on('getTransactions', async () => { 
        if (socket.user) {
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
        }
    });

    // Cleanup Disconnects
    socket.on('disconnect', async () => {
        if (socket.user) {
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
