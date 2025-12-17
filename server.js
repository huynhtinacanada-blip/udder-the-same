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

// Attach Socket.IO to the server (for real-time events)
const io = new Server(server);

// Middleware setup
app.use(bodyParser.json()); // Parse JSON bodies on incoming HTTP requests
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
      theme TEXT DEFAULT NULL,            -- theme code
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

// Helper to build scoreboard data
// Aggregates scores per player, ensures latest round column exists with 0s if untouched
async function getScoreboard(roomCode) {
  // First, get the current round for the room
  const { rows: roomRows } = await pool.query(
    `SELECT current_round FROM rooms WHERE code=$1`,
    [roomCode]
  );
  const currentRound = roomRows[0]?.current_round || 1;

  // Query all scores and join the latest unicorn tag per player
  const { rows } = await pool.query(
    `SELECT MIN(p.player_name) AS player_name,   -- canonical spelling
            SUM(p.points) AS total,
            json_object_agg(p.round_number, p.points)::json AS rounds,
            COALESCE(u.tag, '') AS tag
     FROM scores p
     LEFT JOIN (
         -- Find the most recent unicorn tag per player (case-insensitive)
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

  // Ensure each player has an entry for the current round
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
// REST endpoints for admin, rooms, questions, players

// Admin login
// Purpose: Authenticate admin using environment variables and redirect to dashboard.
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(500).json({ error: "Admin credentials not configured" });
  }
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ success: true, redirect: "/admin-dashboard.html" });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// Room management
// Purpose: List rooms (for admin dashboard).
app.get("/api/rooms", async (_req, res) => {
  const r = await pool.query("SELECT code, status, created_at, current_round FROM rooms ORDER BY id DESC");
  res.json(r.rows);
});

// Purpose: Create a new room with provided code and status.
app.post("/api/rooms", async (req, res) => {
  // ⚠️ Only use for brand new rooms; reopening should use PATCH
  const { code, status } = req.body;
  await pool.query("INSERT INTO rooms (code, status) VALUES ($1,$2)", [code.toUpperCase(), status || "open"]);
  res.json({ success: true });
});

// Purpose: Update room status without resetting round state (reopen/close).
app.patch("/api/rooms/:code", async (req, res) => {
  // ⚠️ Use this to reopen/update existing room without resetting current_round
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status,current_round", [status, code]);
  res.json(r.rows[0]);
});

// Purpose: Load a single room’s current state (status, active question, popup flag).
app.get("/api/rooms/:code", async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  try {
    const { rows } = await pool.query(
      "SELECT code, status, current_round, active_question_id, popup_active, created_at, updated_at FROM rooms WHERE code=$1",
      [roomCode]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Optionally include the active question’s prompt
    let questionPrompt = null;
    if (rows[0].active_question_id) {
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [rows[0].active_question_id]);
      if (q.rows.length > 0) {
        questionPrompt = q.rows[0].prompt;
      }
    }

    res.json({
      ...rows[0],
      questionPrompt
    });
  } catch (err) {
    console.error("Error loading room:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Question management (CRUD + discard)
// Purpose: Fetch all questions (including theme and discard status).
app.get("/api/questions", async (_req, res) => {
  try {
    const r = await pool.query("SELECT id, prompt, theme, discard FROM questions ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    console.error("Error fetching questions:", err);
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// Purpose: Create a new question (prompt only).
app.post("/api/questions", async (req, res) => {
  try {
    const { text } = req.body;
    const r = await pool.query(
      "INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt",
      [text.trim()]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Error creating question:", err);
    res.status(500).json({ error: "Failed to create question" });
  }
});

// Purpose: Update a question’s prompt text.
app.put("/api/questions/:id", async (req, res) => {
  try {
    const { text } = req.body;
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      "UPDATE questions SET prompt=$1 WHERE id=$2 RETURNING id, prompt, discard",
      [text.trim(), id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Error updating question:", err);
    res.status(500).json({ error: "Failed to update question" });
  }
});

// Purpose: Delete a question by ID.
app.delete("/api/questions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM questions WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting question:", err);
    res.status(500).json({ error: "Failed to delete question" });
  }
});

// Purpose: Set discard date for SELECTED questions (marks them unavailable).
app.patch("/api/questions/setDiscard", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      // If no IDs provided, return error
      return res.status(400).json({ error: "No IDs provided" });
    }
    // Mark selected questions as discarded today
    await pool.query("UPDATE questions SET discard=CURRENT_DATE WHERE id = ANY($1::int[])", [ids]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error setting discard:", err);
    res.status(500).json({ error: "Failed to set discard" });
  }
});

// Purpose: Clear discard date for ALL questions (make all available again).
app.patch("/api/questions/clearDiscardAll", async (_req, res) => {
  try {
    await pool.query("UPDATE questions SET discard=NULL");
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing all discards:", err);
    res.status(500).json({ error: "Failed to clear all discards" });
  }
});

// Purpose: Clear discard date for SELECTED questions.
app.patch("/api/questions/clearDiscardSome", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No IDs provided" });
    }
    await pool.query("UPDATE questions SET discard=NULL WHERE id = ANY($1::int[])", [ids]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing some discards:", err);
    res.status(500).json({ error: "Failed to clear discards" });
  }
});

// ---------------- Reset Data route ----------------
// ⚠️ Dangerous: clears entire tables. Only for admin use.
// Purpose: Controlled deletion of data from selected tables (no dynamic SQL).
app.delete("/api/admin/reset/:table", async (req, res) => {
  const { table } = req.params;

  // Map of allowed tables to their queries
  const resetQueries = {
    scores: "DELETE FROM scores",
    rooms: "DELETE FROM rooms",
    players: "DELETE FROM players",
    answers: "DELETE FROM answers",
  };

  const query = resetQueries[table];
  if (!query) {
    return res.status(400).json({ error: "Invalid table" });
  }

  try {
    await pool.query(query);
    res.json({ success: true });
  } catch (err) {
    console.error(`Error resetting table ${table}:`, err);
    res.status(500).json({ error: `Failed to reset ${table}` });
  }
});

// ---------------- Player Join API ----------------
// Purpose: Handle player join via HTTP before establishing a socket connection.
// Validates room status, inserts player if missing, prevents double-login,
// and returns a redirect URL for the player board.
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode, themeCode } = req.body;
  const rc = roomCode.toUpperCase();

  try {
    const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
    if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

    // Insert player if not already present (no theme stored in DB)
    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
      [name, rc]
    );

    // Lookup canonical player name (handles case sensitivity)
    const player = await pool.query(
      "SELECT name FROM players WHERE room_code=$1 AND LOWER(name)=LOWER($2)",
      [rc, name]
    );
    if (!player.rows.length) return res.status(500).json({ error: "Player lookup failed" });
    const canonicalName = player.rows[0].name;

    // Prevent duplicate login if player already active
    if (isPlayerActive(rc, canonicalName)) {
      return res.status(403).json({ error: "Player already logged somewhere." });
    }

    // Redirect player to their board, include themeCode from login textbox in URL
    res.json({
      success: true,
      redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(canonicalName)}&theme=${encodeURIComponent(themeCode || "")}`
    });
  } catch (err) {
    console.error("Error in player join:", err);
    res.status(500).json({ error: "Failed to join room" });
  }
});

/* ---------------- Socket Events ---------------- */
// Real-time game logic via Socket.IO
// Each "socket.on" handler responds to events sent by clients (players/admins).

io.on("connection", (socket) => {
  // When a player joins the lobby
  // Purpose: Register the socket to the room, ensure player exists in DB,
  // broadcast player list/scoreboard, and send current round info if active.
  socket.on("joinLobby", async ({ roomCode, name, themeCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      socket.data.name = name;                // Save player name on socket, only in memory
      socket.data.roomCode = rc;              // Save room code on socket, only in memory
      socket.data.themeCode = themeCode;      // Save theme code only in memory
      socket.join(rc);                        // Add socket to room group

      // Ensure player exists in DB
      await pool.query(
        "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
        [name, rc]
      );

      // Broadcast updated player list and scoreboard
      await emitPlayerList(rc);
      await emitScoreboard(rc);

      // If a round is already active, send current question to this player
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
      if (room.rows.length && room.rows[0].active_question_id) {
        const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [room.rows[0].active_question_id]);

        // Check if player already submitted an answer
        const ans = await pool.query(
          "SELECT answer FROM answers WHERE room_code=$1 AND LOWER(player_name)=LOWER($2) AND question_id=$3 AND round_number=$4",
          [rc, name, room.rows[0].active_question_id, room.rows[0].current_round]
        );

        const { activeCount, submittedActiveCount } = await getActiveStats(rc);

        // Send round info to this player
        socket.emit("roundStarted", {
          questionId: room.rows[0].active_question_id,
          prompt: q.rows[0].prompt,
          playerCount: activeCount,
          roundNumber: room.rows[0].current_round,
          myAnswer: ans.rows.length ? ans.rows[0].answer : null,
          theme: socket.data.themeCode || null
        });

        // Update submission progress for everyone
        io.to(rc).emit("submissionProgress", {
          submittedCount: submittedActiveCount,
          totalPlayers: activeCount
        });

        // If all active players submitted, notify everyone
        if (activeCount > 0 && submittedActiveCount === activeCount) {
          io.to(rc).emit("allSubmitted");
        }
      }
    } catch (err) {
      console.error("Error in joinLobby:", err);
    }
  });

  // Start a new round
  // Purpose: Select a question (respecting theme and discard rules), mark it discarded,
  // increment round, reset player submitted flags, and broadcast the round start.
  socket.on("startRound", async ({ roomCode, themeCode }) => {
    try {

      const rc = roomCode.toUpperCase();
      const theme = themeCode ? themeCode.toUpperCase() : null;
      
      let q;
      let effectiveTheme = theme;

      // If a theme is present, try to select a non-discarded question with that theme
      if (theme) {
        // Try theme-specific questions
        const countRes = await pool.query(
          "SELECT COUNT(*) FROM questions WHERE discard IS NULL AND theme=$1",
          [theme]
        );
        const count = parseInt(countRes.rows[0].count, 10);

        if (count > 0) {
          const offset = Math.floor(Math.random() * count);
          q = await pool.query(
            "SELECT id, prompt FROM questions WHERE discard IS NULL AND theme=$1 OFFSET $2 LIMIT 1",
            [theme, offset]
          );
        } else {
          effectiveTheme = null; // no theme questions available
        }
      }

      // Fallback: ANY non-discarded question (not just theme IS NULL)
      if (!q || q.rows.length === 0) {
        const countRes = await pool.query(
          "SELECT COUNT(*) FROM questions WHERE discard IS NULL"
        );
        const count = parseInt(countRes.rows[0].count, 10);

        if (count === 0) return; // no available questions at all

        const offset = Math.floor(Math.random() * count);
        q = await pool.query(
          "SELECT id, prompt FROM questions WHERE discard IS NULL OFFSET $1 LIMIT 1",
          [offset]
        );
        effectiveTheme = null;
      }

      if (q.rows.length === 0) return;

      const { id: qid, prompt } = q.rows[0];

      // Mark question as discarded (prevents re-use in same day, based on your schema)
      await pool.query("UPDATE questions SET discard = CURRENT_DATE WHERE id=$1", [qid]);

      // Increment round number and set active question; also raise popup flag
      await pool.query(
        "UPDATE rooms SET current_round=current_round+1, active_question_id=$1, popup_active=true WHERE code=$2",
        [qid, rc]
      );

      // Reset submitted flags for all players in the room
      await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);

      // Broadcast updated player list
      await emitPlayerList(rc);

      // Fetch updated round number and popup state
      const roundNum = (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round;
      const roomState = await pool.query("SELECT popup_active FROM rooms WHERE code=$1", [rc]);

      // Broadcast round start to all players
      io.to(rc).emit("roundStarted", {
        questionId: qid,
        prompt,
        playerCount: (await getActiveStats(rc)).activeCount,
        roundNumber: roundNum,
        myAnswer: null,
        popup: roomState.rows[0].popup_active,
        theme: effectiveTheme // null if no theme applied
      });
    } catch (err) {
      console.error("Error in startRound:", err);
    }
  });

  // Handle answer submission
  // Purpose: Save the player’s answer for the current round and mark them as submitted.
  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    try {
      const rc = roomCode.toUpperCase();
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);

      // Insert answer if not already present (one answer per player per round)
      await pool.query(
        "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [rc, name, questionId, room.rows[0].current_round, answer]
      );

      // Mark player as submitted (used to compute submission progress)
      await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND LOWER(name)=LOWER($2)", [rc, name]);

      // Update player list/progress for everyone
      await emitPlayerList(rc);
    } catch (err) {
      console.error("Error in submitAnswer:", err);
    }
  });

  // Reveal all answers
  // Purpose: Fetch all answers for the active question/round, emit them to clients,
  // and update the scoreboard (no points change here, just display).
  socket.on("showAnswers", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      // Get round + active question + prompt by joining questions
      const room = await pool.query(
        `SELECT r.current_round,
                r.active_question_id,
                q.prompt AS question_prompt
         FROM rooms r
         JOIN questions q
           ON r.active_question_id = q.id
         WHERE r.code = $1`,
        [rc]
      );
      
      const rr = await pool.query(
        `SELECT a.player_name AS name,
                a.answer,
                s.tag
         FROM answers a
         LEFT JOIN scores s
           ON a.room_code = s.room_code
          AND a.round_number = s.round_number
          AND LOWER(a.player_name) = LOWER(s.player_name)
         WHERE a.room_code=$1
           AND a.question_id=$2
           AND a.round_number=$3
         ORDER BY name ASC`,
        [rc, room.rows[0].active_question_id, room.rows[0].current_round]
      );

      // Step 1: Broadcast answers + round + question prompt
      io.to(rc).emit("answersRevealed", {
        rows: rr.rows,
        round: room.rows[0].current_round,
        questionPrompt: room.rows[0].question_prompt
      });
  
      // Step 2: Immediately broadcast scoreboard so all clients update
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in showAnswers:", err);
    }
  });

  // Award points to a player
  // Purpose: Insert or update a score row for a player for a specific round.
  socket.on("awardPoint", async ({ roomCode, playerName, roundNumber, points }) => {
    try {
      const rc = roomCode.toUpperCase();
      // Insert or update score for this player/round
      await pool.query(
        `INSERT INTO scores (room_code, player_name, round_number, points)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_code, LOWER(player_name), round_number)
         DO UPDATE SET points=$4`,
        [rc, playerName, roundNumber, points]
      );

      // Update player's quick total (optional convenience field)
      await pool.query(
        "UPDATE players SET score_total = score_total + $1, updated_at=NOW() WHERE room_code=$2 AND LOWER(name)=LOWER($3)",
        [points, rc, playerName]
      );

      // Broadcast updated scoreboard
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPoint:", err);
    }
  });

  // ---- Pivot awarding event ----
  // Purpose: Award +1 point to all players who submitted the selected answer
  // in the current round (bulk awarding for "pivot answers").
  socket.on("awardPivotPoints", async ({ roomCode, answer }) => {
    try {
      const rc = roomCode.toUpperCase();

      // Look up current round and active question
      const { rows: roomRows } = await pool.query(
        "SELECT current_round, active_question_id FROM rooms WHERE code=$1",
        [rc]
      );
      if (roomRows.length === 0) return;
      const roundNumber = roomRows[0].current_round;
      const questionId  = roomRows[0].active_question_id;

      // Find all players who submitted this answer
      const { rows: matching } = await pool.query(
        `SELECT player_name
           FROM answers
          WHERE room_code=$1
            AND question_id=$2
            AND round_number=$3
            AND answer=$4`,
        [rc, questionId, roundNumber, answer]
      );

      // Award +1 point to each matching player
      for (const row of matching) {
        await pool.query(
          `INSERT INTO scores (room_code, player_name, round_number, points)
           VALUES ($1,$2,$3,1)
           ON CONFLICT (room_code, LOWER(player_name), round_number)
           DO UPDATE SET points=1, updated_at=NOW()`,
          [rc, row.player_name, roundNumber]
        );
      }

      // Broadcast updated scoreboard to everyone in the room
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPivotPoints:", err);
    }
  });

  // ---- Unicorn assignment event ----
  // Purpose: Clear existing unicorn tags in the room and assign 🦄 to the
  // selected player's most recent round, then broadcast the updated scoreboard.
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

      // Step 2: Assign unicorn tag to the selected player (latest round)
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
  
  // Close room (mark as closed but keep round state intact)
  // Purpose: Disable new rounds/answers; notify all clients that room is closed.
  socket.on("closeRoom", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query("UPDATE rooms SET status='closed', active_question_id=NULL, updated_at=NOW() WHERE code=$1", [rc]);
      io.to(rc).emit("roomClosed");
    } catch (err) {
      console.error("Error in closeRoom:", err);
    }
  });

  // Handle player disconnect
  // Purpose: When a socket disconnects, update the player list for the room
  // so remaining players see an accurate active roster.
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
// Purpose: Boot the server. Uses environment PORT or defaults to 10000.
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Udderly the Same running on port " + PORT));
