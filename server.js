require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB DATABASE SETUP ---
// Railway will provide the MONGO_URL automatically once we attach a database
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' }, // Player, Moderator, Admin
    credits: { type: Number, default: 1250 },
    status: { type: String, default: 'Offline' }, // Active, Offline, Banned
    joinDate: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- SHARED TABLES ENGINE (REAL-TIME LOOP) ---
let sharedTables = {
    time: 15,
    status: 'BETTING', // BETTING or RESOLVING
    bets: [] // Array to hold all current bets across all games
};

// The Global Casino Clock
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets'); // Tell all clients to freeze betting buttons
            
            // TODO: Generate real outcomes for Baccarat, Perya, SicBo, DT here
            // Distribute winnings to the players who bet in sharedTables.bets
            
            // Broadcast outcomes
            io.emit('sharedResults', { message: "Dealer resolving bets..." });

            // Wait 5 seconds, then reset for next round
            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); // Tell clients to unlock betting
            }, 5000);
        }
    }
}, 1000);

// --- SOCKET.IO CLIENT COMMUNICATION ---
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    socket.emit('timerUpdate', sharedTables.time); // Send current time immediately

    // 1. AUTHENTICATION
    socket.on('login', async (data) => {
        try {
            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login.');
            if (user.status === 'Banned') return socket.emit('authError', 'Account is banned.');

            user.status = 'Active';
            await user.save();
            
            socket.user = user; // Attach user to socket session
            socket.emit('loginSuccess', { username: user.username, credits: user.credits, role: user.role });
            io.emit('chatMessage', { user: 'System', text: `${user.username} entered the casino.`, sys: true });
        } catch (err) {
            socket.emit('authError', 'Server error.');
        }
    });

    socket.on('register', async (data) => {
        try {
            const exists = await User.findOne({ username: data.username });
            if (exists) return socket.emit('authError', 'Username taken.');

            const newUser = new User({ username: data.username, password: data.password });
            await newUser.save();
            socket.emit('registerSuccess', 'Account created!');
        } catch (err) {
            socket.emit('authError', 'Server error.');
        }
    });

    // 2. SOLO GAMES (Example: Coin Flip)
    socket.on('playCoin', async (data) => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        const bet = parseInt(data.bet);
        
        if (bet > user.credits || bet <= 0) return socket.emit('toast', { msg: 'Invalid bet.', type: 'error' });

        // Deduct bet securely on the backend
        user.credits -= bet;
        
        // RNG Logic on Backend
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        let payout = 0;
        let message = `Landed on ${result}.`;

        if (data.choice === result) {
            payout = bet * 2;
            message = `Landed on ${result}! You win.`;
            user.credits += payout;
        }

        await user.save();
        
        // Send outcome and new balance back to player
        socket.emit('coinResult', { result: result, payout: payout, newBalance: user.credits, msg: message });
    });

    // Handle Disconnect
    socket.on('disconnect', async () => {
        if (socket.user) {
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' });
            console.log(`❌ User disconnected: ${socket.user.username}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Casino Server running on port ${PORT}`);
});