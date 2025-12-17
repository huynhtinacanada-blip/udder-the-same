// v1.1.2 release — Game Server
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
// This ensures the database schema is ready when the server starts.
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,          -- Room code (unique identifier)
      status TEXT NOT NULL DEFAULT 'open',-- Room status: open/closed
      current_round INT DEFAULT 0,        -- Tracks current round number
      active_question_id INT,             -- Which question is active
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,                 -- Player name
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      submitted BOOLEAN DEFAULT FALSE,    -- Has player submitted answer?
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

/* ---------------- Helper Functions ---------------- */

// getActiveNames: returns list of currently connected player names in a room
function getActiveNames(roomCode) {
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  const activeNames = [];
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name) activeNames.push(s.data.name);
  }
  return activeNames;
}

// getActiveStats: combines DB player list with active socket connections
async function getActiveStats(roomCode) {
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

// getScoreboard: aggregates scores per player, ensures latest round exists
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

// emitPlayerList: broadcasts player list and submission progress
async function emitPlayerList(roomCode) {
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

// emitScoreboard: broadcasts updated scoreboard
async function emitScoreboard(roomCode) {
  const scoreboard = await getScoreboard(roomCode);
  io.to(roomCode).emit("scoreboardUpdated", scoreboard);
}

/* ---------------- HTTP Route for Login ---------------- */
// Called by player-login.html to join or create a room
app.post("/player-login", async (req, res) => {
  const { roomCode, playerName, themeCode } = req.body;
  try {
    // Ensure room exists or create it
    let room = await pool.query("SELECT * FROM rooms WHERE code=$1", [roomCode]);
    if (room.rows.length === 0) {
      await pool.query(
        "INSERT INTO rooms (code, status, current_round) VALUES ($1,'open',0)",
        [roomCode]
      );
    }

    // Ensure player exists
    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
      [playerName, roomCode]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------------- Socket Events ---------------- */
io.on("connection", (socket) => {
  // joinLobby: when a player joins the lobby
  socket.on("joinLobby", async ({ roomCode, name, themeCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      socket.data.name = name;
      socket.data.roomCode = rc;
      socket.data.themeCode = themeCode;
      socket.join(rc);

      await pool.query(
        "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
        [name, rc]
      );

      await emitPlayerList(rc);
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in joinLobby:", err);
    }
  });

  // startRound: begins a new round by selecting a question and notifying players
  socket.on("startRound", async ({ roomCode, themeCode }) => {
    try {
      const rc = roomCode.toUpperCase();

      // Pick a random question from DB for this theme
      const { rows } = await pool.query(
        "SELECT id, prompt FROM questions WHERE theme=$1 ORDER BY RANDOM() LIMIT 1",
        [themeCode]
      );
      if (rows.length === 0) return; // no questions available

      const q = rows[0];

      // Increment round and set active question
      await pool.query(
        "UPDATE rooms SET current_round=current_round+1, active_question_id=$2 WHERE code=$1",
        [rc, q.id]
      );

      // Reset players submitted flag
      await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);

      // Broadcast round start to all players in room
      const playerCount = (await pool.query("SELECT COUNT(*) FROM players WHERE room_code=$1",[rc])).rows[0].count;
      const roundNumber = (await pool.query("SELECT current_round FROM rooms WHERE code=$1",[rc])).rows[0].current_round;

      io.to(rc).emit("roundStarted", {
        questionId: q.id,
        prompt: q.prompt,
        playerCount,
        roundNumber,
        myAnswer: null,
        popup: true,
        theme: themeCode
      });
    } catch (err) {
      console.error("Error in startRound:", err);
    }
  });

  // submitAnswer: player submits an answer for current round
  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    try {
      const rc = roomCode.toUpperCase();

      // Find current round
      const { rows: roomRows } = await pool.query(
        "SELECT current_round FROM rooms WHERE code=$1",
        [rc]
      );
      const roundNumber = roomRows[0]?.current_round || 1;

      // Insert answer
      await pool.query(
        `INSERT INTO answers (room_code, player_name, question_id, round_number, answer)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (room_code, LOWER(player_name), question_id, round_number)
         DO UPDATE SET answer=$5, updated_at=NOW()`,
        [rc, name, questionId, roundNumber, answer]
      );

      // Mark player as submitted
      await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND name=$2", [rc, name]);

      // Update player list and submission progress
      await emitPlayerList(rc);
    } catch (err) {
      console.error("Error in submitAnswer:", err);
    }
  });

  // showAnswers: reveal all answers and pivot counts
  socket.on("showAnswers", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      const room = await pool.query(
        `SELECT r.current_round, r.active_question_id, q.prompt AS question_prompt
         FROM rooms r JOIN questions q ON r.active_question_id = q.id
         WHERE r.code=$1`,
        [rc]
      );
      if (room.rows.length === 0) return;

      const rr = await pool.query(
        `SELECT a.player_name AS name, a.answer, s.tag
         FROM answers a
         LEFT JOIN scores s
           ON a.room_code = s.room_code
          AND a.round_number = s.round_number
          AND LOWER(a.player_name) = LOWER(s.player_name)
         WHERE a.room_code=$1
           AND a.question_id=$2
           AND a.round_number=$3
         ORDER BY a.answer ASC, a.player_name ASC`,
        [rc, room.rows[0].active_question_id, room.rows[0].current_round]
      );

      io.to(rc).emit("answersRevealed", {
        rows: rr.rows,
        round: room.rows[0].current_round,
        questionPrompt: room.rows[0].question_prompt
      });

      // Pivot counts query
      const pivot = await pool.query(
        `SELECT a.answer, COUNT(*) AS player_count
         FROM answers a
         WHERE a.room_code=$1
           AND a.question_id=$2
           AND a.round_number=$3
         GROUP BY a.answer
         ORDER BY player_count DESC, a.answer ASC`,
        [rc, room.rows[0].active_question_id, room.rows[0].current_round]
      );

      io.to(rc).emit("pivotUpdated", pivot.rows);

      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in showAnswers:", err);
    }
  });

  // awardPoint: award points to a single player for a round
  socket.on("awardPoint", async ({ roomCode, playerName, roundNumber, points }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query(
        `INSERT INTO scores (room_code, player_name, round_number, points)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (room_code, LOWER(player_name), round_number)
         DO UPDATE SET points=$4, updated_at=NOW()`,
        [rc, playerName, roundNumber, points]
      );
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPoint:", err);
    }
  });

  // awardPivotPoints: award +1 to all players who submitted the selected answer
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

      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPivotPoints:", err);
    }
  });

  // setUnicorn: assign unicorn tag to a player
  socket.on("setUnicorn", async ({ roomCode, playerName }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE scores SET tag = NULL WHERE room_code = $1 AND tag = '🦄'`,
        [roomCode]
      );
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
      await client.query("COMMIT");
      const scoreboard = await getScoreboard(roomCode);
      io.to(roomCode).emit("scoreboardUpdated", scoreboard);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error setting unicorn:", err);
    } finally {
      client.release();
    }
  });

  // closeRoom: mark room as closed
  socket.on("closeRoom", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query(
        "UPDATE rooms SET status='closed', active_question_id=NULL, updated_at=NOW() WHERE code=$1",
        [rc]
      );
      io.to(rc).emit("roomClosed");
    } catch (err) {
      console.error("Error in closeRoom:", err);
    }
  });

  // disconnect: handle player leaving
  socket.on("disconnect", async () => {
    try {
      const r = socket.data?.roomCode;
      if (r) {
        await emitPlayerList(r);
      }
    } catch (err) {
      console.error("Error in disconnect:", err);
    }
  });
});

/* ---------------- Start Server ---------------- */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Udderly the Same running on port " + PORT));
