import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 8080;
const ADMIN_PIN = process.env.ADMIN_PIN || "42069";
const CHIP_RESET_OWNER_ID = "229051";
const DISCORD_BOT_SECRET = process.env.DISCORD_BOT_SECRET || "";
const SPIN_DURATION_MS = 4300;
const RACE_DURATION_MS = 6500;
const AUTO_START_DELAY_MS = 20_000;
const MAX_CHIP_AMOUNT = 9_000_000_000_000_000;
const NEW_PLAYER_STARTING_CHIPS = 10_000_000;
const SLOT_MAX_HISTORY = 100;
// Free spins must stay limited because they can award more free spins.
const SLOT_FREE_SPINS_AWARD = { 3: 3, 4: 5, 5: 8 };
const MINES_BOARD_SIZE = 25;
const MINES_MIN_COUNT = 1;
const MINES_MAX_COUNT = 24;
const MINES_HOUSE_FACTOR = 0.97;
const MINES_MAX_HISTORY = 100;
const DEAL_CASE_COUNT = 16;
const DEAL_CASES_PER_ROUND = 3;
const DEAL_MAX_HISTORY = 100;
const DAILY_SPIN_MAX_HISTORY = 500;

// Edit this one list to add, remove or rebalance daily-spin prizes.
// type: "chips" credits the player immediately.
// type: "item" creates a Discord delivery request.
const DAILY_SPIN_PRIZES = [
    { id: "chips_10m", type: "chips", label: "100M Chips", amount: 10_000_000, weight: 26 },
    { id: "chips_50m", type: "chips", label: "50M Chips", amount: 50_000_000, weight: 15 },
    { id: "chips_100m", type: "chips", label: "100M Chips", amount: 100_000_000, weight: 3 },

    
    { id: "Concrete_100", type: "item", label: "100x Concrete", itemName: "100x Concrete", quantity: 1, weight: 6 },
    { id: "Concrete x250", type: "item", label: "250x Concrete", itemName: "250x Concrete", quantity: 1, weight: 3 },

    { id: "nothing", type: "nothing", label: "Nothing", weight: 46 }
];

const DEAL_OFFER_BASE_FACTOR = 0.82;
const DEAL_OFFER_PROGRESS_BONUS = 0.26;
const DEAL_OFFER_MAX_FACTOR = 1.05;
const DATA_DIRECTORY = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/app/data";
const CHIP_DATA_FILE = path.join(DATA_DIRECTORY, "casino-chips.json");
let chipSaveTimer = null;
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-Banker-Pin", "X-Discord-Bot-Secret"] }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const adminTokens = new Set();

let wheelAutoTimer = null;
let blackjackAutoTimer = null;
let racingAutoTimer = null;
let rouletteAutoTimer = null;


const wheel = [
    { multiplier: 0,    weight: 12 },
    { multiplier: 0.1,  weight: 12 },
    { multiplier: 0.25, weight: 11 },
    { multiplier: 0.5,  weight: 10 },
    { multiplier: 0.75, weight: 10 },

    { multiplier: 1,    weight: 5 },

    { multiplier: 1.25, weight: 15 },
    { multiplier: 1.5,  weight: 10 },
    { multiplier: 2,    weight: 7 },
    { multiplier: 3,    weight: 4 },
    { multiplier: 5,    weight: 3 },
    { multiplier: 10,   weight: 1 }
];

const state = {
    chips: {
        balances: {},
        playerNames: {},
        requests: [],
        withdrawalRequests: [],
        discordEvents: [],
        transactions: [],
        dailyHouseStats: {},
        leaderboardStats: {}
    },
    slots: {
        history: [],
        freeSpins: {},
        lastPaidBet: {}
    },

    mines: {
        games: {},
        history: []
    },

    deal: {
        games: {},
        history: []
    },

    roulette: {
        bets: [],
        history: [],
        spinning: false,
        activeSpin: null,
        autoStartAt: null
    },

    chicken: {
        games: {},
        history: []
    },

    dailySpin: {
        claims: {},
        history: [],
        deliveries: {}
    },

    wheel: {
        bets: [],
        history: [],
        spinning: false,
        activeSpin: null,
        autoStartAt: null
    },
    blackjack: {
        bets: [],
        players: [],
        dealerHand: [],
        deck: [],
        status: "waiting", 
        currentTurnIndex: 0,
        history: [],
        autoStartAt: null
    },
racing: {
    horses: [
        { id: "Nunu", name: "Nunu Royale" },
        { id: "Pxpe", name: "Pxpe Express" },
        { id: "Crack", name: "WhipCrack" },
        { id: "Beans", name: "Jelly Queen" },
        { id: "nipple", name: "Zitze Nipple" },
        { id: "famil", name: "Uncle Famil" }
    ],
    bets: [],
    history: [],
    racing: false,
    activeRace: null,
    autoStartAt: null
}
};

function loadChipData() {
    try {
        fs.mkdirSync(DATA_DIRECTORY, {
            recursive: true
        });

        if (!fs.existsSync(CHIP_DATA_FILE)) {
            console.log(
                "No saved chip file found. Starting with empty balances."
            );
            return;
        }

        const raw = fs.readFileSync(
            CHIP_DATA_FILE,
            "utf8"
        );

        const saved = JSON.parse(raw);

        if (
            saved.balances &&
            typeof saved.balances === "object"
        ) {
            state.chips.balances = saved.balances;
        }

        if (
            saved.playerNames &&
            typeof saved.playerNames === "object"
        ) {
            state.chips.playerNames = saved.playerNames;
        }

        if (Array.isArray(saved.requests)) {
            state.chips.requests = saved.requests;
        }

        if (Array.isArray(saved.withdrawalRequests)) {
            state.chips.withdrawalRequests =
                saved.withdrawalRequests.slice(0, 200);
        }

        if (Array.isArray(saved.discordEvents)) {
            state.chips.discordEvents =
                saved.discordEvents.slice(0, 500);
        }

        if (Array.isArray(saved.transactions)) {
            state.chips.transactions =
                saved.transactions.slice(0, 200);
        }

        if (
            saved.dailyHouseStats &&
            typeof saved.dailyHouseStats === "object"
        ) {
            state.chips.dailyHouseStats =
                saved.dailyHouseStats;
        }

        if (
            saved.leaderboardStats &&
            typeof saved.leaderboardStats === "object"
        ) {
            state.chips.leaderboardStats =
                saved.leaderboardStats;
        }

        if (saved.slots && typeof saved.slots === "object") {
            if (Array.isArray(saved.slots.history)) {
                state.slots.history = saved.slots.history.slice(0, SLOT_MAX_HISTORY);
            }
            if (saved.slots.freeSpins && typeof saved.slots.freeSpins === "object") {
                state.slots.freeSpins = saved.slots.freeSpins;
            }
            if (saved.slots.lastPaidBet && typeof saved.slots.lastPaidBet === "object") {
                state.slots.lastPaidBet = saved.slots.lastPaidBet;
            }
        }

        if (saved.mines && typeof saved.mines === "object") {
            if (saved.mines.games && typeof saved.mines.games === "object") {
                state.mines.games = saved.mines.games;
            }

            if (Array.isArray(saved.mines.history)) {
                state.mines.history =
                    saved.mines.history.slice(0, MINES_MAX_HISTORY);
            }
        }

        if (saved.deal && typeof saved.deal === "object") {
            if (saved.deal.games && typeof saved.deal.games === "object") {
                state.deal.games = saved.deal.games;
            }

            if (Array.isArray(saved.deal.history)) {
                state.deal.history =
                    saved.deal.history.slice(0, DEAL_MAX_HISTORY);
            }
        }

        if (
            saved.roulette &&
            typeof saved.roulette === "object"
        ) {
            if (Array.isArray(saved.roulette.history)) {
                state.roulette.history =
                    saved.roulette.history.slice(0, 30);
            }

            if (Array.isArray(saved.roulette.bets)) {
                state.roulette.bets =
                    saved.roulette.bets;
            }

            state.roulette.spinning = false;
            state.roulette.activeSpin = null;
            state.roulette.autoStartAt = null;
        }

        if (
            saved.chicken &&
            typeof saved.chicken === "object" &&
            Array.isArray(saved.chicken.history)
        ) {
            state.chicken.history =
                saved.chicken.history.slice(0, 50);
        }

        if (saved.dailySpin && typeof saved.dailySpin === "object") {
            if (saved.dailySpin.claims && typeof saved.dailySpin.claims === "object") {
                state.dailySpin.claims = saved.dailySpin.claims;
            }
            if (Array.isArray(saved.dailySpin.history)) {
                state.dailySpin.history = saved.dailySpin.history.slice(0, DAILY_SPIN_MAX_HISTORY);
            }
            if (saved.dailySpin.deliveries && typeof saved.dailySpin.deliveries === "object") {
                state.dailySpin.deliveries = saved.dailySpin.deliveries;
            }
        }

        console.log(
            `Loaded chip balances for ${
                Object.keys(state.chips.balances).length
            } players`
        );
    } catch (error) {
        console.error(
            "Failed to load chip data:",
            error
        );
    }
}

function saveChipDataImmediately() {
    try {
        fs.mkdirSync(DATA_DIRECTORY, {
            recursive: true
        });

        const temporaryFile =
            CHIP_DATA_FILE + ".tmp";

        const data = {
            balances: state.chips.balances,
            playerNames: state.chips.playerNames,
            requests: state.chips.requests,
            withdrawalRequests:
                state.chips.withdrawalRequests,
            discordEvents:
                state.chips.discordEvents,
            transactions: state.chips.transactions,
            dailyHouseStats: state.chips.dailyHouseStats,
            leaderboardStats: state.chips.leaderboardStats,
            slots: {
                history: state.slots.history,
                freeSpins: state.slots.freeSpins,
                lastPaidBet: state.slots.lastPaidBet
            },
            mines: {
                games: state.mines.games,
                history: state.mines.history
            },
            deal: {
                games: state.deal.games,
                history: state.deal.history
            },
            roulette: {
                bets: state.roulette.bets,
                history: state.roulette.history
            },
            chicken: {
                history: state.chicken.history
            },
            dailySpin: {
                claims: state.dailySpin.claims,
                history: state.dailySpin.history,
                deliveries: state.dailySpin.deliveries
            },
            savedAt: Date.now()
        };

        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(data, null, 2),
            "utf8"
        );

        fs.renameSync(
            temporaryFile,
            CHIP_DATA_FILE
        );
    } catch (error) {
        console.error(
            "Failed to save chip data:",
            error
        );
    }
}

function queueChipSave() {
    if (chipSaveTimer) {
        clearTimeout(chipSaveTimer);
    }

    chipSaveTimer = setTimeout(() => {
        chipSaveTimer = null;
        saveChipDataImmediately();
    }, 100);
}

function getUtcDateKey(timestamp = Date.now()) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function getOrCreateDailyHouseStats(dateKey = getUtcDateKey()) {
    if (!state.chips.dailyHouseStats[dateKey]) {
        state.chips.dailyHouseStats[dateKey] = {
            date: dateKey,
            bets: 0,
            payouts: 0,
            refunds: 0,
            profit: 0,
            games: {}
        };
    }

    return state.chips.dailyHouseStats[dateKey];
}

function recordHouseMovement({
    amount,
    movement,
    gameType = ""
}) {
    const value = parseChipAmount(amount);

    if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        !gameType
    ) {
        return;
    }

    const stats = getOrCreateDailyHouseStats();
    const game = stats.games[gameType] || {
        bets: 0,
        payouts: 0,
        refunds: 0,
        profit: 0
    };

    if (movement === "bet") {
        stats.bets += value;
        stats.profit += value;
        game.bets += value;
        game.profit += value;
    } else if (movement === "payout") {
        stats.payouts += value;
        stats.profit -= value;
        game.payouts += value;
        game.profit -= value;
    } else if (movement === "refund") {
        stats.refunds += value;
        stats.profit -= value;
        game.refunds += value;
        game.profit -= value;
    } else {
        return;
    }

    stats.games[gameType] = game;

    // Keep roughly one year of daily records.
    const keys = Object.keys(
        state.chips.dailyHouseStats
    ).sort();

    while (keys.length > 370) {
        const oldest = keys.shift();
        delete state.chips.dailyHouseStats[oldest];
    }
}

function cleanPlayerId(value) {
    return String(value || "").trim().slice(0, 80);
}

function cleanPlayerName(value) {
    return String(value || "Player").trim().slice(0, 60);
}

function parseChipAmount(value) {
    if (value == null) return 0;

    const text = String(value)
        .trim()
        .toLowerCase()
        .replace(/,/g, "");

    const match = text.match(
        /^([0-9]+(?:\.[0-9]+)?)\s*([kmbtq]?)$/
    );

    if (!match) {
        return 0;
    }

    const multipliers = {
        "": 1,
        k: 1e3,
        m: 1e6,
        b: 1e9,
        t: 1e12,
        q: 1e15
    };

    const amount =
        Number(match[1]) *
        multipliers[match[2]];

    if (
        !Number.isFinite(amount) ||
        amount < 1
    ) {
        return 0;
    }

    return Math.floor(amount);
}

function cleanAmount(value) {
    const amount = parseChipAmount(value);

    if (
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > MAX_CHIP_AMOUNT
    ) {
        return 0;
    }

    return amount;
}

function rememberPlayer(playerId, playerName) {
    const id = cleanPlayerId(playerId);
    if (!id) return;

    const name = playerName
        ? cleanPlayerName(playerName)
        : (
            state.chips.playerNames[id] ||
            "Player"
        );

    if (playerName) {
        state.chips.playerNames[id] = name;
    }

    const isNewPlayer =
        !Object.prototype.hasOwnProperty.call(
            state.chips.balances,
            id
        );

    if (!isNewPlayer) {
        return;
    }

    state.chips.balances[id] =
        NEW_PLAYER_STARTING_CHIPS;

    state.chips.transactions.unshift({
        transactionId:
            crypto.randomBytes(8).toString("hex"),
        playerId: id,
        playerName: name,
        amount: NEW_PLAYER_STARTING_CHIPS,
        type: "welcome-bonus",
        gameType: "",
        note:
            "Automatic new-player starting chips",
        balanceAfter:
            NEW_PLAYER_STARTING_CHIPS,
        createdAt: Date.now()
    });

    state.chips.transactions =
        state.chips.transactions.slice(0, 200);

    queueChipSave();

    console.log(
        `New player ${id} received ` +
        `${NEW_PLAYER_STARTING_CHIPS} starting chips`
    );
}

function getChipBalance(playerId) {
    const id = cleanPlayerId(playerId);
    if (!id) return 0;

    rememberPlayer(id);

    return Math.max(
        0,
        Math.floor(Number(state.chips.balances[id] || 0))
    );
}

function addChipTransaction({
    playerId,
    playerName,
    amount,
    type,
    gameType = "",
    note = ""
}) {
    const transaction = {
        transactionId: crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName:
            playerName ||
            state.chips.playerNames[playerId] ||
            "Player",
        amount,
        type,
        gameType,
        note,
        balanceAfter: getChipBalance(playerId),
        createdAt: Date.now()
    };

    state.chips.transactions.unshift(transaction);
    state.chips.transactions =
        state.chips.transactions.slice(0, 200);

    return transaction;
}

function getOrCreateGamblerStats(playerId, playerName) {
    const id = cleanPlayerId(playerId);

    if (!state.chips.leaderboardStats[id]) {
        state.chips.leaderboardStats[id] = {
            playerId: id,
            playerName:
                cleanPlayerName(
                    playerName ||
                    state.chips.playerNames[id] ||
                    "Player"
                ),
            moneySpent: 0,
            payouts: 0,
            refunds: 0,
            moneyLost: 0
        };
    }

    const stats =
        state.chips.leaderboardStats[id];

    if (playerName) {
        stats.playerName =
            cleanPlayerName(playerName);
    }

    return stats;
}

function updateGamblerStats(
    playerId,
    playerName,
    amount,
    movement
) {
    const value = parseChipAmount(amount);

    if (!value || value <= 0) return;

    const stats = getOrCreateGamblerStats(
        playerId,
        playerName
    );

    if (movement === "bet") {
        stats.moneySpent += value;
    } else if (movement === "payout") {
        stats.payouts += value;
    } else if (movement === "refund") {
        stats.refunds += value;
    }

    // Positive = net chips lost to the casino.
    // Negative = the player is in overall profit.
    stats.moneyLost =
        stats.moneySpent -
        stats.payouts -
        stats.refunds;
}

function getLeaderboardForPlayer(playerId) {
    const id = cleanPlayerId(playerId);

    const ranked = Object.values(
        state.chips.leaderboardStats || {}
    )
        .filter(
            entry =>
                Number(entry.moneySpent || 0) > 0
        )
        .sort(
            (a, b) =>
                Number(b.moneySpent || 0) -
                Number(a.moneySpent || 0)
        )
        .map((entry, index) => ({
            position: index + 1,
            playerId: entry.playerId,
            playerName:
                entry.playerName ||
                state.chips.playerNames[
                    entry.playerId
                ] ||
                "Player",
            moneySpent:
                Number(entry.moneySpent || 0),
            moneyLost:
                Number(entry.moneyLost || 0)
        }));

    const myEntry = ranked.find(
        entry => entry.playerId === id
    ) || null;

    return {
        top10: ranked.slice(0, 10),
        totalGamblers: ranked.length,
        myPosition:
            myEntry?.position || null,
        myStats: myEntry
    };
}

function creditChips(playerId, amount, options = {}) {
    const id = cleanPlayerId(playerId);
    const value = Math.floor(Number(amount || 0));

    if (
        !id ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        return false;
    }

    rememberPlayer(id, options.playerName);

    const current = getChipBalance(id);
    const next = current + value;

    if (
        !Number.isSafeInteger(next) ||
        next > MAX_CHIP_AMOUNT
    ) {
        return false;
    }

    state.chips.balances[id] = next;

    if (value > 0) {
        addChipTransaction({
            playerId: id,
            playerName: options.playerName,
            amount: value,
            type: options.type || "credit",
            gameType: options.gameType || "",
            note: options.note || ""
        });

        if (
            options.type === "payout" &&
            options.gameType
        ) {
            updateGamblerStats(
                id,
                options.playerName,
                value,
                "payout"
            );
            recordHouseMovement({
                amount: value,
                movement: "payout",
                gameType: options.gameType
            });
        } else if (
            options.type === "bet-refund" &&
            options.gameType
        ) {
            updateGamblerStats(
                id,
                options.playerName,
                value,
                "refund"
            );
            recordHouseMovement({
                amount: value,
                movement: "refund",
                gameType: options.gameType
            });
        }
    }

    queueChipSave();

    return true;
}

function debitChips(playerId, amount, options = {}) {
    const id = cleanPlayerId(playerId);
    const value = cleanAmount(amount);

    if (!id || !value) {
        return {
            ok: false,
            error: "Invalid chip amount"
        };
    }

    rememberPlayer(id, options.playerName);

    const balance = getChipBalance(id);

    if (balance < value) {
        return {
            ok: false,
            error: `Not enough chips. Balance: ${balance}`
        };
    }

    state.chips.balances[id] = balance - value;

    addChipTransaction({
        playerId: id,
        playerName: options.playerName,
        amount: -value,
        type: options.type || "bet",
        gameType: options.gameType || "",
        note: options.note || ""
    });

    if (
        (
            options.type === "bet" ||
            options.type === "bet-adjustment"
        ) &&
        options.gameType
    ) {
        updateGamblerStats(
            id,
            options.playerName,
            value,
            "bet"
        );
        recordHouseMovement({
            amount: value,
            movement: "bet",
            gameType: options.gameType
        });
    }

    queueChipSave();

    return {
        ok: true,
        balance: state.chips.balances[id]
    };
}

function replaceReservedBet(
    existing,
    newAmount,
    playerId,
    playerName,
    gameType
) {
    const oldAmount = parseChipAmount(
        existing?.amount
    );

    const difference = newAmount - oldAmount;

    if (difference > 0) {
        return debitChips(
            playerId,
            difference,
            {
                playerName,
                type: "bet-adjustment",
                gameType,
                note: `Increased ${gameType} bet`
            }
        );
    }

    if (difference < 0) {
        const refunded = creditChips(
            playerId,
            Math.abs(difference),
            {
                playerName,
                type: "bet-refund",
                gameType,
                note: `Reduced ${gameType} bet`
            }
        );

        if (!refunded) {
            return {
                ok: false,
                error: "Could not refund chip difference"
            };
        }
    }

    return {
        ok: true,
        balance: getChipBalance(playerId)
    };
}

function refundBets(bets, gameType, note) {
    for (const bet of bets || []) {
        creditChips(
            bet.playerId,
            parseChipAmount(bet.amount),
            {
                playerName: bet.playerName,
                type: "bet-refund",
                gameType,
                note
            }
        );
    }
}

function addDiscordEvent(type, data = {}) {
    const event = {
        eventId:
            crypto.randomBytes(8).toString("hex"),
        type: String(type || "event"),
        postedAt: null,
        createdAt: Date.now(),
        ...data
    };

    state.chips.discordEvents.unshift(event);
    state.chips.discordEvents =
        state.chips.discordEvents.slice(0, 500);

    queueChipSave();
    return event;
}

function publicChipState() {
    return {
        balances: {
            ...state.chips.balances
        },

        playerNames: {
            ...state.chips.playerNames
        },

        requests: state.chips.requests.map(
            request => ({ ...request })
        ),

        withdrawalRequests:
            state.chips.withdrawalRequests
                .filter(request =>
                    request.status === "pending"
                )
                .map(request => ({ ...request })),

        transactions: state.chips.transactions
            .slice(0, 50)
            .map(transaction => ({ ...transaction }))
    }
};



const SLOT_SYMBOLS = [
    // Tuned for roughly 95% long-term RTP across the complete slot system:
    // paylines, wild substitutions, scatter nudges, 3/5/8 free spins,
    // free-spin multipliers and returning the original bet on paid wins.
    //
    // Normal line payouts use 1/10th of the total bet per payline.
    { id: "pear", label: "🍐", weight: 34, pays: { 3: 1, 4: 3, 5: 10 } },
    { id: "cherry", label: "🍒", weight: 28, pays: { 3: 1, 4: 4, 5: 14 } },
    { id: "bell", label: "🔔", weight: 22, pays: { 3: 2, 4: 6, 5: 20 } },
    { id: "gem", label: "💎", weight: 16, pays: { 3: 2, 4: 8, 5: 30 } },
    { id: "crown", label: "👑", weight: 11, pays: { 3: 3, 4: 12, 5: 50 } },
    { id: "seven", label: "7️⃣", weight: 7, pays: { 3: 5, 4: 20, 5: 100 } },
    { id: "wild", label: "🃏", weight: 5, pays: { 3: 8, 4: 40, 5: 200 } },

    // Scatter payouts use the full total bet rather than the per-line bet.
    { id: "scatter", label: "🐉", weight: 5, pays: { 3: 1, 4: 5, 5: 20 } }
];

const SLOT_PAYLINES = [
    [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
    [0,0,1,2,2], [2,2,1,0,0], [1,0,0,0,1], [1,2,2,2,1], [0,1,1,1,0]
];

function pickSlotSymbol() {
    const total = SLOT_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
    let roll = crypto.randomInt(1, total + 1);
    for (const symbol of SLOT_SYMBOLS) {
        roll -= symbol.weight;
        if (roll <= 0) return symbol.id;
    }
    return "pear";
}

function createSlotGrid() {
    return Array.from({ length: 3 }, () =>
        Array.from({ length: 5 }, () => pickSlotSymbol())
    );
}

function pickSlotNonScatterSymbol() {
    let symbol = pickSlotSymbol();

    while (symbol === "scatter") {
        symbol = pickSlotSymbol();
    }

    return symbol;
}

function findScatterCells(grid) {
    const cells = [];

    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
            if (grid[row][col] === "scatter") {
                cells.push({ row, col });
            }
        }
    }

    return cells;
}

function canStartScatterNudge(grid) {
    const scatters = findScatterCells(grid);

    return (
        scatters.length === 2 &&
        scatters[0].col !== scatters[1].col &&
        scatters.every(cell => cell.row < 2)
    );
}

function createScatterNudgeStep(previousGrid, lockedScatters) {
    const nextGrid = previousGrid.map(row => [...row]);
    const lockedColumns = new Set(
        lockedScatters.map(cell => cell.col)
    );

    // Only unlocked reels spin again.
    for (let col = 0; col < 5; col++) {
        if (lockedColumns.has(col)) continue;

        for (let row = 0; row < 3; row++) {
            nextGrid[row][col] = pickSlotSymbol();
        }
    }

    const movedScatters = lockedScatters.map(cell => {
        const nextRow = Math.min(2, cell.row + 1);

        if (nextRow !== cell.row) {
            nextGrid[cell.row][cell.col] =
                pickSlotNonScatterSymbol();

            nextGrid[nextRow][cell.col] =
                "scatter";
        }

        return {
            row: nextRow,
            col: cell.col
        };
    });

    return {
        grid: nextGrid,
        lockedScatters: movedScatters
    };
}

function runScatterNudgeFeature(initialGrid) {
    if (!canStartScatterNudge(initialGrid)) {
        return {
            triggered: false,
            finalGrid: initialGrid,
            steps: []
        };
    }

    let currentGrid = initialGrid.map(row => [...row]);
    let lockedScatters = findScatterCells(currentGrid);
    const steps = [];

    // A scatter can move at most twice: top -> middle -> bottom.
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (!lockedScatters.some(cell => cell.row < 2)) {
            break;
        }

        const step = createScatterNudgeStep(
            currentGrid,
            lockedScatters
        );

        currentGrid = step.grid;
        lockedScatters = step.lockedScatters;

        const scatterCount =
            findScatterCells(currentGrid).length;

        steps.push({
            attempt,
            grid: currentGrid.map(row => [...row]),
            lockedColumns: lockedScatters.map(
                cell => cell.col
            ),
            lockedScatters: lockedScatters.map(
                cell => ({ ...cell })
            ),
            scatterCount,
            success: scatterCount >= 3
        });

        if (scatterCount >= 3) {
            break;
        }
    }

    return {
        triggered: true,
        finalGrid: currentGrid,
        steps
    };
}

function evaluateSlotGrid(grid, betAmount) {
    let payout = 0;
    const lineWins = [];
    const winningCells = [];
    const lineBet = betAmount / SLOT_PAYLINES.length;

    SLOT_PAYLINES.forEach((rows, lineIndex) => {
        const symbols = rows.map((row, col) => grid[row][col]);
        let base = symbols[0] === "wild" ? symbols.find(s => s !== "wild" && s !== "scatter") || "wild" : symbols[0];
        if (base === "scatter") return;
        let count = 0;
        for (const symbol of symbols) {
            if (symbol === base || symbol === "wild") count += 1;
            else break;
        }
        if (count >= 3) {
            const def = SLOT_SYMBOLS.find(s => s.id === base) || SLOT_SYMBOLS.find(s => s.id === "wild");
            const multiplier = Number(def.pays[count] || 0);
            const win = Math.floor(lineBet * multiplier);
            payout += win;
            lineWins.push({ line: lineIndex + 1, symbol: base, count, multiplier, win });
            for (let col = 0; col < count; col++) winningCells.push({ row: rows[col], col });
        }
    });

    const scatterCount = grid.flat().filter(symbol => symbol === "scatter").length;
    let freeSpinsAwarded = 0;
    if (scatterCount >= 3) {
        const count = Math.min(5, scatterCount);
        const scatterDef = SLOT_SYMBOLS.find(s => s.id === "scatter");
        payout += Math.floor(betAmount * Number(scatterDef.pays[count] || 0));
        freeSpinsAwarded = SLOT_FREE_SPINS_AWARD[count] || 0;
    }

    // Paid and free spins use exactly the same win calculation.
    // Any displayed win returns at least the stake value, and the route
    // adds the stake back to produce the same gross payout as a paid spin.
    let minimumWinApplied = false;

    if (
        (lineWins.length > 0 || scatterCount >= 3) &&
        payout < betAmount
    ) {
        payout = betAmount;
        minimumWinApplied = true;
    }

    const bonusMultiplier = 1;

    return {
        payout: Math.floor(payout),
        lineWins,
        winningCells,
        scatterCount,
        freeSpinsAwarded,
        bonusMultiplier,
        minimumWinApplied
    };
}

function publicSlotsState() {
    return {
        history: state.slots.history.slice(0, 50),
        freeSpins: { ...state.slots.freeSpins },
        paytable: SLOT_SYMBOLS.map(symbol => ({ symbol: symbol.id, label: symbol.label, pays: symbol.pays })),
        paylines: SLOT_PAYLINES.length
    };
}



const DEAL_PRIZE_MULTIPLIERS = [
    // Average value is exactly x0.95 of the player's bet.
    // This gives the game a realistic long-term house edge while
    // still leaving several profitable cases.
    0,
    0.05,
    0.10,
    0.20,
    0.30,
    0.40,
    0.50,
    0.60,
    0.75,
    0.90,
    1,
    1.20,
    1.50,
    2,
    2.50,
    3.20
];

function shuffleValues(values) {
    const shuffled = [...values];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [shuffled[i], shuffled[j]] =
            [shuffled[j], shuffled[i]];
    }

    return shuffled;
}

function publicDealGame(game) {
    if (!game) return null;

    return {
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        chosenCase: game.chosenCase,
        openedCases: [...game.openedCases],
        openedValues: { ...game.openedValues },
        currentOffer: game.currentOffer || 0,
        casesToOpen:
            game.currentOffer > 0
                ? 0
                : Math.min(
                    DEAL_CASES_PER_ROUND,
                    DEAL_CASE_COUNT -
                    game.openedCases.length -
                    1
                ),
        remainingCases: DEAL_CASE_COUNT -
            game.openedCases.length,
        status: game.status,
        createdAt: game.createdAt
    };
}

function publicDealState() {
    const games = {};

    for (const [playerId, game] of Object.entries(
        state.deal.games
    )) {
        games[playerId] = publicDealGame(game);
    }

    return {
        caseCount: DEAL_CASE_COUNT,
        games,
        history: state.deal.history
            .slice(0, 50)
            .map(entry => ({ ...entry }))
    };
}

function calculateDealOffer(game) {
    const remainingValues = game.caseValues.filter(
        (_, index) =>
            !game.openedCases.includes(index)
    );

    if (!remainingValues.length) return 0;

    const average = remainingValues.reduce(
        (sum, value) => sum + value,
        0
    ) / remainingValues.length;

    const progress =
        game.openedCases.length /
        (DEAL_CASE_COUNT - 1);

    const factor = Math.min(
        DEAL_OFFER_MAX_FACTOR,
        DEAL_OFFER_BASE_FACTOR +
        progress * DEAL_OFFER_PROGRESS_BONUS
    );

    // Round to whole chips after applying the banker factor.
    // Approximate offer levels are now:
    // first offer: 87% of remaining-case average
    // middle offers: 92% to 98%
    // final offers: up to 105%
    return Math.max(
        1,
        Math.floor(average * factor)
    );
}

function finishDealGame(game, result, payout) {
    const chosenValue =
        game.caseValues[game.chosenCase];

    const historyEntry = {
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        chosenCase: game.chosenCase,
        chosenValue,
        result,
        payout,
        profit: payout - game.betAmount,
        openedCases: [...game.openedCases],
        createdAt: Date.now()
    };

    state.deal.history.unshift(historyEntry);
    state.deal.history =
        state.deal.history.slice(
            0,
            DEAL_MAX_HISTORY
        );

    delete state.deal.games[game.playerId];
    queueChipSave();

    return historyEntry;
}

function combination(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;

    k = Math.min(k, n - k);

    let result = 1;

    for (let i = 1; i <= k; i++) {
        result =
            (result * (n - k + i)) /
            i;
    }

    return result;
}

function getMinesMultiplier(mineCount, safeReveals) {
    if (safeReveals <= 0) return 1;

    const totalWays =
        combination(MINES_BOARD_SIZE, safeReveals);

    const safeWays =
        combination(
            MINES_BOARD_SIZE - mineCount,
            safeReveals
        );

    if (!safeWays) return 0;

    const fairMultiplier =
        totalWays / safeWays;

    return Math.max(
        1.01,
        Math.floor(
            fairMultiplier *
            MINES_HOUSE_FACTOR *
            100
        ) / 100
    );
}

function createMinePositions(mineCount) {
    const cells = Array.from(
        { length: MINES_BOARD_SIZE },
        (_, index) => index
    );

    for (let i = cells.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [cells[i], cells[j]] =
            [cells[j], cells[i]];
    }

    return cells.slice(0, mineCount);
}

function publicMineGame(game) {
    if (!game) return null;

    return {
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        mineCount: game.mineCount,
        revealed: [...game.revealed],
        safeReveals: game.safeReveals,
        revealed: [...game.revealed],
        multiplier: getMinesMultiplier(
            game.mineCount,
            game.safeReveals
        ),
        potentialPayout: Math.floor(
            game.betAmount *
            getMinesMultiplier(
                game.mineCount,
                game.safeReveals
            )
        ),
        status: game.status,
        createdAt: game.createdAt
    };
}

function publicMinesState() {
    const games = {};

    for (const [playerId, game] of Object.entries(
        state.mines.games
    )) {
        games[playerId] = publicMineGame(game);
    }

    return {
        boardSize: MINES_BOARD_SIZE,
        minimumMines: MINES_MIN_COUNT,
        maximumMines: MINES_MAX_COUNT,
        games,
        history: state.mines.history
            .slice(0, 50)
            .map(entry => ({ ...entry }))
    };
}

function finishMineGame(game, result, payout, hitCell = null) {
    const historyEntry = {
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        mineCount: game.mineCount,
        safeReveals: game.safeReveals,
        multiplier:
            result === "cashout" ||
            result === "cleared"
                ? getMinesMultiplier(
                    game.mineCount,
                    game.safeReveals
                )
                : 0,
        payout,
        profit: payout - game.betAmount,
        result,
        hitCell,
        minePositions:
            result === "mine"
                ? [...game.minePositions]
                : undefined,
        createdAt: Date.now()
    };

    state.mines.history.unshift(historyEntry);
    state.mines.history =
        state.mines.history.slice(
            0,
            MINES_MAX_HISTORY
        );

    delete state.mines.games[game.playerId];
    queueChipSave();

    return historyEntry;
}

function pickMultiplier() {
    const total = wheel.reduce((sum, item) => sum + item.weight, 0);
    let roll = crypto.randomInt(1, total + 1);

    for (const item of wheel) {
        roll -= item.weight;
        if (roll <= 0) return item.multiplier;
    }

    return 1;
}

function isAdminToken(token) {
    return token && adminTokens.has(String(token));
}

function getToken(req) {
    return String(req.headers.authorization || req.body?.token || "").replace(/^Bearer\s+/i, "").trim();
}

function requireAdmin(req, res) {
    const token = getToken(req);
    if (!isAdminToken(token)) {
        res.status(403).json({ ok: false, error: "Not banker" });
        return false;
    }
    return true;
}

function requireDiscordBot(req, res) {
    const providedSecret = String(
        req.headers["x-discord-bot-secret"] || ""
    ).trim();

    if (
        !DISCORD_BOT_SECRET ||
        providedSecret !== DISCORD_BOT_SECRET
    ) {
        res.status(403).json({
            ok: false,
            error: "Discord bot authentication failed"
        });
        return false;
    }

    return true;
}

function publicWheelState() {
    return {
        bets: state.wheel.bets,
        history: state.wheel.history,
        spinning: state.wheel.spinning,
        activeSpin: state.wheel.activeSpin,
        autoStartAt: state.wheel.autoStartAt,
        wheel: wheel.map(item => item.multiplier)
    };
}

function makeDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    const deck = [];

    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }

    for (let i = deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
}

function drawCard() {
    if (!state.blackjack.deck.length) state.blackjack.deck = makeDeck();
    return state.blackjack.deck.pop();
}

function handValue(hand) {
    let total = 0;
    let aces = 0;

    for (const card of hand) {
        if (card.rank === "A") {
            total += 11;
            aces += 1;
        } else if (["K", "Q", "J"].includes(card.rank)) {
            total += 10;
        } else {
            total += Number(card.rank);
        }
    }

    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }

    return total;
}

function activeBlackjackPlayer() {
    if (state.blackjack.status !== "playing") return null;
    return state.blackjack.players[state.blackjack.currentTurnIndex] || null;
}

function moveToNextBlackjackTurn() {
    while (state.blackjack.currentTurnIndex < state.blackjack.players.length - 1) {
        state.blackjack.currentTurnIndex += 1;
        const player = state.blackjack.players[state.blackjack.currentTurnIndex];
        if (player && player.status === "playing") return;
    }

    finishBlackjackRound();
}

function finishBlackjackRound() {
    const bj = state.blackjack;
    if (bj.status !== "playing") return;

    bj.status = "finished";
    bj.currentTurnIndex = -1;

    while (handValue(bj.dealerHand) < 17) {
        bj.dealerHand.push(drawCard());
    }

    const dealerTotal = handValue(bj.dealerHand);
    const dealerBust = dealerTotal > 21;

    bj.players.forEach(player => {
        const total = handValue(player.hand);
        let result = "lose";
        let payout = 0;

        if (total > 21) {
            result = "bust";
            payout = 0;
        } else if (dealerBust || total > dealerTotal) {
            result = "win";
            payout = player.blackjack ? Math.floor(player.amount * 2.5) : player.amount * 2;
        } else if (total === dealerTotal) {
            result = "push";
            payout = player.amount;
        } else {
            result = "lose";
            payout = 0;
        }

        player.status = result;
        player.payout = payout;
        player.profit = payout - player.amount;
        if (payout > 0) {
    creditChips(
        player.playerId,
        payout,
        {
            playerName: player.playerName,
            type: "payout",
            gameType: "blackjack",
            note:
                result === "push"
                    ? "Blackjack bet returned"
                    : "Blackjack winnings"
        }
    );
}
    });

    bj.history.unshift({
        createdAt: Date.now(),
        dealerHand: bj.dealerHand,
        dealerTotal,
        results: bj.players.map(p => ({
            playerId: p.playerId,
            playerName: p.playerName,
            amount: p.amount,
            hand: p.hand,
            total: handValue(p.hand),
            result: p.status,
            payout: p.payout,
            profit: p.profit
        }))
    });
    bj.history = bj.history.slice(0, 20);
}

function publicBlackjackState() {
    const bj = state.blackjack;
    const active = activeBlackjackPlayer();

    return {
        bets: bj.bets,
        players: bj.players.map(p => ({
            playerId: p.playerId,
            playerName: p.playerName,
            amount: p.amount,
            hand: p.hand,
            total: handValue(p.hand),
            status: p.status,
            payout: p.payout || 0,
            profit: p.profit || 0,
            blackjack: !!p.blackjack
        })),
        dealerHand: bj.status === "playing" ? [bj.dealerHand[0], { rank: "?", suit: "" }] : bj.dealerHand,
        dealerTotal: bj.status === "playing" ? null : handValue(bj.dealerHand),
        status: bj.status,
        currentTurnId: active ? active.playerId : "",
        currentTurnName: active ? active.playerName : "",
        history: bj.history,
        autoStartAt: bj.autoStartAt
    };
}


function publicRacingState() {
    const race = state.racing;
    return {
        horses: race.horses,
        bets: race.bets,
        history: race.history,
        racing: race.racing,
        activeRace: race.activeRace,
        autoStartAt: race.autoStartAt
    };
}

function finishHorseRace(raceId) {
    const race = state.racing;
    const active = race.activeRace;
    if (!active || active.raceId !== raceId) return;
    for (const result of active.results || []) {
    if (result.payout > 0) {
        creditChips(
            result.playerId,
            result.payout,
            {
                playerName: result.playerName,
                type: "payout",
                gameType: "racing",
                note: `Horse racing winnings on ${result.horseName}`
            }
        );
    }
}

    race.history.unshift({
        raceId,
        winnerHorseId: active.winnerHorseId,
        winnerHorseName: active.winnerHorseName,
        results: active.results,
        placements: active.placements,
        createdAt: Date.now()
    });
    race.history = race.history.slice(0, 30);
    race.bets = [];
    race.racing = false;
    race.activeRace = null;
}

const ROULETTE_RED_NUMBERS = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18,
    19, 21, 23, 25, 27, 30, 32, 34, 36
]);

function getRouletteColor(number) {
    if (number === 0) return "green";
    return ROULETTE_RED_NUMBERS.has(number)
        ? "red"
        : "black";
}

function rouletteBetWins(bet, number) {
    const type = bet.betType;

    if (type === "straight") {
        return number === Number(bet.selection);
    }

    if (number === 0) {
        return false;
    }

    if (type === "red") {
        return getRouletteColor(number) === "red";
    }

    if (type === "black") {
        return getRouletteColor(number) === "black";
    }

    if (type === "odd") {
        return number % 2 === 1;
    }

    if (type === "even") {
        return number % 2 === 0;
    }

    if (type === "low") {
        return number >= 1 && number <= 18;
    }

    if (type === "high") {
        return number >= 19 && number <= 36;
    }

    if (type === "dozen1") {
        return number >= 1 && number <= 12;
    }

    if (type === "dozen2") {
        return number >= 13 && number <= 24;
    }

    if (type === "dozen3") {
        return number >= 25 && number <= 36;
    }

    if (type === "column1") {
        return number % 3 === 1;
    }

    if (type === "column2") {
        return number % 3 === 2;
    }

    if (type === "column3") {
        return number % 3 === 0;
    }

    return false;
}

function roulettePayoutMultiplier(type) {
    if (type === "straight") return 36;

    if (
        type === "dozen1" ||
        type === "dozen2" ||
        type === "dozen3" ||
        type === "column1" ||
        type === "column2" ||
        type === "column3"
    ) {
        return 3;
    }

    return 2;
}

function ensureRouletteState() {
    if (
        !state.roulette ||
        typeof state.roulette !== "object"
    ) {
        state.roulette = {
            bets: [],
            history: [],
            spinning: false,
            activeSpin: null,
            autoStartAt: null
        };
    }

    if (!Array.isArray(state.roulette.bets)) {
        state.roulette.bets = [];
    }

    if (!Array.isArray(state.roulette.history)) {
        state.roulette.history = [];
    }

    state.roulette.spinning =
        Boolean(state.roulette.spinning);

    return state.roulette;
}

function publicRouletteState() {
    const roulette = ensureRouletteState();

    return {
        bets: roulette.bets.map(
            bet => ({ ...bet })
        ),
        history: roulette.history
            .slice(0, 30)
            .map(entry => ({ ...entry })),
        spinning: roulette.spinning,
        activeSpin: roulette.activeSpin,
        autoStartAt: roulette.autoStartAt
    };
}

function finishRouletteSpin(spinId) {
    const roulette = ensureRouletteState();
    const active = roulette.activeSpin;

    if (
        !active ||
        active.spinId !== spinId
    ) {
        return;
    }

    for (const result of active.results) {
        if (result.payout > 0) {
            creditChips(
                result.playerId,
                result.payout,
                {
                    playerName:
                        result.playerName,
                    type: "payout",
                    gameType: "roulette",
                    note:
                        `Roulette ${result.betType} win on ${active.winningNumber}`
                }
            );
        }
    }

    roulette.history.unshift({
        spinId,
        winningNumber:
            active.winningNumber,
        winningColor:
            active.winningColor,
        results:
            active.results.map(
                result => ({ ...result })
            ),
        createdAt:
            Date.now()
    });

    roulette.history =
        roulette.history.slice(0, 30);

    roulette.bets = [];
    roulette.spinning = false;
    roulette.activeSpin = null;
    roulette.autoStartAt = null;
    queueChipSave();
}

function startRouletteSpin() {
    const roulette = ensureRouletteState();

    if (roulette.spinning) {
        return {
            ok: false,
            error: "Roulette is already spinning"
        };
    }

    if (!roulette.bets.length) {
        return {
            ok: false,
            error: "No roulette bets"
        };
    }

    const winningNumber =
        crypto.randomInt(0, 37);

    const winningColor =
        getRouletteColor(winningNumber);

    const results =
        roulette.bets.map(bet => {
            const won =
                rouletteBetWins(
                    bet,
                    winningNumber
                );

            const multiplier =
                roulettePayoutMultiplier(
                    bet.betType
                );

            const payout =
                won
                    ? bet.amount * multiplier
                    : 0;

            return {
                ...bet,
                won,
                multiplier,
                payout,
                profit:
                    payout - bet.amount
            };
        });

    const spinId =
        crypto.randomBytes(8).toString("hex");

    roulette.spinning = true;
    roulette.autoStartAt = null;
    roulette.activeSpin = {
        spinId,
        winningNumber,
        winningColor,
        startedAt: Date.now(),
        durationMs: SPIN_DURATION_MS,
        results
    };

    setTimeout(
        () => finishRouletteSpin(spinId),
        SPIN_DURATION_MS
    );

    return {
        ok: true,
        spin: roulette.activeSpin
    };
}

function scheduleRouletteAutoStart() {
    const roulette = ensureRouletteState();

    if (
        rouletteAutoTimer ||
        roulette.spinning ||
        !roulette.bets.length
    ) {
        return;
    }

    roulette.autoStartAt =
        Date.now() + AUTO_START_DELAY_MS;

    rouletteAutoTimer = setTimeout(() => {
        rouletteAutoTimer = null;
        roulette.autoStartAt = null;

        if (
            roulette.spinning ||
            !roulette.bets.length
        ) {
            return;
        }

        startRouletteSpin();
    }, AUTO_START_DELAY_MS);
}


// Slower curve so the multiplier visibly climbs and players
// have a real opportunity to cash out.
const CHICKEN_MAX_STEPS = 12;
const CHICKEN_HOUSE_FACTOR = 0.97;
const CHICKEN_MAX_HISTORY = 50;
const CHICKEN_RISKS = {
    easy: {
        label: "Easy",
        survivalChance: 0.88
    },
    medium: {
        label: "Medium",
        survivalChance: 0.78
    },
    hard: {
        label: "Hard",
        survivalChance: 0.68
    }
};

function ensureChickenState() {
    if (
        !state.chicken ||
        typeof state.chicken !== "object"
    ) {
        state.chicken = {
            games: {},
            history: []
        };
    }

    if (
        !state.chicken.games ||
        typeof state.chicken.games !== "object"
    ) {
        state.chicken.games = {};
    }

    if (!Array.isArray(state.chicken.history)) {
        state.chicken.history = [];
    }

    return state.chicken;
}

function chickenMultiplierForStep(
    step,
    riskKey
) {
    const risk =
        CHICKEN_RISKS[riskKey] ||
        CHICKEN_RISKS.medium;

    if (step <= 1) return 1;

    const riskySteps =
        step - 1;

    return Math.max(
        1,
        Math.floor(
            (
                CHICKEN_HOUSE_FACTOR /
                Math.pow(
                    risk.survivalChance,
                    riskySteps
                )
            ) * 100
        ) / 100
    );
}

function publicChickenGame(game) {
    if (!game) return null;

    return {
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        risk: game.risk,
        riskLabel:
            CHICKEN_RISKS[game.risk]?.label ||
            "Medium",
        currentStep: game.currentStep,
        multiplier:
            chickenMultiplierForStep(
                game.currentStep,
                game.risk
            ),
        maxSteps: CHICKEN_MAX_STEPS,
        status: game.status,
        startedAt: game.startedAt
    };
}

function publicChickenState() {
    const chicken = ensureChickenState();
    const games = {};

    for (const [playerId, game] of Object.entries(
        chicken.games
    )) {
        games[playerId] =
            publicChickenGame(game);
    }

    return {
        games,
        history: chicken.history
            .slice(0, 30)
            .map(entry => ({ ...entry })),
        maxSteps: CHICKEN_MAX_STEPS,
        risks: Object.fromEntries(
            Object.entries(CHICKEN_RISKS).map(
                ([key, risk]) => [
                    key,
                    {
                        label: risk.label,
                        survivalChance:
                            risk.survivalChance
                    }
                ]
            )
        )
    };
}

function finishChickenGame(
    game,
    result,
    payout,
    multiplier
) {
    const chicken = ensureChickenState();

    chicken.history.unshift({
        gameId: game.gameId,
        playerId: game.playerId,
        playerName: game.playerName,
        betAmount: game.betAmount,
        risk: game.risk,
        stepsCrossed: game.currentStep,
        result,
        multiplier,
        payout,
        profit: payout - game.betAmount,
        createdAt: Date.now()
    });

    chicken.history =
        chicken.history.slice(
            0,
            CHICKEN_MAX_HISTORY
        );

    delete chicken.games[game.playerId];
    queueChipSave();
}

function pickDailySpinPrize() {
    const totalWeight = DAILY_SPIN_PRIZES.reduce(
        (sum, prize) => sum + Math.max(0, Number(prize.weight || 0)),
        0
    );

    if (totalWeight <= 0) {
        throw new Error("Daily spin prize weights must total more than zero");
    }

    let roll = crypto.randomInt(1, totalWeight + 1);

    for (const prize of DAILY_SPIN_PRIZES) {
        roll -= Math.max(0, Number(prize.weight || 0));
        if (roll <= 0) return prize;
    }

    return DAILY_SPIN_PRIZES[DAILY_SPIN_PRIZES.length - 1];
}

function publicDailySpinPrizes() {
    return DAILY_SPIN_PRIZES.map(prize => ({
        id: prize.id,
        type: prize.type,
        label: prize.label,
        amount: prize.type === "chips" ? Number(prize.amount || 0) : undefined,
        quantity: prize.type === "item" ? Number(prize.quantity || 1) : undefined
    }));
}

function getDailySpinStatus(playerId) {
    const id = cleanPlayerId(playerId);
    const today = getUtcDateKey();
    const claim = id ? state.dailySpin.claims[id] : null;
    const claimedToday = Boolean(claim && claim.dateKey === today);

    return {
        dateKey: today,
        claimedToday,
        nextSpinAt: Date.parse(`${today}T00:00:00.000Z`) + 86_400_000,
        lastResult: claim || null,
        prizes: publicDailySpinPrizes()
    };
}

function publicDailySpinState() {
    return {
        prizes: publicDailySpinPrizes(),
        recentHistory: state.dailySpin.history.slice(0, 25).map(entry => ({
            spinId: entry.spinId,
            playerId: entry.playerId,
            playerName: entry.playerName,
            prizeType: entry.prizeType,
            prizeLabel: entry.prizeLabel,
            amount: entry.amount || 0,
            quantity: entry.quantity || 0,
            createdAt: entry.createdAt
        }))
    };
}

function publicState() {
    return {
        chips: publicChipState(),
        slots: publicSlotsState(),
        mines: publicMinesState(),
        deal: publicDealState(),
        roulette: publicRouletteState(),
        chicken: publicChickenState(),
        dailySpin: publicDailySpinState(),
        wheel: publicWheelState(),
        blackjack: publicBlackjackState(),
        racing: publicRacingState()
    };
}

function finishWheelSpin(spinId) {
    const active = state.wheel.activeSpin;

    if (!active || active.spinId !== spinId) {
        return;
    }

    const results = active.results.map(
        result => ({ ...result })
    );

    for (const result of results) {
        if (result.payout > 0) {
            creditChips(
                result.playerId,
                result.payout,
                {
                    playerName: result.playerName,
                    type: "payout",
                    gameType: "wheel",
                    note: `Wheel result x${result.multiplier}`
                }
            );
        }
    }

    state.wheel.history.unshift({
        spinId,
        results,
        createdAt: Date.now()
    });

    state.wheel.history =
        state.wheel.history.slice(0, 50);

    state.wheel.bets = [];
    state.wheel.spinning = false;
    state.wheel.activeSpin = null;
}


function startWheelSpin() {
    if (state.wheel.spinning) {
        return { ok: false, error: "Already spinning" };
    }

    if (!state.wheel.bets.length) {
        return { ok: false, error: "No bets" };
    }

    state.wheel.bets.forEach(bet => {
        bet.confirmed = true;
    });

    const spinId = crypto.randomBytes(8).toString("hex");
    const startedAt = Date.now();

    const results = state.wheel.bets.map(bet => {
        const multiplier = pickMultiplier();
        const payout = Math.floor(Number(bet.amount) * multiplier);

        return {
            playerId: bet.playerId,
            playerName: bet.playerName,
            amount: bet.amount,
            multiplier,
            payout,
            profit: payout - bet.amount
        };
    });

    state.wheel.autoStartAt = null;
    state.wheel.spinning = true;
    state.wheel.activeSpin = {
        spinId,
        startedAt,
        durationMs: SPIN_DURATION_MS,
        results
    };

    setTimeout(() => finishWheelSpin(spinId), SPIN_DURATION_MS);

    return {
        ok: true,
        spin: state.wheel.activeSpin
    };
}

function startBlackjackRound() {
    const bj = state.blackjack;

    if (bj.status === "playing") {
        return { ok: false, error: "Round already running" };
    }

    if (!bj.bets.length) {
        return { ok: false, error: "No blackjack bets" };
    }

    bj.bets.forEach(bet => {
        bet.confirmed = true;
    });

    bj.autoStartAt = null;
    bj.deck = makeDeck();
    bj.dealerHand = [drawCard(), drawCard()];

    bj.players = bj.bets.map(bet => {
        const hand = [drawCard(), drawCard()];
        const total = handValue(hand);

        return {
            playerId: bet.playerId,
            playerName: bet.playerName,
            amount: bet.amount,
            hand,
            status: total === 21 ? "stand" : "playing",
            blackjack: total === 21
        };
    });

    bj.bets = [];
    bj.status = "playing";
    bj.currentTurnIndex = 0;

    while (
        bj.players[bj.currentTurnIndex] &&
        bj.players[bj.currentTurnIndex].status !== "playing"
    ) {
        bj.currentTurnIndex += 1;
    }

    if (bj.currentTurnIndex >= bj.players.length) {
        finishBlackjackRound();
    }

    return { ok: true };
}

function startHorseRace() {
    const race = state.racing;

    if (race.racing) {
        return { ok: false, error: "Race already running" };
    }

    if (!race.bets.length) {
        return { ok: false, error: "No racing bets" };
    }

    race.bets.forEach(bet => {
        bet.confirmed = true;
    });

    const raceId = crypto.randomBytes(8).toString("hex");

    const shuffled = race.horses
        .map(horse => ({
            ...horse,
            speed: crypto.randomInt(70, 101),
            burst: crypto.randomInt(0, 31)
        }))
        .sort(
            (a, b) =>
                (b.speed + b.burst) -
                (a.speed + a.burst)
        );

    const winner = shuffled[0];
    const odds = Math.max(
        2,
        Math.floor((race.horses.length - 1) * 1.25)
    );

    const results = race.bets.map(bet => {
        const won = bet.horseId === winner.id;
        const payout = won ? bet.amount * odds : 0;

        return {
            playerId: bet.playerId,
            playerName: bet.playerName,
            amount: bet.amount,
            horseId: bet.horseId,
            horseName: bet.horseName,
            won,
            payout,
            profit: payout - bet.amount
        };
    });

    race.autoStartAt = null;
    race.racing = true;
    race.activeRace = {
        raceId,
        startedAt: Date.now(),
        durationMs: RACE_DURATION_MS,
        winnerHorseId: winner.id,
        winnerHorseName: winner.name,
        placements: shuffled.map((horse, index) => ({
            place: index + 1,
            id: horse.id,
            name: horse.name
        })),
        results
    };

    setTimeout(
        () => finishHorseRace(raceId),
        RACE_DURATION_MS
    );

    return {
        ok: true,
        race: race.activeRace
    };
}

function scheduleWheelAutoStart() {
    if (
        wheelAutoTimer ||
        state.wheel.spinning ||
        !state.wheel.bets.length
    ) {
        return;
    }

    state.wheel.autoStartAt = Date.now() + AUTO_START_DELAY_MS;

    wheelAutoTimer = setTimeout(() => {
        wheelAutoTimer = null;
        state.wheel.autoStartAt = null;

        if (
            state.wheel.spinning ||
            !state.wheel.bets.length
        ) {
            return;
        }

        startWheelSpin();
    }, AUTO_START_DELAY_MS);
}

function scheduleBlackjackAutoStart() {
    const bj = state.blackjack;

    if (
        blackjackAutoTimer ||
        bj.status === "playing" ||
        !bj.bets.length
    ) {
        return;
    }

    bj.autoStartAt = Date.now() + AUTO_START_DELAY_MS;

    blackjackAutoTimer = setTimeout(() => {
        blackjackAutoTimer = null;
        bj.autoStartAt = null;

        if (
            bj.status === "playing" ||
            !bj.bets.length
        ) {
            return;
        }

        startBlackjackRound();
    }, AUTO_START_DELAY_MS);
}

function scheduleRacingAutoStart() {
    const race = state.racing;

    if (
        racingAutoTimer ||
        race.racing ||
        !race.bets.length
    ) {
        return;
    }

    race.autoStartAt = Date.now() + AUTO_START_DELAY_MS;

    racingAutoTimer = setTimeout(() => {
        racingAutoTimer = null;
        race.autoStartAt = null;

        if (
            race.racing ||
            !race.bets.length
        ) {
            return;
        }

        startHorseRace();
    }, AUTO_START_DELAY_MS);
}

app.get("/", (req, res) => {
    res.json({ ok: true, app: "TT Shared Casino", wheelBets: state.wheel.bets.length, blackjackStatus: state.blackjack.status, racingBets: state.racing.bets.length, racing: state.racing.racing });
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/state", (req, res) => {
    res.json({
        ok: true,
        serverTime: Date.now(),
        state: publicState()
    });
});

app.post("/admin-login", (req, res) => {
    if (String(req.body?.pin || "") !== ADMIN_PIN) {
        return res.status(403).json({ ok: false, error: "Bad PIN" });
    }

    const token = crypto.randomBytes(24).toString("hex");
    adminTokens.add(token);
    res.json({ ok: true, token });
});

// Chip routes

app.post("/chips/register-player", (req, res) => {
    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    if (!playerId || !playerName) {
        return res.status(400).json({
            ok: false,
            error: "Invalid player"
        });
    }

    const existedBefore =
        Object.prototype.hasOwnProperty.call(
            state.chips.balances,
            playerId
        );

    rememberPlayer(
        playerId,
        playerName
    );

    res.json({
        ok: true,
        playerId,
        playerName,
        newPlayer: !existedBefore,
        startingBonusGranted:
            !existedBefore
                ? NEW_PLAYER_STARTING_CHIPS
                : 0,
        balance:
            getChipBalance(playerId),
        state:
            publicState()
    });
});

app.get("/chips/daily-profit", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const requestedDate = String(
        req.query?.date || getUtcDateKey()
    ).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return res.status(400).json({
            ok: false,
            error: "Date must use YYYY-MM-DD"
        });
    }

    const stats =
        state.chips.dailyHouseStats[requestedDate] || {
            date: requestedDate,
            bets: 0,
            payouts: 0,
            refunds: 0,
            profit: 0,
            games: {}
        };

    res.json({
        ok: true,
        timezone: "UTC",
        stats
    });
});

app.post("/chips/reset-all", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const requesterId = cleanPlayerId(req.body?.requesterId);
    const confirmation = String(req.body?.confirmation || "").trim();

    if (requesterId !== CHIP_RESET_OWNER_ID) {
        return res.status(403).json({
            ok: false,
            error: "Only user ID 229051 can reset all chips"
        });
    }

    if (confirmation !== "RESET ALL CHIPS") {
        return res.status(400).json({
            ok: false,
            error: 'Type "RESET ALL CHIPS" to confirm'
        });
    }

    const previousPlayerCount = Object.keys(
        state.chips.balances
    ).length;

    const previousTotalChips = Object.values(
        state.chips.balances
    ).reduce(
        (sum, value) =>
            sum + Math.max(
                0,
                Math.floor(Number(value || 0))
            ),
        0
    );

    state.chips.balances = {};
    state.chips.requests = [];
    state.chips.withdrawalRequests = [];
    state.chips.discordEvents = [];
    state.chips.transactions = [];
    state.chips.dailyHouseStats = {};
    state.chips.leaderboardStats = {};

    state.slots.freeSpins = {};
    state.slots.lastPaidBet = {};
    state.slots.history = [];

    state.mines.games = {};
    state.mines.history = [];

    state.deal.games = {};
    state.deal.history = [];

    state.roulette.bets = [];
    state.roulette.history = [];
    state.roulette.spinning = false;
    state.roulette.activeSpin = null;
    state.roulette.autoStartAt = null;

    state.chicken.games = {};
    state.chicken.history = [];

    state.dailySpin.claims = {};
    state.dailySpin.history = [];
    state.dailySpin.deliveries = {};

    state.wheel.bets = [];
    state.wheel.history = [];
    state.wheel.spinning = false;
    state.wheel.activeSpin = null;
    state.wheel.autoStartAt = null;

    state.blackjack.bets = [];
    state.blackjack.players = [];
    state.blackjack.dealerHand = [];
    state.blackjack.deck = [];
    state.blackjack.status = "waiting";
    state.blackjack.currentTurnIndex = 0;
    state.blackjack.history = [];
    state.blackjack.autoStartAt = null;

    state.racing.bets = [];
    state.racing.history = [];
    state.racing.racing = false;
    state.racing.activeRace = null;
    state.racing.autoStartAt = null;

    const resetAt = Date.now();

    saveChipDataImmediately();

    console.warn(
        `Casino reset completed by ${requesterId}: ` +
        `${previousPlayerCount} players and ` +
        `${previousTotalChips} chips cleared`
    );

    res.json({
        ok: true,
        resetBy: requesterId,
        resetAt,
        previousPlayerCount,
        previousTotalChips,
        state: publicState()
    });
});

app.get("/chips/leaderboard", (req, res) => {
    const playerId =
        cleanPlayerId(req.query?.playerId);

    res.json({
        ok: true,
        leaderboard:
            getLeaderboardForPlayer(playerId)
    });
});

app.post("/chips/request", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(
        req.body?.playerName
    );
    const amount = cleanAmount(req.body?.amount);

    if (!playerId || !playerName || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid chip request"
        });
    }

    rememberPlayer(playerId, playerName);

    const existing = state.chips.requests.find(
        request =>
            request.playerId === playerId &&
            request.status === "pending"
    );

    if (existing) {
        existing.playerName = playerName;
        existing.amount = amount;
        existing.updatedAt = Date.now();
        queueChipSave();

        return res.json({
            ok: true,
            request: existing,
            state: publicState()
        });
    }

    const request = {
        requestId: crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        amount,
        status: "pending",
        createdAt: Date.now()
    };

    state.chips.requests.push(request);
    queueChipSave();

    res.json({
        ok: true,
        request,
        state: publicState()
    });
});

app.post("/chips/grant", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const requestId = String(
        req.body?.requestId || ""
    ).trim();

    let playerId = cleanPlayerId(req.body?.playerId);
    let playerName = cleanPlayerName(
        req.body?.playerName
    );
    let amount = cleanAmount(req.body?.amount);

    let request = null;

    if (requestId) {
        request = state.chips.requests.find(
            item =>
                item.requestId === requestId &&
                item.status === "pending"
        );

        if (!request) {
            return res.status(404).json({
                ok: false,
                error: "Chip request not found"
            });
        }

        playerId = request.playerId;
        playerName = request.playerName;
        amount = request.amount;
    }

    if (!playerId || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid player or chip amount"
        });
    }

    const granted = creditChips(
        playerId,
        amount,
        {
            playerName,
            type: "banker-grant",
            note: request
                ? "Chip purchase request approved"
                : "Chips manually granted by banker"
        }
    );

    if (!granted) {
        return res.status(400).json({
            ok: false,
            error: "Could not grant chips"
        });
    }

    if (request) {
        state.chips.requests =
            state.chips.requests.filter(
                item => item.requestId !== request.requestId
            );

        queueChipSave();
    }

    addDiscordEvent("banker-grant", {
        playerId,
        playerName,
        amount,
        newBalance: getChipBalance(playerId),
        source:
            request
                ? "approved-request"
                : "manual-grant",
        requestId:
            request?.requestId || null
    });

    res.json({
        ok: true,
        playerId,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});
app.post("/chips/withdraw-request", (req, res) => {
    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName ||
        state.chips.playerNames[playerId] ||
        "Player"
    );

    const amount = cleanAmount(
        req.body?.amount
    );

    if (!playerId || !playerName || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid withdrawal request"
        });
    }

    rememberPlayer(playerId, playerName);

    const currentBalance =
        getChipBalance(playerId);

    if (currentBalance < amount) {
        return res.status(400).json({
            ok: false,
            error:
                `You only have ${currentBalance} chips`
        });
    }

    const existing =
        state.chips.withdrawalRequests.find(
            request =>
                request.playerId === playerId &&
                request.status === "pending"
        );

    if (existing) {
        existing.amount = amount;
        existing.playerName = playerName;
        existing.currentBalance =
            currentBalance;
        existing.updatedAt = Date.now();

        addDiscordEvent("withdrawal-request", {
            withdrawalRequestId:
                existing.withdrawalRequestId,
            playerId,
            playerName,
            amount,
            currentBalance,
            updated: true
        });

        queueChipSave();

        return res.json({
            ok: true,
            request: existing,
            state: publicState()
        });
    }

    const request = {
        withdrawalRequestId:
            crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        amount,
        currentBalance,
        status: "pending",
        createdAt: Date.now()
    };

    state.chips.withdrawalRequests.push(
        request
    );

    addDiscordEvent("withdrawal-request", {
        withdrawalRequestId:
            request.withdrawalRequestId,
        playerId,
        playerName,
        amount,
        currentBalance,
        updated: false
    });

    queueChipSave();

    res.json({
        ok: true,
        request,
        state: publicState()
    });
});

app.post("/chips/cashout", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(
        req.body?.playerName ||
        state.chips.playerNames[playerId] ||
        "Player"
    );
    const amount = cleanAmount(req.body?.amount);

    if (!playerId || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid player ID or cash-out amount"
        });
    }

    rememberPlayer(playerId, playerName);

    const currentBalance = getChipBalance(playerId);

    if (currentBalance < amount) {
        return res.status(400).json({
            ok: false,
            error: `Player only has ${currentBalance} chips`
        });
    }

    const removed = debitChips(
        playerId,
        amount,
        {
            playerName,
            type: "cashout",
            gameType: "",
            note: "Chips removed after cash out"
        }
    );

    if (!removed.ok) {
        return res.status(400).json({
            ok: false,
            error: removed.error
        });
    }

    const matchingWithdrawal =
        state.chips.withdrawalRequests.find(
            request =>
                request.playerId === playerId &&
                request.status === "pending"
        );

    if (matchingWithdrawal) {
        matchingWithdrawal.status = "completed";
        matchingWithdrawal.completedAt = Date.now();
        matchingWithdrawal.amountCompleted = amount;
    }

    addDiscordEvent("withdrawal-completed", {
        withdrawalRequestId:
            matchingWithdrawal?.withdrawalRequestId ||
            null,
        playerId,
        playerName,
        amount,
        previousBalance: currentBalance,
        newBalance: getChipBalance(playerId)
    });

    res.json({
        ok: true,
        playerId,
        playerName,
        amountRemoved: amount,
        previousBalance: currentBalance,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/chips/reject", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const requestId = String(
        req.body?.requestId || ""
    ).trim();

    const request = state.chips.requests.find(
        item =>
            item.requestId === requestId &&
            item.status === "pending"
    );

    if (!request) {
        return res.status(404).json({
            ok: false,
            error: "Chip request not found"
        });
    }

    state.chips.requests =
        state.chips.requests.filter(
            item => item.requestId !== requestId
        );

    queueChipSave();

    res.json({
        ok: true,
        state: publicState()
    });
});

app.post("/chips/set-balance", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    const balance = Math.floor(
        Number(req.body?.balance)
    );

    if (
        !playerId ||
        !Number.isSafeInteger(balance) ||
        balance < 0 ||
        balance > MAX_CHIP_AMOUNT
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid balance"
        });
    }

    rememberPlayer(playerId, playerName);

    const previousBalance = getChipBalance(playerId);
    state.chips.balances[playerId] = balance;

    addChipTransaction({
        playerId,
        playerName,
        amount: balance - previousBalance,
        type: "balance-set",
        note: "Balance manually set by banker"
    });

    queueChipSave();

    res.json({
        ok: true,
        playerId,
        balance,
        state: publicState()
    });
});

// Daily spin routes

app.get("/daily-spin/status", (req, res) => {
    const playerId = cleanPlayerId(req.query?.playerId);

    if (!playerId) {
        return res.status(400).json({ ok: false, error: "Invalid player ID" });
    }

    rememberPlayer(playerId);

    res.json({
        ok: true,
        status: getDailySpinStatus(playerId),
        balance: getChipBalance(playerId)
    });
});

app.post("/daily-spin/spin", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(req.body?.playerName);

    if (!playerId || !playerName) {
        return res.status(400).json({ ok: false, error: "Invalid player" });
    }

    rememberPlayer(playerId, playerName);

    const today = getUtcDateKey();
    const existing = state.dailySpin.claims[playerId];

    if (existing && existing.dateKey === today) {
        return res.status(409).json({
            ok: false,
            error: "You have already used today's daily spin",
            status: getDailySpinStatus(playerId)
        });
    }

    const prize = pickDailySpinPrize();
    const spinId = crypto.randomBytes(8).toString("hex");
    const createdAt = Date.now();
    let deliveryId = null;

    if (prize.type === "chips") {
        const amount = cleanAmount(prize.amount);
        if (!amount || !creditChips(playerId, amount, {
            playerName,
            type: "daily-spin-prize",
            gameType: "daily-spin",
            note: `Daily spin prize: ${prize.label}`
        })) {
            return res.status(500).json({ ok: false, error: "Could not credit daily-spin chips" });
        }
    } else if (prize.type === "item") {
        deliveryId = crypto.randomBytes(8).toString("hex");

        state.dailySpin.deliveries[deliveryId] = {
            deliveryId,
            spinId,
            playerId,
            playerName,
            itemName: String(prize.itemName || prize.label),
            prizeLabel: prize.label,
            quantity: Math.max(1, Math.floor(Number(prize.quantity || 1))),
            status: "pending",
            createdAt,
            deliveredAt: null,
            deliveredBy: null
        };

        addDiscordEvent("daily-spin-item", {
            deliveryId,
            spinId,
            playerId,
            playerName,
            itemName: String(prize.itemName || prize.label),
            prizeLabel: prize.label,
            quantity: Math.max(1, Math.floor(Number(prize.quantity || 1)))
        });
    }

    const result = {
        spinId,
        dateKey: today,
        playerId,
        playerName,
        prizeId: prize.id,
        prizeType: prize.type,
        prizeLabel: prize.label,
        amount: prize.type === "chips" ? Number(prize.amount || 0) : 0,
        itemName: prize.type === "item" ? String(prize.itemName || prize.label) : null,
        quantity: prize.type === "item" ? Math.max(1, Math.floor(Number(prize.quantity || 1))) : 0,
        deliveryId,
        deliveryStatus: deliveryId ? "pending" : null,
        createdAt
    };

    state.dailySpin.claims[playerId] = result;
    state.dailySpin.history.unshift(result);
    state.dailySpin.history = state.dailySpin.history.slice(0, DAILY_SPIN_MAX_HISTORY);
    queueChipSave();

    res.json({
        ok: true,
        result,
        status: getDailySpinStatus(playerId),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/discord/daily-spin/delivered", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    const deliveryId = String(req.body?.deliveryId || "").trim();
    const delivery = state.dailySpin.deliveries[deliveryId];

    if (!delivery) {
        return res.status(404).json({ ok: false, error: "Daily-spin delivery not found" });
    }

    if (delivery.status === "delivered") {
        return res.json({ ok: true, delivery: { ...delivery }, alreadyDelivered: true });
    }

    delivery.status = "delivered";
    delivery.deliveredAt = Date.now();
    delivery.deliveredBy = {
        discordUserId: String(req.body?.discordUserId || ""),
        discordDisplayName: String(req.body?.discordDisplayName || "")
    };

    const claim = state.dailySpin.claims[delivery.playerId];
    if (claim && claim.spinId === delivery.spinId) {
        claim.deliveryStatus = "delivered";
        claim.deliveredAt = delivery.deliveredAt;
    }

    const historyEntry = state.dailySpin.history.find(entry => entry.spinId === delivery.spinId);
    if (historyEntry) {
        historyEntry.deliveryStatus = "delivered";
        historyEntry.deliveredAt = delivery.deliveredAt;
    }

    queueChipSave();

    res.json({ ok: true, delivery: { ...delivery } });
});

// Discord bot chip-request routes

app.get("/discord/chips/events", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    res.json({
        ok: true,
        events: state.chips.discordEvents
            .filter(event => !event.postedAt)
            .slice()
            .reverse()
            .slice(0, 100)
            .map(event => ({ ...event }))
    });
});

app.post("/discord/chips/event-ack", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    const eventId = String(
        req.body?.eventId || ""
    ).trim();

    const event =
        state.chips.discordEvents.find(
            item => item.eventId === eventId
        );

    if (!event) {
        return res.status(404).json({
            ok: false,
            error: "Discord event not found"
        });
    }

    event.postedAt = Date.now();
    event.discordMessageId = String(
        req.body?.discordMessageId || ""
    ).trim() || null;

    queueChipSave();

    res.json({
        ok: true,
        eventId,
        postedAt: event.postedAt
    });
});

app.get("/discord/chips/requests", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    res.json({
        ok: true,
        requests: state.chips.requests
            .filter(request => request.status === "pending")
            .map(request => ({
                ...request,
                currentBalance:
                    getChipBalance(request.playerId)
            }))
    });
});

app.post("/discord/chips/approve", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    const requestId = String(
        req.body?.requestId || ""
    ).trim();

    const discordUserId = String(
        req.body?.discordUserId || ""
    ).trim();

    const discordDisplayName = String(
        req.body?.discordDisplayName ||
        "Discord approver"
    ).trim().slice(0, 80);

    const request = state.chips.requests.find(
        item =>
            item.requestId === requestId &&
            item.status === "pending"
    );

    if (!request) {
        return res.status(404).json({
            ok: false,
            error: "Chip request not found or already handled"
        });
    }

    const granted = creditChips(
        request.playerId,
        request.amount,
        {
            playerName: request.playerName,
            type: "banker-grant",
            note:
                `Discord approval by ${discordDisplayName} ` +
                `(${discordUserId || "unknown"})`
        }
    );

    if (!granted) {
        return res.status(400).json({
            ok: false,
            error: "Could not grant requested chips"
        });
    }

    state.chips.requests =
        state.chips.requests.filter(
            item =>
                item.requestId !== requestId
        );

    addDiscordEvent("banker-grant", {
        playerId: request.playerId,
        playerName: request.playerName,
        amount: request.amount,
        newBalance:
            getChipBalance(request.playerId),
        source: "discord-approved-request",
        requestId,
        handledBy: discordDisplayName,
        handledByDiscordId:
            discordUserId || null
    });

    queueChipSave();

    res.json({
        ok: true,
        action: "approved",
        requestId,
        playerId: request.playerId,
        playerName: request.playerName,
        amount: request.amount,
        newBalance:
            getChipBalance(request.playerId)
    });
});

app.post("/discord/chips/deny", (req, res) => {
    if (!requireDiscordBot(req, res)) return;

    const requestId = String(
        req.body?.requestId || ""
    ).trim();

    const request = state.chips.requests.find(
        item =>
            item.requestId === requestId &&
            item.status === "pending"
    );

    if (!request) {
        return res.status(404).json({
            ok: false,
            error: "Chip request not found or already handled"
        });
    }

    state.chips.requests =
        state.chips.requests.filter(
            item =>
                item.requestId !== requestId
        );

    queueChipSave();

    res.json({
        ok: true,
        action: "denied",
        requestId,
        playerId: request.playerId,
        playerName: request.playerName,
        amount: request.amount
    });
});

app.post(
    "/discord/chips/withdrawal-complete",
    (req, res) => {
        if (!requireDiscordBot(req, res)) return;

        const withdrawalRequestId = String(
            req.body?.withdrawalRequestId || ""
        ).trim();

        const discordUserId = String(
            req.body?.discordUserId || ""
        ).trim();

        const discordDisplayName = String(
            req.body?.discordDisplayName ||
            "Discord banker"
        ).trim().slice(0, 80);

        const request =
            state.chips.withdrawalRequests.find(
                item =>
                    item.withdrawalRequestId ===
                        withdrawalRequestId &&
                    item.status === "pending"
            );

        if (!request) {
            return res.status(404).json({
                ok: false,
                error:
                    "Withdrawal request not found or already handled"
            });
        }

        const currentBalance =
            getChipBalance(request.playerId);

        if (currentBalance < request.amount) {
            return res.status(400).json({
                ok: false,
                error:
                    `Player only has ${currentBalance} chips`
            });
        }

        const removed = debitChips(
            request.playerId,
            request.amount,
            {
                playerName: request.playerName,
                type: "cashout",
                gameType: "",
                note:
                    `Discord withdrawal completed by ` +
                    `${discordDisplayName} ` +
                    `(${discordUserId || "unknown"})`
            }
        );

        if (!removed.ok) {
            return res.status(400).json({
                ok: false,
                error: removed.error
            });
        }

        request.status = "completed";
        request.completedAt = Date.now();
        request.amountCompleted =
            request.amount;
        request.handledBy =
            discordDisplayName;
        request.handledByDiscordId =
            discordUserId || null;

        queueChipSave();

        res.json({
            ok: true,
            action: "completed",
            withdrawalRequestId,
            playerId: request.playerId,
            playerName: request.playerName,
            amountRemoved: request.amount,
            previousBalance:
                currentBalance,
            newBalance:
                getChipBalance(request.playerId)
        });
    }
);

app.post(
    "/discord/chips/withdrawal-deny",
    (req, res) => {
        if (!requireDiscordBot(req, res)) return;

        const withdrawalRequestId = String(
            req.body?.withdrawalRequestId || ""
        ).trim();

        const discordUserId = String(
            req.body?.discordUserId || ""
        ).trim();

        const discordDisplayName = String(
            req.body?.discordDisplayName ||
            "Discord banker"
        ).trim().slice(0, 80);

        const request =
            state.chips.withdrawalRequests.find(
                item =>
                    item.withdrawalRequestId ===
                        withdrawalRequestId &&
                    item.status === "pending"
            );

        if (!request) {
            return res.status(404).json({
                ok: false,
                error:
                    "Withdrawal request not found or already handled"
            });
        }

        request.status = "denied";
        request.deniedAt = Date.now();
        request.handledBy =
            discordDisplayName;
        request.handledByDiscordId =
            discordUserId || null;

        queueChipSave();

        res.json({
            ok: true,
            action: "denied",
            withdrawalRequestId,
            playerId: request.playerId,
            playerName: request.playerName,
            amount: request.amount,
            currentBalance:
                getChipBalance(request.playerId)
        });
    }
);

// Slot routes
app.post("/slots/spin", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(req.body?.playerName);
    const requestedAmount = cleanAmount(req.body?.amount);

    if (!playerId || !playerName) {
        return res.status(400).json({ ok: false, error: "Invalid player" });
    }

    rememberPlayer(playerId, playerName);

    const availableFreeSpins = Math.max(0, Math.floor(Number(state.slots.freeSpins[playerId] || 0)));
    const isFreeSpin = availableFreeSpins > 0;
    let betAmount = requestedAmount;

    if (isFreeSpin) {
        betAmount = Math.floor(Number(state.slots.lastPaidBet[playerId] || requestedAmount || 0));
        if (!betAmount) {
            return res.status(400).json({ ok: false, error: "Place one paid spin before using free spins" });
        }
        state.slots.freeSpins[playerId] = availableFreeSpins - 1;
    } else {
        if (!betAmount) {
            return res.status(400).json({ ok: false, error: "Invalid slot bet" });
        }
        const debited = debitChips(playerId, betAmount, {
            playerName,
            type: "bet",
            gameType: "slots",
            note: "Slot spin"
        });
        if (!debited.ok) return res.status(400).json(debited);
        state.slots.lastPaidBet[playerId] = betAmount;
    }

    const initialGrid = createSlotGrid();
    const nudgeFeature = runScatterNudgeFeature(initialGrid);
    const grid = nudgeFeature.finalGrid;
    const evaluation = evaluateSlotGrid(
        grid,
        betAmount
    );

    if (evaluation.freeSpinsAwarded > 0) {
        state.slots.freeSpins[playerId] =
            Math.max(0, Number(state.slots.freeSpins[playerId] || 0)) + evaluation.freeSpinsAwarded;
    }

    // Free spins are not charged, but they gamble the triggering paid-spin
    // stake and receive the exact same gross payout as a paid spin.
    const creditedPayout =
        evaluation.payout > 0
            ? evaluation.payout + betAmount
            : 0;

    if (creditedPayout > 0) {
        creditChips(playerId, creditedPayout, {
            playerName,
            type: "payout",
            gameType: "slots",
            note: isFreeSpin
                ? "Slot free-spin winnings plus original bet value returned"
                : "Slot winnings plus original bet returned"
        });
    }

    const result = {
        spinId: crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        initialGrid,
        grid,
        scatterNudgeTriggered: nudgeFeature.triggered,
        scatterNudgeSteps: nudgeFeature.steps,
        scatterNudgeAttempts: nudgeFeature.steps.length,
        betAmount,
        payout: creditedPayout,
        winAmount: evaluation.payout,
        stakeReturned:
            evaluation.payout > 0
                ? betAmount
                : 0,
        profit:
            creditedPayout -
            (isFreeSpin ? 0 : betAmount),
        freeSpin: isFreeSpin,
        freeSpinsAwarded: evaluation.freeSpinsAwarded,
        freeSpinsRemaining: state.slots.freeSpins[playerId] || 0,
        bonusMultiplier: evaluation.bonusMultiplier,
        minimumWinApplied: evaluation.minimumWinApplied,
        scatterCount: evaluation.scatterCount,
        lineWins: evaluation.lineWins,
        winningCells: evaluation.winningCells,
        message: evaluation.freeSpinsAwarded > 0
            ? nudgeFeature.triggered
                ? `Scatter nudge found the third scatter and awarded ${evaluation.freeSpinsAwarded} free spins!`
                : `${evaluation.scatterCount} scatters awarded ${evaluation.freeSpinsAwarded} free spins!`
            : nudgeFeature.triggered
                ? `Scatter nudge used ${nudgeFeature.steps.length} free respin${nudgeFeature.steps.length === 1 ? "" : "s"}, but no third scatter landed`
                : evaluation.lineWins.length
                    ? `${evaluation.lineWins.length} winning payline${evaluation.lineWins.length === 1 ? "" : "s"}`
                    : "No winning combination",
        createdAt: Date.now()
    };

    state.slots.history.unshift(result);
    state.slots.history = state.slots.history.slice(0, SLOT_MAX_HISTORY);
    queueChipSave();

    res.json({
        ok: true,
        result,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});


// Roulette routes

app.post("/roulette/place-bet", (req, res) => {
    const roulette = ensureRouletteState();

    if (roulette.spinning) {
        return res.status(409).json({
            ok: false,
            error: "Roulette spin already running"
        });
    }

    const playerId =
        cleanPlayerId(req.body?.playerId);

    const playerName =
        cleanPlayerName(req.body?.playerName);

    const amount =
        cleanAmount(req.body?.amount);

    const betType =
        String(req.body?.betType || "").trim();

    const selection =
        req.body?.selection;

    const validTypes = new Set([
        "straight",
        "red",
        "black",
        "odd",
        "even",
        "low",
        "high",
        "dozen1",
        "dozen2",
        "dozen3",
        "column1",
        "column2",
        "column3"
    ]);

    if (
        !playerId ||
        !playerName ||
        !amount ||
        !validTypes.has(betType)
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid roulette bet"
        });
    }

    if (
        betType === "straight" &&
        (
            !Number.isInteger(Number(selection)) ||
            Number(selection) < 0 ||
            Number(selection) > 36
        )
    ) {
        return res.status(400).json({
            ok: false,
            error: "Choose a number from 0 to 36"
        });
    }

    const debit = debitChips(
        playerId,
        amount,
        {
            playerName,
            type: "bet",
            gameType: "roulette",
            note:
                betType === "straight"
                    ? `Roulette number ${selection}`
                    : `Roulette ${betType}`
        }
    );

    if (!debit.ok) {
        return res.status(400).json(debit);
    }

    roulette.bets.push({
        betId:
            crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        amount,
        betType,
        selection:
            betType === "straight"
                ? Number(selection)
                : String(selection || betType),
        createdAt:
            Date.now()
    });

    scheduleRouletteAutoStart();
    queueChipSave();

    res.json({
        ok: true,
        balance:
            getChipBalance(playerId),
        state:
            publicState()
    });
});

app.post("/roulette/clear-my-bets", (req, res) => {
    const roulette = ensureRouletteState();
    const playerId =
        cleanPlayerId(req.body?.playerId);

    if (roulette.spinning) {
        return res.status(409).json({
            ok: false,
            error: "Cannot clear bets during a spin"
        });
    }

    const mine = roulette.bets.filter(
        bet => bet.playerId === playerId
    );

    if (!mine.length) {
        return res.status(404).json({
            ok: false,
            error: "No roulette bets to clear"
        });
    }

    refundBets(
        mine,
        "roulette",
        "Roulette bets cleared"
    );

    roulette.bets =
        roulette.bets.filter(
            bet => bet.playerId !== playerId
        );

    if (!roulette.bets.length) {
        roulette.autoStartAt = null;

        if (rouletteAutoTimer) {
            clearTimeout(
                rouletteAutoTimer
            );
            rouletteAutoTimer = null;
        }
    }

    queueChipSave();

    res.json({
        ok: true,
        balance:
            getChipBalance(playerId),
        state:
            publicState()
    });
});

// Chicken Crossing routes

app.post("/chicken/start", (req, res) => {
    const chicken = ensureChickenState();

    const playerId =
        cleanPlayerId(req.body?.playerId);

    const playerName =
        cleanPlayerName(req.body?.playerName);

    const amount =
        cleanAmount(req.body?.amount);

    const risk = String(
        req.body?.risk || "medium"
    ).toLowerCase();

    if (
        !playerId ||
        !playerName ||
        !amount ||
        !CHICKEN_RISKS[risk]
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid chicken game settings"
        });
    }

    if (chicken.games[playerId]) {
        return res.status(409).json({
            ok: false,
            error: "Finish your current chicken game first"
        });
    }

    const debit = debitChips(
        playerId,
        amount,
        {
            playerName,
            type: "bet",
            gameType: "chicken",
            note: `Chicken Crossing ${risk} bet`
        }
    );

    if (!debit.ok) {
        return res.status(400).json(debit);
    }

    const game = {
        gameId:
            crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        betAmount: amount,
        risk,
        currentStep: 0,
        status: "playing",
        startedAt: Date.now()
    };

    chicken.games[playerId] = game;
    queueChipSave();

    res.json({
        ok: true,
        game: publicChickenGame(game),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/chicken/cross", (req, res) => {
    const chicken = ensureChickenState();

    const playerId =
        cleanPlayerId(req.body?.playerId);

    const game = chicken.games[playerId];

    if (!game || game.status !== "playing") {
        return res.status(404).json({
            ok: false,
            error: "No active chicken game"
        });
    }

    const risk =
        CHICKEN_RISKS[game.risk] ||
        CHICKEN_RISKS.medium;

    // The first lane is always safe so a newly started game
    // cannot immediately end on the player's first crossing.
    // Risk begins from the second lane onward.
    const isFirstCross =
        game.currentStep === 0;

    const roll =
        crypto.randomInt(0, 1_000_000) /
        1_000_000;

    if (
        !isFirstCross &&
        roll >= risk.survivalChance
    ) {
        const failedAtStep =
            game.currentStep + 1;

        finishChickenGame(
            game,
            "hit",
            0,
            0
        );

        return res.json({
            ok: true,
            safe: false,
            failedAtStep,
            state: publicState()
        });
    }

    game.currentStep += 1;

    const multiplier =
        chickenMultiplierForStep(
            game.currentStep,
            game.risk
        );

    if (game.currentStep >= CHICKEN_MAX_STEPS) {
        const payout = Math.floor(
            game.betAmount * multiplier
        );

        const credited = creditChips(
            game.playerId,
            payout,
            {
                playerName: game.playerName,
                type: "payout",
                gameType: "chicken",
                note:
                    `Chicken Crossing completed at x${multiplier.toFixed(2)}`
            }
        );

        if (!credited) {
            return res.status(400).json({
                ok: false,
                error: "Could not pay chicken winnings"
            });
        }

        finishChickenGame(
            game,
            "completed",
            payout,
            multiplier
        );

        return res.json({
            ok: true,
            safe: true,
            completed: true,
            multiplier,
            payout,
            state: publicState()
        });
    }

    queueChipSave();

    res.json({
        ok: true,
        safe: true,
        completed: false,
        step: game.currentStep,
        multiplier,
        potentialPayout:
            Math.floor(
                game.betAmount * multiplier
            ),
        state: publicState()
    });
});

app.post("/chicken/cashout", (req, res) => {
    const chicken = ensureChickenState();

    const playerId =
        cleanPlayerId(req.body?.playerId);

    const game = chicken.games[playerId];

    if (!game || game.status !== "playing") {
        return res.status(404).json({
            ok: false,
            error: "No active chicken game"
        });
    }

    if (game.currentStep < 1) {
        return res.status(400).json({
            ok: false,
            error: "Cross at least one lane before cashing out"
        });
    }

    const multiplier =
        chickenMultiplierForStep(
            game.currentStep,
            game.risk
        );

    const payout = Math.floor(
        game.betAmount * multiplier
    );

    const credited = creditChips(
        playerId,
        payout,
        {
            playerName: game.playerName,
            type: "payout",
            gameType: "chicken",
            note:
                `Chicken Crossing cashout at x${multiplier.toFixed(2)}`
        }
    );

    if (!credited) {
        return res.status(400).json({
            ok: false,
            error: "Could not pay chicken winnings"
        });
    }

    finishChickenGame(
        game,
        "cashout",
        payout,
        multiplier
    );

    res.json({
        ok: true,
        multiplier,
        payout,
        profit: payout - game.betAmount,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

// Deal game routes



app.post("/deal/start", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const playerName = cleanPlayerName(req.body?.playerName);
    const betAmount = cleanAmount(req.body?.amount);
    const chosenCase = Math.floor(
        Number(req.body?.chosenCase)
    );

    if (!playerId || !playerName || !betAmount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid deal game bet"
        });
    }

    if (
        !Number.isInteger(chosenCase) ||
        chosenCase < 0 ||
        chosenCase >= DEAL_CASE_COUNT
    ) {
        return res.status(400).json({
            ok: false,
            error: "Choose a valid case"
        });
    }

    if (state.deal.games[playerId]) {
        return res.status(409).json({
            ok: false,
            error: "Finish your current deal game first"
        });
    }

    const debit = debitChips(
        playerId,
        betAmount,
        {
            playerName,
            type: "bet",
            gameType: "deal",
            note: "Deal game started"
        }
    );

    if (!debit.ok) {
        return res.status(400).json(debit);
    }

    const caseValues = shuffleValues(
        DEAL_PRIZE_MULTIPLIERS.map(
            multiplier =>
                Math.floor(
                    betAmount * multiplier
                )
        )
    );

    const game = {
        gameId:
            crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        betAmount,
        chosenCase,
        caseValues,
        openedCases: [],
        openedValues: {},
        currentOffer: 0,
        roundOpened: 0,
        status: "playing",
        createdAt: Date.now()
    };

    state.deal.games[playerId] = game;
    queueChipSave();

    res.json({
        ok: true,
        game: publicDealGame(game),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/deal/open-case", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const caseIndex = Math.floor(
        Number(req.body?.caseIndex)
    );

    const game = state.deal.games[playerId];

    if (!game) {
        return res.status(404).json({
            ok: false,
            error: "No active deal game"
        });
    }

    if (game.currentOffer > 0) {
        return res.status(409).json({
            ok: false,
            error: "Choose Deal or No Deal first"
        });
    }

    if (
        !Number.isInteger(caseIndex) ||
        caseIndex < 0 ||
        caseIndex >= DEAL_CASE_COUNT ||
        caseIndex === game.chosenCase ||
        game.openedCases.includes(caseIndex)
    ) {
        return res.status(400).json({
            ok: false,
            error: "That case cannot be opened"
        });
    }

    game.openedCases.push(caseIndex);
    game.openedValues[caseIndex] =
        game.caseValues[caseIndex];
    game.roundOpened += 1;

    const unopenedOtherCases =
        DEAL_CASE_COUNT -
        game.openedCases.length -
        1;

    if (unopenedOtherCases <= 0) {
        const payout =
            game.caseValues[game.chosenCase];

        if (payout > 0) {
            creditChips(
                playerId,
                payout,
                {
                    playerName: game.playerName,
                    type: "payout",
                    gameType: "deal",
                    note: "Chosen case payout"
                }
            );
        }

        const history = finishDealGame(
            game,
            "chosen-case",
            payout
        );

        return res.json({
            ok: true,
            finished: true,
            openedCase: caseIndex,
            openedValue:
                game.caseValues[caseIndex],
            chosenValue: payout,
            history,
            balance:
                getChipBalance(playerId),
            state: publicState()
        });
    }

    if (
        game.roundOpened >=
        Math.min(
            DEAL_CASES_PER_ROUND,
            unopenedOtherCases + 1
        )
    ) {
        game.currentOffer =
            calculateDealOffer(game);
        game.roundOpened = 0;
    }

    queueChipSave();

    res.json({
        ok: true,
        finished: false,
        openedCase: caseIndex,
        openedValue:
            game.caseValues[caseIndex],
        offer: game.currentOffer,
        game: publicDealGame(game),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/deal/accept", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const game = state.deal.games[playerId];

    if (!game || !game.currentOffer) {
        return res.status(400).json({
            ok: false,
            error: "No banker offer available"
        });
    }

    const payout = game.currentOffer;

    // Preserve the hidden case layout before finishDealGame removes
    // the active game. This is only returned after the player accepts.
    const allCaseValues = [...game.caseValues];
    const chosenCase = game.chosenCase;
    const chosenValue = game.caseValues[chosenCase];

    creditChips(
        playerId,
        payout,
        {
            playerName: game.playerName,
            type: "payout",
            gameType: "deal",
            note: "Accepted banker offer"
        }
    );

    const history = finishDealGame(
        game,
        "deal",
        payout
    );

    res.json({
        ok: true,
        payout,
        chosenCase,
        chosenValue,
        allCaseValues,
        history,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/deal/reject", (req, res) => {
    const playerId = cleanPlayerId(req.body?.playerId);
    const game = state.deal.games[playerId];

    if (!game || !game.currentOffer) {
        return res.status(400).json({
            ok: false,
            error: "No banker offer available"
        });
    }

    game.currentOffer = 0;
    queueChipSave();

    res.json({
        ok: true,
        game: publicDealGame(game),
        state: publicState()
    });
});

// Mines routes

app.post("/mines/start", (req, res) => {
    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    const betAmount = cleanAmount(
        req.body?.amount
    );

    const mineCount = Math.floor(
        Number(req.body?.mineCount || 0)
    );

    if (!playerId || !playerName || !betAmount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid Mines bet"
        });
    }

    if (
        !Number.isInteger(mineCount) ||
        mineCount < MINES_MIN_COUNT ||
        mineCount > MINES_MAX_COUNT
    ) {
        return res.status(400).json({
            ok: false,
            error:
                `Choose between ${MINES_MIN_COUNT} and ` +
                `${MINES_MAX_COUNT} mines`
        });
    }

    if (state.mines.games[playerId]) {
        return res.status(409).json({
            ok: false,
            error:
                "Finish or cash out your current Mines game first"
        });
    }

    rememberPlayer(playerId, playerName);

    const debit = debitChips(
        playerId,
        betAmount,
        {
            playerName,
            type: "bet",
            gameType: "mines",
            note: `Mines game with ${mineCount} mines`
        }
    );

    if (!debit.ok) {
        return res.status(400).json(debit);
    }

    const game = {
        gameId:
            crypto.randomBytes(8).toString("hex"),
        playerId,
        playerName,
        betAmount,
        mineCount,
        minePositions:
            createMinePositions(mineCount),
        revealed: [],
        safeReveals: 0,
        status: "playing",
        createdAt: Date.now()
    };

    state.mines.games[playerId] = game;
    queueChipSave();

    res.json({
        ok: true,
        game: publicMineGame(game),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/mines/reveal", (req, res) => {
    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const cell = Math.floor(
        Number(req.body?.cell)
    );

    const game = state.mines.games[playerId];

    if (!game) {
        return res.status(404).json({
            ok: false,
            error: "No active Mines game"
        });
    }

    if (
        !Number.isInteger(cell) ||
        cell < 0 ||
        cell >= MINES_BOARD_SIZE
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid Mines tile"
        });
    }

    if (game.revealed.includes(cell)) {
        return res.status(400).json({
            ok: false,
            error: "Tile already revealed"
        });
    }

    if (game.minePositions.includes(cell)) {
        const history = finishMineGame(
            game,
            "mine",
            0,
            cell
        );

        return res.json({
            ok: true,
            hitMine: true,
            minePositions: [
                ...game.minePositions
            ],
            history,
            balance:
                getChipBalance(playerId),
            state: publicState()
        });
    }

    game.revealed.push(cell);
    game.safeReveals += 1;

    const safeCells =
        MINES_BOARD_SIZE - game.mineCount;

    if (game.safeReveals >= safeCells) {
        const multiplier =
            getMinesMultiplier(
                game.mineCount,
                game.safeReveals
            );

        const payout = Math.floor(
            game.betAmount * multiplier
        );

        creditChips(
            playerId,
            payout,
            {
                playerName: game.playerName,
                type: "payout",
                gameType: "mines",
                note: "Cleared every safe Mines tile"
            }
        );

        const history = finishMineGame(
            game,
            "cleared",
            payout
        );

        return res.json({
            ok: true,
            hitMine: false,
            cleared: true,
            revealedCell: cell,
            revealed: [...game.revealed],
            minePositions: [...game.minePositions],
            history,
            balance:
                getChipBalance(playerId),
            state: publicState()
        });
    }

    queueChipSave();

    res.json({
        ok: true,
        hitMine: false,
        cleared: false,
        revealedCell: cell,
        game: publicMineGame(game),
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/mines/cashout", (req, res) => {
    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const game = state.mines.games[playerId];

    if (!game) {
        return res.status(404).json({
            ok: false,
            error: "No active Mines game"
        });
    }

    if (game.safeReveals < 1) {
        return res.status(400).json({
            ok: false,
            error:
                "Reveal at least one safe tile before cashing out"
        });
    }

    const multiplier =
        getMinesMultiplier(
            game.mineCount,
            game.safeReveals
        );

    const payout = Math.floor(
        game.betAmount * multiplier
    );

    creditChips(
        playerId,
        payout,
        {
            playerName: game.playerName,
            type: "payout",
            gameType: "mines",
            note:
                `Mines cash-out at x${multiplier.toFixed(2)}`
        }
    );

    const history = finishMineGame(
        game,
        "cashout",
        payout
    );

    res.json({
        ok: true,
        payout,
        multiplier,
        minePositions: [
            ...game.minePositions
        ],
        history,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

// Wheel routes
app.post("/place-bet", (req, res) => {
    if (state.wheel.spinning) {
        return res.status(409).json({
            ok: false,
            error: "Spin already running"
        });
    }

    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    const amount = cleanAmount(
        req.body?.amount
    );

    if (!playerId || !playerName || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid bet"
        });
    }

    rememberPlayer(playerId, playerName);

    const existing = state.wheel.bets.find(
        bet => bet.playerId === playerId
    );

    if (existing) {
        const reserved = replaceReservedBet(
            existing,
            amount,
            playerId,
            playerName,
            "wheel"
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        existing.playerName = playerName;
        existing.amount = amount;
        existing.confirmed = true;
        existing.updatedAt = Date.now();
    } else {
        const reserved = debitChips(
            playerId,
            amount,
            {
                playerName,
                type: "bet",
                gameType: "wheel",
                note: "Wheel bet placed"
            }
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        state.wheel.bets.push({
            playerId,
            playerName,
            amount,
            confirmed: true,
            createdAt: Date.now()
        });
    }

    scheduleWheelAutoStart();

    res.json({
        ok: true,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/confirm-all", (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (state.wheel.spinning) return res.status(409).json({ ok: false, error: "Spin already running" });

    state.wheel.bets.forEach(b => b.confirmed = true);
    res.json({ ok: true, state: publicState() });
});

app.post("/clear-round", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (state.wheel.spinning) {
        return res.status(409).json({
            ok: false,
            error: "Spin already running"
        });
    }

    if (wheelAutoTimer) {
        clearTimeout(wheelAutoTimer);
        wheelAutoTimer = null;
    }

    state.wheel.autoStartAt = null;

    refundBets(
        state.wheel.bets,
        "wheel",
        "Wheel bets cleared by banker"
    );

    state.wheel.bets = [];

    res.json({
        ok: true,
        state: publicState()
    });
});

app.post("/spin", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (wheelAutoTimer) {
        clearTimeout(wheelAutoTimer);
        wheelAutoTimer = null;
    }

    state.wheel.autoStartAt = null;

    const result = startWheelSpin();

    if (!result.ok) {
        return res.status(400).json(result);
    }

    res.json({
        ok: true,
        spin: result.spin,
        state: publicState()
    });
});

// Blackjack routes
app.post("/blackjack/place-bet", (req, res) => {
    const bj = state.blackjack;

    if (bj.status === "playing") {
        return res.status(409).json({
            ok: false,
            error: "Blackjack round already running"
        });
    }

    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    const amount = cleanAmount(
        req.body?.amount
    );

    if (!playerId || !playerName || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid blackjack bet"
        });
    }

    if (bj.status === "finished") {
        bj.players = [];
        bj.dealerHand = [];
        bj.deck = [];
        bj.status = "waiting";
        bj.currentTurnIndex = 0;
    }

    rememberPlayer(playerId, playerName);

    const existing = bj.bets.find(
        bet => bet.playerId === playerId
    );

    if (existing) {
        const reserved = replaceReservedBet(
            existing,
            amount,
            playerId,
            playerName,
            "blackjack"
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        existing.playerName = playerName;
        existing.amount = amount;
        existing.confirmed = true;
        existing.updatedAt = Date.now();
    } else {
        const reserved = debitChips(
            playerId,
            amount,
            {
                playerName,
                type: "bet",
                gameType: "blackjack",
                note: "Blackjack bet placed"
            }
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        bj.bets.push({
            playerId,
            playerName,
            amount,
            confirmed: true,
            createdAt: Date.now()
        });
    }

    scheduleBlackjackAutoStart();

    res.json({
        ok: true,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/blackjack/confirm-all", (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (state.blackjack.status === "playing") return res.status(409).json({ ok: false, error: "Round already running" });

    state.blackjack.bets.forEach(b => b.confirmed = true);
    res.json({ ok: true, state: publicState() });
});

app.post("/blackjack/start", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (blackjackAutoTimer) {
        clearTimeout(blackjackAutoTimer);
        blackjackAutoTimer = null;
    }

    state.blackjack.autoStartAt = null;

    const result = startBlackjackRound();

    if (!result.ok) {
        return res.status(400).json(result);
    }

    res.json({
        ok: true,
        state: publicState()
    });
});

app.post("/blackjack/hit", (req, res) => {
    const bj = state.blackjack;
    const playerId = String(req.body?.playerId || "");
    const player = activeBlackjackPlayer();

    if (!player || player.playerId !== playerId) return res.status(403).json({ ok: false, error: "Not your turn" });

    player.hand.push(drawCard());
    const total = handValue(player.hand);
    if (total > 21) {
        player.status = "bust";
        moveToNextBlackjackTurn();
    }

    res.json({ ok: true, state: publicState() });
});

app.post("/blackjack/stand", (req, res) => {
    const playerId = String(req.body?.playerId || "");
    const player = activeBlackjackPlayer();

    if (!player || player.playerId !== playerId) return res.status(403).json({ ok: false, error: "Not your turn" });

    player.status = "stand";
    moveToNextBlackjackTurn();
    res.json({ ok: true, state: publicState() });
});

app.post("/blackjack/reset", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (state.blackjack.status === "playing") {
        return res.status(409).json({
            ok: false,
            error: "Cannot reset a running blackjack round"
        });
    }

    if (blackjackAutoTimer) {
        clearTimeout(blackjackAutoTimer);
        blackjackAutoTimer = null;
    }

    state.blackjack.autoStartAt = null;

    refundBets(
        state.blackjack.bets,
        "blackjack",
        "Blackjack bets cleared by banker"
    );

    state.blackjack.bets = [];
    state.blackjack.players = [];
    state.blackjack.dealerHand = [];
    state.blackjack.deck = [];
    state.blackjack.status = "waiting";
    state.blackjack.currentTurnIndex = 0;

    res.json({
        ok: true,
        state: publicState()
    });
});

// Horse racing routes
app.post("/racing/place-bet", (req, res) => {
    const race = state.racing;

    if (race.racing) {
        return res.status(409).json({
            ok: false,
            error: "Race already running"
        });
    }

    const playerId = cleanPlayerId(
        req.body?.playerId
    );

    const playerName = cleanPlayerName(
        req.body?.playerName
    );

    const amount = cleanAmount(
        req.body?.amount
    );

    const horseId = String(
        req.body?.horseId || ""
    );

    const horse = race.horses.find(
        item => item.id === horseId
    );

    if (!playerId || !playerName || !amount) {
        return res.status(400).json({
            ok: false,
            error: "Invalid race bet"
        });
    }

    if (!horse) {
        return res.status(400).json({
            ok: false,
            error: "Choose a horse"
        });
    }

    rememberPlayer(playerId, playerName);

    const existing = race.bets.find(
        bet => bet.playerId === playerId
    );

    if (existing) {
        const reserved = replaceReservedBet(
            existing,
            amount,
            playerId,
            playerName,
            "racing"
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        existing.playerName = playerName;
        existing.amount = amount;
        existing.horseId = horse.id;
        existing.horseName = horse.name;
        existing.confirmed = true;
        existing.updatedAt = Date.now();
    } else {
        const reserved = debitChips(
            playerId,
            amount,
            {
                playerName,
                type: "bet",
                gameType: "racing",
                note: `Horse racing bet on ${horse.name}`
            }
        );

        if (!reserved.ok) {
            return res.status(400).json({
                ok: false,
                error: reserved.error
            });
        }

        race.bets.push({
            playerId,
            playerName,
            amount,
            horseId: horse.id,
            horseName: horse.name,
            confirmed: true,
            createdAt: Date.now()
        });
    }

    scheduleRacingAutoStart();

    res.json({
        ok: true,
        balance: getChipBalance(playerId),
        state: publicState()
    });
});

app.post("/racing/confirm-all", (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (state.racing.racing) return res.status(409).json({ ok: false, error: "Race already running" });

    state.racing.bets.forEach(b => b.confirmed = true);
    res.json({ ok: true, state: publicState() });
});

app.post("/racing/clear", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (state.racing.racing) {
        return res.status(409).json({
            ok: false,
            error: "Race already running"
        });
    }

    if (racingAutoTimer) {
        clearTimeout(racingAutoTimer);
        racingAutoTimer = null;
    }

    state.racing.autoStartAt = null;

    refundBets(
        state.racing.bets,
        "racing",
        "Race bets cleared by banker"
    );

    state.racing.bets = [];

    res.json({
        ok: true,
        state: publicState()
    });
});

app.post("/racing/start", (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (racingAutoTimer) {
        clearTimeout(racingAutoTimer);
        racingAutoTimer = null;
    }

    state.racing.autoStartAt = null;

    const result = startHorseRace();

    if (!result.ok) {
        return res.status(400).json(result);
    }

    res.json({
        ok: true,
        race: result.race,
        state: publicState()
    });
});

function shutdownServer(signal) {
    console.log(
        `${signal} received. Saving chip data...`
    );

    if (chipSaveTimer) {
        clearTimeout(chipSaveTimer);
        chipSaveTimer = null;
    }

    saveChipDataImmediately();
    process.exit(0);
}

process.on("SIGTERM", () => {
    shutdownServer("SIGTERM");
});

process.on("SIGINT", () => {
    shutdownServer("SIGINT");
});

loadChipData();

app.listen(PORT, () => {
    console.log(`TT Shared Casino server running on port ${PORT}`);
    console.log(`Banker PIN: ${ADMIN_PIN}`);
    console.log(`Automatic games start after ${AUTO_START_DELAY_MS / 1000} seconds`);
});
