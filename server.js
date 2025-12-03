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
// We want to show only the *latest round* where a player was assigned unicorn.
// Normalizes names
// Aggregates scores per player and joins to latest unicorn tag
async function getScoreboard(roomCode) {
  const { rows } = await pool.query(
    `SELECT MIN(p.player_name) AS player_name,   -- canonical spelling
            SUM(p.points) AS total,
            json_object_agg(p.round_number, p.points) AS rounds,
            COALESCE(u.tag, '') AS tag
     FROM scores p
     LEFT JOIN (
         -- Find the most recent unicorn tag per player (case-insensitive)
         SELECT s2.room_code,
                LOWER(s2.player_name) AS player_key,
                MAX(s2.round_number) AS latest_round,
                '🦄' AS tag
         FROM scores s2
         WHERE s2.tag = '🦄'
         GROUP BY s2.room_code, LOWER(s2.player_name)
     ) u
       ON u.room_code = p.room_code
      AND u.player_key = LOWER(p.player_name)
     WHERE p.room_code = $1
     GROUP BY LOWER(p.player_name), u.tag
     ORDER BY MIN(p.player_name) ASC`,
    [roomCode]
  );
  return rows;
}


/* Helper to build scoreboard data - old code
async function getScoreboard(roomCode) {
  const { rows } = await pool.query(
    `SELECT s.player_name,
            SUM(s.points) AS total,
            json_object_agg(s.round_number, s.points) AS rounds,
            (
              SELECT tag
              FROM scores
              WHERE room_code = $1
                AND LOWER(player_name)=LOWER(s.player_name)
                AND tag='🦄'
              ORDER BY round_number DESC
              LIMIT 1
            ) AS tag
     FROM scores s
     WHERE s.room_code = $1
     GROUP BY s.player_name`, 
    [roomCode]
  );
  return rows;
}
*/



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
app.get("/api/rooms", async (_req, res) => {
  const r = await pool.query("SELECT code, status, created_at, current_round FROM rooms ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/rooms", async (req, res) => {
  // ⚠️ Only use for brand new rooms; reopening should use PATCH
  const { code, status } = req.body;
  await pool.query("INSERT INTO rooms (code, status) VALUES ($1,$2)", [code.toUpperCase(), status || "open"]);
  res.json({ success: true });
});
app.patch("/api/rooms/:code", async (req, res) => {
  // ⚠️ Use this to reopen/update existing room without resetting current_round
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status,current_round", [status, code]);
  res.json(r.rows[0]);
});

// Question management (CRUD + discard)
app.get("/api/questions", async (_req, res) => {
  try {
    const r = await pool.query("SELECT id, prompt, discard FROM questions ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    console.error("Error fetching questions:", err);
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

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

// Set discard date for SELECTED questions (today's date)
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

// Clear discard date for ALL questions
app.patch("/api/questions/clearDiscardAll", async (_req, res) => {
  try {
    await pool.query("UPDATE questions SET discard=NULL");
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing all discards:", err);
    res.status(500).json({ error: "Failed to clear all discards" });
  }
});

// Clear discard date for SELECTED questions
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
/* Instead of interpolating the table name directly, you can map table names to prewritten queries. 
 This avoids dynamic SQL and makes your intent clearer:*/
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
// Called when a player joins a room via HTTP
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();

  try {
    // Check if room exists and is open
    const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
    if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

    // Insert player if not already present
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

    // Redirect player to their board
    res.json({
      success: true,
      redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(canonicalName)}`
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
  socket.on("joinLobby", async ({ roomCode, name }) => {
    try {
      const rc = roomCode.toUpperCase();
      socket.data.name = name;       // Save player name on socket
      socket.data.roomCode = rc;     // Save room code on socket
      socket.join(rc);               // Add socket to room group

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
          myAnswer: ans.rows.length ? ans.rows[0].answer : null
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
  socket.on("startRound", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      const qr = await pool.query("SELECT id FROM questions WHERE discard IS NULL ORDER BY id ASC");
      if (qr.rows.length === 0) return;

      // Pick random question
      const qid = qr.rows[Math.floor(Math.random() * qr.rows.length)].id;
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);

      // Mark question as discarded
      await pool.query("UPDATE questions SET discard = CURRENT_DATE WHERE id=$1", [qid]);

      // Increment round number and set active question
      await pool.query(
        "UPDATE rooms SET current_round=current_round+1, active_question_id=$1, popup_active=true WHERE code=$2",
        [qid, rc]
      );

      // Reset submitted flags
      await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);

      await emitPlayerList(rc);

      // Fetch updated round number
      const roundNum = (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round;
      const roomState = await pool.query("SELECT popup_active FROM rooms WHERE code=$1", [rc]);

      // Broadcast round start
      io.to(rc).emit("roundStarted", {
        questionId: qid,
        prompt: q.rows[0].prompt,
        playerCount: (await getActiveStats(rc)).activeCount,
        roundNumber: roundNum,
        myAnswer: null,
        popup: roomState.rows[0].popup_active
      });
    } catch (err) {
      console.error("Error in startRound:", err);
    }
  });

  // Handle answer submission
  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    try {
      const rc = roomCode.toUpperCase();
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);

      // Insert answer if not already present
      await pool.query(
        "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [rc, name, questionId, room.rows[0].current_round, answer]
      );

      // Mark player as submitted
      await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND LOWER(name)=LOWER($2)", [rc, name]);

      await emitPlayerList(rc);
    } catch (err) {
      console.error("Error in submitAnswer:", err);
    }
  });

  // Reveal all answers
  socket.on("showAnswers", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);

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

      io.to(rc).emit("answersRevealed", rr.rows);
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in showAnswers:", err);
    }
  });

  // Award points to a player
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
  
  // Close room (mark as closed but keep round state intact)
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












