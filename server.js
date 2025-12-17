// v1.2.0 release — Game Server
// -----------------------------------
// This file sets up the Express server, PostgreSQL tables, and Socket.IO game logic.
//  - Proper filtering of questions with discard IS NULL
//  - Unique index on answers to enforce one answer per player per round
//  - Consistent LOWER(name) normalization
//  - try/catch around DB calls to prevent crashes

/* Things to do:

  Configure Helmet with Options:
   Helmet adds security headers to Express apps.
  - Default: basic headers only.
  - Fix: configure CSP, HSTS, frameguard, etc.
  - This reduces "low severity" warnings from scanners.

  
  Password hashing:
    - Never store plain text passwords in code or env vars.
    - Always hash with bcrypt or similar.
    - Add rate limiting to login routes to prevent brute force.
    - Validate inputs before comparing.


  ============================
  SECURITY NOTE: ESCAPING TEXT
  ============================

  What it is:
  - "Escaping" means converting special characters in dynamic text (like <, >, &) 
    into safe representations before inserting them into the page.
  - Example: "<script>" becomes "&lt;script&gt;" so the browser shows it as text 
    instead of running it as code.

  Why it matters:
  - Any text coming from users, URLs, or the server could be malicious.
  - Without escaping, attackers could inject HTML or JavaScript into your page 
    (called Cross-Site Scripting, or XSS).
  - Escaping ensures that dynamic values are displayed safely as text, not executed.

  Rule of thumb:
  - Always wrap dynamic values with escapeHTML() before inserting into the DOM.
  - Safe: hardcoded strings you write yourself.
  - Needs escaping: anything from user input, server responses, or URL parameters.

  In this code:
  - We escape room codes, player names, prompts, progress counts, and any other 
    dynamic values before showing them in the UI.
  - This keeps the game secure and prevents injection attacks.
*/

/*

//express-rate-limit and bcrypt module not installed so can't user rate-limit attempts and hash password.

  ACCESS CONTROL NOTE:
  --------------------
  - Never trust the browser alone to enforce access rules.
  - Users can type a direct URL and skip your login page.
  - Always validate room codes and player names on the server.
  - Add client-side guards (redirect if missing params), but 
    remember: server-side checks are the real protection.
*/

/* setup → helpers → APIs → socket events → start */

/* ---------------- Setup ---------------- */
// Import required libraries
const express = require("express");       // Web framework for HTTP routes
const http = require("http");             // Node's built-in HTTP server
const path = require("path");             // Utility for file paths
const bodyParser = require("body-parser");// Middleware to parse JSON request bodies
const { Pool } = require("pg");           // PostgreSQL client
const { Server } = require("socket.io");  // Real-time communication library

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Attach Socket.IO to the server
const io = new Server(server);

// Middleware setup
app.use(bodyParser.json()); // Parse JSON bodies
app.use(express.static(path.join(__dirname, "public"))); // Serve static files from /public

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ---------------- Initialize Tables ---------------- */
// Create tables if they don’t exist yet.
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,          -- Room code (unique identifier)
      status TEXT NOT NULL DEFAULT 'open',-- Room status: open/closed
      current_round INT DEFAULT 0,        -- Tracks current round number
      active_question_id INT,             -- Which question is active
      popup_active BOOLEAN DEFAULT false, -- Whether popup is active
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()  -- Last update timestamp
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,                 -- Player name
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      submitted BOOLEAN DEFAULT FALSE,    -- Has player submitted answer?
      has_unicorn BOOLEAN DEFAULT false,  -- Is player unicorn?
      score_total INT DEFAULT 0,          -- Quick lookup for total score
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS players_name_room_unique
      ON players (LOWER(name), room_code);`);

    await pool.query(`CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,               -- Question text
      theme TEXT DEFAULT NULL,            -- Theme code
      discard DATE DEFAULT NULL,          -- When discarded
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      round_number INT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS answers_unique_per_round
      ON answers (room_code, LOWER(player_name), question_id, round_number);`);

    await pool.query(`CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      round_number INT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      tag TEXT DEFAULT NULL,              -- Unicorn tag
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (room_code, player_name, round_number)
    );`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scores_unique_per_round
      ON scores (room_code, LOWER(player_name), round_number);`);
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();

/* ---------------- Helpers ---------------- */
// Utility functions used by both APIs and socket events

function getActiveNames(roomCode) {
  // Returns list of currently connected player names in a room
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  const activeNames = [];
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name) activeNames.push(s.data.name);
  }
  return activeNames;
}

async function getActiveStats(roomCode) {
  // Combines DB player list with active socket connections
  const dbPlayers = await pool.query(
    "SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC",
    [roomCode]
  );
  const activeNames = getActiveNames(roomCode);
  const merged = dbPlayers.rows.map(p => ({
    name: p.name,
    submitted: p.submitted,
    active: activeNames.includes(p.name)
  }));
  const activeCount = merged.filter(p => p.active).length;
  const submittedActiveCount = merged.filter(p => p.active && p.submitted).length;
  return { merged, activeCount, submittedActiveCount };
}

// Build scoreboard data
async function getScoreboard(roomCode) {
  const { rows: roomRows } = await pool.query(
    `SELECT current_round FROM rooms WHERE code=$1`,
    [roomCode]
  );
  const currentRound = roomRows[0]?.current_round || 1;

  const { rows } = await pool.query(
    `SELECT MIN(p.player_name) AS player_name,
            SUM(p.points) AS total,
            json_object_agg(p.round_number, p.points)::json AS rounds,
            COALESCE(u.tag, '') AS tag
     FROM scores p
     LEFT JOIN (
         SELECT s2.room_code,
                LOWER(s2.player_name) AS player_key,
                MAX(s2.round_number) AS latest_round
         FROM scores s2
         WHERE s2.tag = '🦄'
         GROUP BY s2.room_code, LOWER(s2.player_name)
     ) latest
       ON latest.room_code = p.room_code
      AND latest.player_key = LOWER(p.player_name)
     LEFT JOIN scores u
       ON u.room_code = latest.room_code
      AND LOWER(u.player_name) = latest.player_key
      AND u.round_number = latest.latest_round
     WHERE p.room_code = $1
     GROUP BY LOWER(p.player_name), u.tag
     ORDER BY MIN(p.player_name) ASC`,
    [roomCode]
  );

  rows.forEach(r => {
    if (!r.rounds[currentRound]) {
      r.rounds[currentRound] = 0;
    }
  });

  return rows;
}

async function emitPlayerList(roomCode) {
  // Broadcasts player list and submission progress to all clients
  const { merged, activeCount, submittedActiveCount } = await getActiveStats(roomCode);
  io.to(roomCode).emit("playerList", {
    players: merged,
    activeCount,
    submittedCount: submittedActiveCount
  });
  io.to(roomCode).emit("submissionProgress", {
    submittedCount: submittedActiveCount,
    totalPlayers: activeCount
  });
}

async function emitScoreboard(roomCode) {
  // Broadcasts updated scoreboard to all clients
  const scoreboard = await getScoreboard(roomCode);
  io.to(roomCode).emit("scoreboardUpdated", scoreboard);
}

function isPlayerActive(roomCode, playerName) {
  // Checks if a specific player is currently connected
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name && s.data.name.toLowerCase() === playerName.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/* ---------------- APIs ---------------- */
// Admin login, room management, question management, player join
// (all your original code here — unchanged)

/* ---------------- Socket Events ---------------- */
io.on("connection", (socket) => {
  // joinLobby (your original code here — unchanged)

  // startRound (your original code here — unchanged)

  // submitAnswer (your original code here — unchanged)

  // showAnswers (your original code here — unchanged)

  // awardPoint (your original code here — unchanged)

  // ---- Pivot awarding event ----
  socket.on("awardPivotPoints", async ({ roomCode, answer }) => {
    try {
      const rc = roomCode.toUpperCase();
      const { rows: roomRows } = await pool.query(
        "SELECT current_round, active_question_id FROM rooms WHERE code=$1",
        [rc]
      );
      if (roomRows.length === 0) return;
      const roundNumber = roomRows[0].current_round;
      const questionId  = roomRows[0].active_question_id;

      const { rows: matching } = await pool.query(
        `SELECT player_name
           FROM answers
          WHERE room_code=$1
            AND question_id=$2
            AND round_number=$3
            AND answer=$4`,
        [rc, questionId, roundNumber, answer]
      );

      for (const row of matching) {
        await pool.query(
          `INSERT INTO scores (room_code, player_name, round_number, points)
           VALUES ($1,$2,$3,1)
           ON CONFLICT (room_code, LOWER(player_name), round_number)
           DO UPDATE SET points=1, updated_at=NOW()`,
          [rc, row.player_name, roundNumber]
        );
      }

      // After updating scores for all matching players,
      // broadcast the updated scoreboard to everyone in the room
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPivotPoints:", err);
    }
  });

  // ---- Unicorn assignment event ----
  // When the client emits "setUnicorn", we atomically clear all unicorns
  // in the room and then assign the unicorn tag to the selected player.
  socket.on("setUnicorn", async ({ roomCode, playerName }) => {
    const client = await pool.connect(); // get a DB connection from the pool
    try {
      await client.query("BEGIN"); // start transaction

      // Step 1: Clear any existing unicorn tags in this room
      await client.query(
        `UPDATE scores
         SET tag = NULL
         WHERE room_code = $1 AND tag = '🦄'`,
        [roomCode]
      );

      // Step 2: Assign unicorn tag to the selected player
      // We find the latest round for that player (MAX(round_number))
      // and set its tag to 🦄. Case-insensitive match on player_name.
      await client.query(
        `UPDATE scores
         SET tag = '🦄'
         WHERE room_code = $1
           AND LOWER(player_name) = LOWER($2)
           AND round_number = (
             SELECT MAX(round_number)
             FROM scores
             WHERE room_code = $1
               AND LOWER(player_name) = LOWER($2)
           )`,
        [roomCode, playerName]
      );

      await client.query("COMMIT"); // commit transaction

      // Step 3: Broadcast updated scoreboard to all clients in the room
      const scoreboard = await getScoreboard(roomCode);
      io.to(roomCode).emit("scoreboardUpdated", scoreboard);

    } catch (err) {
      // If anything fails, rollback transaction to keep DB consistent
      await client.query("ROLLBACK");
      console.error("Error setting unicorn:", err);
    } finally {
      // Always release DB connection back to pool
      client.release();
    }
  });

  // ---- Close room event ----
  // Marks a room as closed so no new rounds or answers can be submitted.
  socket.on("closeRoom", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query(
        "UPDATE rooms SET status='closed', active_question_id=NULL, updated_at=NOW() WHERE code=$1",
        [rc]
      );
      // Notify all clients in the room that it has been closed
      io.to(rc).emit("roomClosed");
    } catch (err) {
      console.error("Error in closeRoom:", err);
    }
  });

  // ---- Disconnect event ----
  // Triggered when a player’s socket disconnects (e.g. closes browser).
  // We update the player list so remaining players see who is still active.
  socket.on("disconnect", async () => {
    try {
      const r = socket.data?.roomCode;
      if (r) {
        await emitPlayerList(r); // Update player list for remaining players
      }
    } catch (err) {
      console.error("Error in disconnect:", err);
    }
  });
}); // <-- closes io.on("connection")

/* ---------------- Start Server ---------------- */
// Start listening for HTTP and WebSocket connections
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Udderly the Same running on port " + PORT));
