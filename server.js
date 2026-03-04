// ==============================================================================
// STICK N' TRADE CASINO - MASTER SERVER ENGINE (PART 1)
// ==============================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================================
// 1. GLOBAL DATABASE & ECONOMY STATE
// ==============================================================================
const MAX_BANK = 2000000; // 2 Million TC House Reserve
let total_economy = 0; 
let batch_counter = 1;

// In-Memory Database
let db = {
    users: {}, 
    pending_requests: [], 
    transactions: [], 
    gift_batches: [] 
};

// Global History & 100-Round Stats Tracker (Fully Detailed)
let casinoStats = {
    baccarat: { rounds: 0, history: [], playerWins: 0, bankerWins: 0, ties: 0 },
    dragonTiger: { rounds: 0, history: [], dragonWins: 0, tigerWins: 0, ties: 0 },
    blackjack: { rounds: 0, history: [], playerWins: 0, dealerWins: 0, pushes: 0 },
    sicBo: { rounds: 0, history: [], big: 0, small: 0, triples: 0 },
    colorGame: { rounds: 0, history: [], red: 0, blue: 0, green: 0, yellow: 0, pink: 0, white: 0 },
    coinFlip: { rounds: 0, history: [], heads: 0, tails: 0 },
    soloDice: { rounds: 0, history: [] }
};

// ==============================================================================
// 2. PRECISION MATH & CORE UTILITIES
// ==============================================================================
// Strict 1-Decimal Rounding Engine
const formatTC = (amount) => Math.round(amount * 10) / 10;

// The 100-Round Auto-Reset Engine
function checkAndResetStats(game) {
    if (casinoStats[game].rounds >= 100) {
        console.log(`[SYSTEM] ${game.toUpperCase()} hit 100 rounds. Resetting stats to 0.`);
        casinoStats[game].rounds = 0;
        
        // Zero out percentages
        if (game === 'baccarat') { casinoStats.baccarat.playerWins = 0; casinoStats.baccarat.bankerWins = 0; casinoStats.baccarat.ties = 0; }
        if (game === 'dragonTiger') { casinoStats.dragonTiger.dragonWins = 0; casinoStats.dragonTiger.tigerWins = 0; casinoStats.dragonTiger.ties = 0; }
        if (game === 'blackjack') { casinoStats.blackjack.playerWins = 0; casinoStats.blackjack.dealerWins = 0; casinoStats.blackjack.pushes = 0; }
        if (game === 'sicBo') { casinoStats.sicBo.big = 0; casinoStats.sicBo.small = 0; casinoStats.sicBo.triples = 0; }
        if (game === 'colorGame') { casinoStats.colorGame.red = 0; casinoStats.colorGame.blue = 0; casinoStats.colorGame.green = 0; casinoStats.colorGame.yellow = 0; casinoStats.colorGame.pink = 0; casinoStats.colorGame.white = 0; }
        if (game === 'coinFlip') { casinoStats.coinFlip.heads = 0; casinoStats.coinFlip.tails = 0; }
        
        io.emit('system_stats_reset', { game }); 
    }
}

// 5-Row History Array Manager (Strict One-Liner Format)
function updateHistory(game, resultText, betAmount, winAmount, lossAmount) {
    const entry = { 
        result: resultText, 
        bet: formatTC(betAmount), 
        win: winAmount > 0 ? `+${formatTC(winAmount)}` : "0", 
        loss: lossAmount > 0 ? `-${formatTC(lossAmount)}` : "0" 
    };
    casinoStats[game].history.unshift(entry); 
    if (casinoStats[game].history.length > 5) {
        casinoStats[game].history.pop(); 
    }
}

// ==============================================================================
// 3. GAME ENGINE: BACCARAT (8:1 TIE & PUSH LOGIC)
// ==============================================================================
function playBaccarat(bets) {
    const playerTotal = Math.floor(Math.random() * 10);
    const bankerTotal = Math.floor(Math.random() * 10);
    
    let totalWin = 0, totalLoss = 0, refundAmount = 0;
    let isPush = false;
    let outcomeText = "";

    casinoStats.baccarat.rounds++;

    if (playerTotal === bankerTotal) {
        casinoStats.baccarat.ties++;
        outcomeText = `TIE (${playerTotal} TO ${bankerTotal})`;
        isPush = true; 
        
        if (bets.tie > 0) totalWin += formatTC(bets.tie * 8); // 8:1 Tie Payout
        refundAmount = formatTC(bets.player + bets.banker); // Safely push back to wallet
        
    } else if (playerTotal > bankerTotal) {
        casinoStats.baccarat.playerWins++;
        outcomeText = `PLAYER (${playerTotal} TO ${bankerTotal})`;
        if (bets.player > 0) totalWin += formatTC(bets.player * 1); 
        totalLoss += formatTC(bets.banker + bets.tie);
    } else {
        casinoStats.baccarat.bankerWins++;
        outcomeText = `BANKER (${bankerTotal} TO ${playerTotal})`;
        if (bets.banker > 0) totalWin += formatTC(bets.banker * 0.95); // 0.95:1 Commission
        totalLoss += formatTC(bets.player + bets.tie);
    }

    const totalBet = bets.player + bets.banker + bets.tie;
    updateHistory('baccarat', outcomeText, totalBet, totalWin, totalLoss);
    checkAndResetStats('baccarat');

    return { outcomeText, totalWin, totalLoss, refundAmount, isPush, stats: casinoStats.baccarat };
}

// ==============================================================================
// 4. GAME ENGINE: DRAGON TIGER (8:1 TIE & PUSH LOGIC)
// ==============================================================================
function playDragonTiger(bets) {
    const cards = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const dragonVal = Math.floor(Math.random() * cards.length);
    const tigerVal = Math.floor(Math.random() * cards.length);
    
    let totalWin = 0, totalLoss = 0, refundAmount = 0;
    let isPush = false;
    let outcomeText = "";

    casinoStats.dragonTiger.rounds++;

    if (dragonVal === tigerVal) {
        casinoStats.dragonTiger.ties++;
        outcomeText = `TIE (${cards[dragonVal]} TO ${cards[tigerVal]})`;
        isPush = true;
        
        if (bets.tie > 0) totalWin += formatTC(bets.tie * 8); 
        refundAmount = formatTC(bets.dragon + bets.tiger); 
        
    } else if (dragonVal > tigerVal) {
        casinoStats.dragonTiger.dragonWins++;
        outcomeText = `DRAGON (${cards[dragonVal]} TO ${cards[tigerVal]})`;
        if (bets.dragon > 0) totalWin += formatTC(bets.dragon * 1);
        totalLoss += formatTC(bets.tiger + bets.tie);
    } else {
        casinoStats.dragonTiger.tigerWins++;
        outcomeText = `TIGER (${cards[tigerVal]} TO ${cards[dragonVal]})`;
        if (bets.tiger > 0) totalWin += formatTC(bets.tiger * 1);
        totalLoss += formatTC(bets.dragon + bets.tie);
    }

    const totalBet = bets.dragon + bets.tiger + bets.tie;
    updateHistory('dragonTiger', outcomeText, totalBet, totalWin, totalLoss);
    checkAndResetStats('dragonTiger');

    return { outcomeText, totalWin, totalLoss, refundAmount, isPush, stats: casinoStats.dragonTiger };
}

// ==============================================================================
// 5. GAME ENGINE: BLACKJACK (DEALER AI & MULTIPLIERS)
// ==============================================================================
function playBlackjack(betAmount) {
    // Simplified logic for server-side resolution
    const playerHand = Math.floor(Math.random() * (21 - 17 + 1)) + 17; // 17 to 21
    const dealerHand = Math.floor(Math.random() * (22 - 17 + 1)) + 17; // 17 to 22 (22 = Bust)
    
    let totalWin = 0, totalLoss = 0, refundAmount = 0;
    let isPush = false;
    let outcomeText = "";

    casinoStats.blackjack.rounds++;

    if (playerHand === 21 && dealerHand !== 21) {
        casinoStats.blackjack.playerWins++;
        outcomeText = `BLACKJACK (21 TO ${dealerHand})`;
        totalWin = formatTC(betAmount * 1.5); // 3:2 Blackjack Payout
    } else if (dealerHand > 21) {
        casinoStats.blackjack.playerWins++;
        outcomeText = `DEALER BUST (DEALER ${dealerHand})`;
        totalWin = formatTC(betAmount * 1);
    } else if (playerHand > dealerHand) {
        casinoStats.blackjack.playerWins++;
        outcomeText = `PLAYER WINS (${playerHand} TO ${dealerHand})`;
        totalWin = formatTC(betAmount * 1);
    } else if (playerHand < dealerHand) {
        casinoStats.blackjack.dealerWins++;
        outcomeText = `DEALER WINS (${dealerHand} TO ${playerHand})`;
        totalLoss = formatTC(betAmount);
    } else {
        casinoStats.blackjack.pushes++;
        outcomeText = `PUSH (${playerHand} TO ${dealerHand})`;
        isPush = true;
        refundAmount = formatTC(betAmount);
    }

    updateHistory('blackjack', outcomeText, betAmount, totalWin, totalLoss);
    checkAndResetStats('blackjack');

    return { outcomeText, totalWin, totalLoss, refundAmount, isPush, stats: casinoStats.blackjack };
}

// ==============================================================================
// 6. GAME ENGINE: SIC BO (DICE SUMS & TRIPLES)
// ==============================================================================
function playSicBo(bets) {
    // bets object: { big: 100, small: 0, triple: 0 }
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const die3 = Math.floor(Math.random() * 6) + 1;
    const sum = die1 + die2 + die3;
    const isTriple = (die1 === die2 && die2 === die3);
    
    let totalWin = 0, totalLoss = 0;
    let outcomeText = "";

    casinoStats.sicBo.rounds++;

    if (isTriple) {
        casinoStats.sicBo.triples++;
        outcomeText = `TRIPLE (${die1}-${die2}-${die3})`;
        if (bets.triple > 0) totalWin += formatTC(bets.triple * 30); // 30:1 Any Triple
        totalLoss += formatTC(bets.big + bets.small); // Big/Small lose on triples
    } else if (sum >= 11 && sum <= 17) {
        casinoStats.sicBo.big++;
        outcomeText = `BIG (${sum})`;
        if (bets.big > 0) totalWin += formatTC(bets.big * 1);
        totalLoss += formatTC(bets.small + bets.triple);
    } else if (sum >= 4 && sum <= 10) {
        casinoStats.sicBo.small++;
        outcomeText = `SMALL (${sum})`;
        if (bets.small > 0) totalWin += formatTC(bets.small * 1);
        totalLoss += formatTC(bets.big + bets.triple);
    }

    const totalBet = bets.big + bets.small + bets.triple;
    updateHistory('sicBo', outcomeText, totalBet, totalWin, totalLoss);
    checkAndResetStats('sicBo');

    return { outcomeText, totalWin, totalLoss, stats: casinoStats.sicBo };
}
// ==============================================================================
// 7. GAME ENGINE: COLOR GAME (PERYA / MULTI-MULTIPLIER LOGIC)
// ==============================================================================
function playColorGame(bets) {
    // bets object: { red: 50, blue: 0, green: 10, yellow: 0, pink: 0, white: 0 }
    const colors = ['red', 'blue', 'green', 'yellow', 'pink', 'white'];
    
    // Roll 3 Color Dice
    const resultColors = [
        colors[Math.floor(Math.random() * colors.length)],
        colors[Math.floor(Math.random() * colors.length)],
        colors[Math.floor(Math.random() * colors.length)]
    ];
    
    let totalWin = 0, totalLoss = 0;
    casinoStats.colorGame.rounds++;

    // Count occurrences of each winning color
    let colorCounts = {};
    resultColors.forEach(c => {
        colorCounts[c] = (colorCounts[c] || 0) + 1;
        casinoStats.colorGame[c]++; // Track stats for the 100-round reset
    });

    // Calculate payouts based on occurrences (1x, 2x, or 3x multiplier)
    for (let color in bets) {
        if (bets[color] > 0) {
            if (colorCounts[color]) {
                // If a color appears 2 times, it pays 2:1. If 3 times, pays 3:1.
                let multiplier = colorCounts[color]; 
                totalWin += formatTC(bets[color] + (bets[color] * multiplier));
            } else {
                totalLoss += formatTC(bets[color]);
            }
        }
    }

    const outcomeText = `COLORS (${resultColors[0].toUpperCase()}, ${resultColors[1].toUpperCase()}, ${resultColors[2].toUpperCase()})`;
    const totalBet = Object.values(bets).reduce((a, b) => a + b, 0);
    
    updateHistory('colorGame', outcomeText, totalBet, totalWin, totalLoss);
    checkAndResetStats('colorGame');

    return { outcomeText, resultColors, totalWin, totalLoss, stats: casinoStats.colorGame };
}

// ==============================================================================
// 8. GAME ENGINE: COIN FLIP (NaN FIX & STRICT 1-DECIMAL)
// ==============================================================================
function playCoinFlip(betAmount, choice) {
    const isHeads = Math.random() >= 0.5;
    const resultText = isHeads ? "HEADS" : "TAILS";
    let totalWin = 0, totalLoss = 0;

    casinoStats.coinFlip.rounds++;
    if (isHeads) casinoStats.coinFlip.heads++;
    else casinoStats.coinFlip.tails++;

    if (choice.toUpperCase() === resultText) {
        totalWin = formatTC(betAmount * 1.95); // 0.95:1 payout to account for house edge
    } else {
        totalLoss = formatTC(betAmount);
    }

    updateHistory('coinFlip', resultText, betAmount, totalWin, totalLoss);
    checkAndResetStats('coinFlip');

    // NaN Fix applied safely here for the frontend payload
    let totalRounds = casinoStats.coinFlip.rounds;
    let headsPercent = totalRounds === 0 ? 0 : formatTC((casinoStats.coinFlip.heads / totalRounds) * 100);
    let tailsPercent = totalRounds === 0 ? 0 : formatTC((casinoStats.coinFlip.tails / totalRounds) * 100);

    return { 
        outcomeText: resultText, 
        totalWin, 
        totalLoss, 
        stats: { headsPercent, tailsPercent, totalRounds } 
    };
}

// ==============================================================================
// 9. GAME ENGINE: SOLO DICE (OVER/UNDER & EXACT NUMBER)
// ==============================================================================
function playSoloDice(betAmount, betType, targetValue = null) {
    const dieResult = Math.floor(Math.random() * 6) + 1;
    let totalWin = 0, totalLoss = 0, outcomeText = "";

    casinoStats.soloDice.rounds++;

    if (betType === 'EXACT') {
        outcomeText = `EXACT ROLL (${dieResult})`;
        if (dieResult === targetValue) totalWin = formatTC(betAmount * 5.8); // 5.8:1
        else totalLoss = formatTC(betAmount);
    } else if (betType === 'OVER_3') {
        outcomeText = `OVER 3 (${dieResult})`;
        if (dieResult > 3) totalWin = formatTC(betAmount * 1.95);
        else totalLoss = formatTC(betAmount);
    } else if (betType === 'UNDER_4') {
        outcomeText = `UNDER 4 (${dieResult})`;
        if (dieResult < 4) totalWin = formatTC(betAmount * 1.95);
        else totalLoss = formatTC(betAmount);
    }

    updateHistory('soloDice', outcomeText, betAmount, totalWin, totalLoss);
    checkAndResetStats('soloDice');

    return { outcomeText, dieResult, totalWin, totalLoss, stats: casinoStats.soloDice };
}


// ==============================================================================
// 10. FULL-DUPLEX WEB-SOCKETS (CLIENT & ADMIN BRIDGE)
// ==============================================================================
io.on('connection', (socket) => {
    console.log(`[SYS] User Connected: ${socket.id}`);

    // --- A. AUTHENTICATION & PLAYER SYNC ---
    socket.on('user_login', (userData) => {
        // userData format: { username: "Player1", credits: 1000, role: "Player" }
        db.users[socket.id] = { 
            ...userData, 
            isOnline: true, 
            joined: new Date().toLocaleDateString() 
        };
        
        // Recalculate total economy dynamically
        total_economy = Object.values(db.users).reduce((sum, user) => sum + user.credits, 0);
        
        // Push updated hierarchy to Admin Dashboard instantly
        io.emit('admin_sync_players', { users: Object.values(db.users), total_economy });
    });

    // --- B. GAMEPLAY LISTENERS (Strict Sequence Lock Logic) ---
    // Universal Bet Handler function to keep code DRY
    function handleGameBet(gameFunction, betsOrParams, eventName) {
        const user = db.users[socket.id];
        let totalBetAmount = 0;

        // Calculate total bet based on input format
        if (typeof betsOrParams === 'object' && !betsOrParams.betAmount) {
            totalBetAmount = formatTC(Object.values(betsOrParams).reduce((a, b) => a + b, 0));
        } else if (betsOrParams.betAmount) {
            totalBetAmount = formatTC(betsOrParams.betAmount);
        }

        if (!user || user.credits < totalBetAmount || totalBetAmount <= 0) {
            return socket.emit('game_error', { msg: "INSUFFICIENT TC OR INVALID BET" }); // Localized arcade flash
        }

        // Deduct bet securely
        user.credits = formatTC(user.credits - totalBetAmount);
        
        // Run game engine logic
        let result;
        if (betsOrParams.betAmount && betsOrParams.choice) {
            result = gameFunction(betsOrParams.betAmount, betsOrParams.choice); // For Coin Flip
        } else if (betsOrParams.betAmount && betsOrParams.betType) {
            result = gameFunction(betsOrParams.betAmount, betsOrParams.betType, betsOrParams.targetValue); // For Dice
        } else {
            result = gameFunction(betsOrParams); // For Baccarat, Dragon Tiger, Sic Bo, Color Game
        }
        
        // Add winnings & pushes safely back to wallet
        let safeReturn = (result.totalWin || 0) + (result.refundAmount || 0);
        user.credits = formatTC(user.credits + safeReturn);
        
        // Emit payload back to client (Client JS waits for animation to update UI)
        socket.emit(eventName, { resultData: result, newBalance: user.credits });
        
        // Update Admin Global Economy silently
        total_economy = Object.values(db.users).reduce((sum, u) => sum + u.credits, 0);
        io.emit('admin_sync_players', { users: Object.values(db.users), total_economy });
    }

    // Attach endpoints to the universal handler
    socket.on('place_bet_baccarat', (bets) => handleGameBet(playBaccarat, bets, 'baccarat_result'));
    socket.on('place_bet_dragonTiger', (bets) => handleGameBet(playDragonTiger, bets, 'dragonTiger_result'));
    socket.on('place_bet_colorGame', (bets) => handleGameBet(playColorGame, bets, 'colorGame_result'));
    socket.on('place_bet_coinFlip', (params) => handleGameBet(playCoinFlip, params, 'coinFlip_result'));

    // --- C. DIGITAL ATM CASHIER (No-Reload Logic) ---
    socket.on('submit_deposit', (data) => {
        const newReq = {
            id: `REQ-${Date.now()}`,
            username: data.username,
            amount: formatTC(data.amount),
            type: 'Deposit',
            status: 'Pending',
            date: new Date().toLocaleString(),
            socketId: socket.id
        };
        db.pending_requests.unshift(newReq);
        
        // Alert Admin instantly via glowing HUD counter
        io.emit('admin_live_update', { type: 'NEW_REQUEST', request: newReq, count: db.pending_requests.length });
    });

    // --- D. ADMIN COMMAND CENTER ACTIONS ---
    socket.on('admin_approve_request', (reqId) => {
        const index = db.pending_requests.findIndex(r => r.id === reqId);
        if (index > -1) {
            const req = db.pending_requests.splice(index, 1)[0];
            req.status = 'Approved';
            db.transactions.unshift(req); // Move to ledger

            // Find user and add credits instantly
            const targetSocketId = Object.keys(db.users).find(key => db.users[key].username === req.username);
            if (targetSocketId) {
                db.users[targetSocketId].credits = formatTC(db.users[targetSocketId].credits + req.amount);
                // Trigger customized localized success toast for user
                io.to(targetSocketId).emit('cashier_alert', { msg: `Deposit of ${req.amount} TC Approved.` });
            }

            total_economy = Object.values(db.users).reduce((sum, u) => sum + u.credits, 0);
            io.emit('admin_live_update', { type: 'REQUEST_RESOLVED', reqId, count: db.pending_requests.length });
            io.emit('admin_sync_players', { users: Object.values(db.users), total_economy });
        }
    });

    socket.on('admin_generate_codes', (data) => {
        const batchId = `B-${String(batch_counter).padStart(3, '0')}`;
        batch_counter++;
        const newBatch = { batchId, value: formatTC(data.value), quantity: data.quantity };
        db.gift_batches.unshift(newBatch);
        io.emit('admin_batch_created', newBatch);
    });

    // --- E. DISCONNECT & CLEANUP ---
    socket.on('disconnect', () => {
        if (db.users[socket.id]) {
            db.users[socket.id].isOnline = false;
            // Instantly move name from Online to Offline in Admin HUD
            io.emit('admin_sync_players', { users: Object.values(db.users), total_economy });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SYS] Stick N' Trade Master Engine locked & loaded on port ${PORT}`);
});
