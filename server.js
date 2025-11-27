// v1.0.1a — Game Server
// -----------------------------------
// This file sets up the Express server, PostgreSQL tables, and Socket.IO game logic.
//  - Proper filtering of questions with discard IS NULL
//  - Unique index on answers to enforce one answer per player per round
//  - Consistent LOWER(name) normalization
//  - try/catch around DB calls to prevent crashes
//  - no check on URL

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- Database Connection ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- Initialize Tables ----------------
(async () => {
  try {
    // Rooms table
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      current_round INT DEFAULT 0,
      active_question_id INT,
	  popup_active BOOLEAN DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);

    // Players table
    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      submitted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS players_name_room_unique
      ON players (LOWER(name), room_code);`);

    // Questions table
    await pool.query(`CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      discard DATE DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);

    // Answers table
    await pool.query(`CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      round_number INT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
    
    // Enforce uniqueness per player/round/question/room
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS answers_unique_per_round
      ON answers (room_code, LOWER(player_name), question_id, round_number);`);

    // Scores table
    await pool.query(`CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      round_number INT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (room_code, player_name, round_number)
    );`);


    // Add functional unique index separately
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scores_unique_per_round
      ON scores (room_code, LOWER(player_name), round_number);`);
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();



// ---------------- Helpers ----------------
function getActiveNames(roomCode) {
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  const activeNames = [];
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name) {
      activeNames.push(s.data.name);
    }
  }
  return activeNames;
}

async function getActiveStats(roomCode) {
  const dbPlayers = await pool.query("SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC", [roomCode]);
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


// ---------------- Helpers ----------------
async function getScoreboard(roomCode) {
  // Run a SQL query to build the scoreboard for a given room
  const r = await pool.query(
    `SELECT 
        p.name AS player_name,                          -- Select each player's name from the players table
        COALESCE(SUM(s.points),0) AS total,             -- Sum all points for that player, default to 0 if none
        COALESCE(
          json_object_agg(s.round_number, s.points)     -- Build a JSON object mapping round_number -> points
          FILTER (WHERE s.points IS NOT NULL), 
          '{}'                                          -- If no scores exist, return an empty JSON object
        ) AS rounds
     FROM players p
     LEFT JOIN scores s
       ON p.room_code = s.room_code                     -- Match scores to players in the same room
      AND LOWER(p.name) = LOWER(s.player_name)          -- Case-insensitive match on player name
     WHERE p.room_code=$1                               -- Only include players from the requested room
     GROUP BY p.name                                    -- Group results by player name (one row per player)
     ORDER BY p.name`,                                  
    [roomCode]                                          // Bind the roomCode parameter to the query
  );

  // Example return format:
  // [
  //   { player_name: "Alice", total: 0, rounds: {} },
  //   { player_name: "Bob", total: 5, rounds: {"1":5} }
  // ]
  return r.rows;
}


async function emitPlayerList(roomCode) {
  const { merged, activeCount, submittedActiveCount } = await getActiveStats(roomCode);
  io.to(roomCode).emit("playerList", {
    players: merged,
    activeCount,
    submittedCount: submittedActiveCount
  });
  // Keep progress synced on join/leave/submit
  io.to(roomCode).emit("submissionProgress", {
    submittedCount: submittedActiveCount,
    totalPlayers: activeCount
  });
}

async function emitScoreboard(roomCode) {
  const scoreboard = await getScoreboard(roomCode);
  io.to(roomCode).emit("scoreboardUpdated", scoreboard);
}

// Enforcing “only one active session per player name per room” in real time.
// You don’t need to make isPlayerActive an async function — because it doesn’t touch the database, it only checks the current Socket.IO connections in memory.
// Cons: server restarts, memory is wiped.
// Pros: Very fast — no extra database queries; Automatically clears when a player disconnects.
// For a small game project or single server: memory (Socket.IO) is simpler and sufficient.
// Optional hybrid implementation (Socket.IO + DB flag)
function isPlayerActive(roomCode, playerName) {
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name && s.data.name.toLowerCase() === playerName.toLowerCase()) {
      return true; // player already connected
    }
  }
  return false;
}


// ---------------- Admin Login API ----------------
// Define an Express POST route for admin login
app.post("/api/admin/login", (req, res) => {
  // Extract username and password from the request body (sent by the login form)
  const { username, password } = req.body;

  // Load admin credentials from environment variables (never hard‑code secrets!)
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;

  // If credentials are not set in the environment, return a server error
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(500).json({ error: "Admin credentials not configured" });
  }

  // Check if the provided username and password match the configured admin credentials
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    // If they match, return a success response with a redirect path
    return res.json({ success: true, redirect: "/admin-dashboard.html" });
  }

  // If credentials don’t match, return an unauthorized error
  res.status(401).json({ error: "Invalid credentials" });
});


// ---------------- Room Management APIs ----------------
app.get("/api/rooms", async (_req, res) => {
  try {
    const r = await pool.query("SELECT code, status, created_at FROM rooms ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch rooms" });
  }
});

app.post("/api/rooms", async (req, res) => {
  const { code, status } = req.body;
  if (!code) return res.status(400).json({ error: "Room code required" });
  try {
    await pool.query("INSERT INTO rooms (code, status) VALUES ($1,$2)", [code.toUpperCase(), status || "open"]);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "Room already exists" });
  }
});

app.patch("/api/rooms/:code", async (req, res) => {
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  try {
    const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status", [status, code]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Room not found" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update room" });
  }
});

// ---------------- Question Management APIs ----------------
app.get("/api/questions", async (_req, res) => {
  try {
    const r = await pool.query("SELECT id, prompt, discard FROM questions ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

app.post("/api/questions", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Prompt required" });
  try {
    const r = await pool.query("INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt", [text.trim()]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to add question" });
  }
});

app.put("/api/questions/:id", async (req, res) => {
  const { text } = req.body;
  const id = parseInt(req.params.id, 10);
  if (!text) return res.status(400).json({ error: "Prompt required" });
  try {
    const r = await pool.query("UPDATE questions SET prompt=$1 WHERE id=$2 RETURNING id, prompt, discard", [text.trim(), id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Question not found" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update question" });
  }
});

app.delete("/api/questions/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query("DELETE FROM questions WHERE id=$1 RETURNING id", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Question not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete question" });
  }
});

// ---------------- Player Join API ----------------
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();

  try {
    const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
    if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

    // Insert if not exists
    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
      [name, rc]
    );

    // Fetch canonical name
    const player = await pool.query(
      "SELECT name FROM players WHERE room_code=$1 AND LOWER(name)=LOWER($2)",
      [rc, name]
    );
    if (!player.rows.length) return res.status(500).json({ error: "Player lookup failed" });
    const canonicalName = player.rows[0].name;

    // Check if player is already active in this room
    if (isPlayerActive(rc, canonicalName)) {
      return res.status(403).json({ error: "Player already logged somewhere." });
    }

    res.json({
      success: true,
      redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(canonicalName)}`
    });
  } catch (err) {
    console.error("Error in player join:", err);
    res.status(500).json({ error: "Failed to join room" });
  }
});



// ---------------- Socket.IO Game Logic ----------------
io.on("connection", (socket) => {
  // Handle lobby join
  socket.on("joinLobby", async ({ roomCode, name }) => {
    try {
      const rc = roomCode.toUpperCase();
      socket.data.name = name;
      socket.data.roomCode = rc;
      socket.join(rc);

      // Ensure player exists in DB (case-insensitive uniqueness)
      await pool.query(
        "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
        [name, rc]
      );

      // Emit updated player list and scoreboard
      await emitPlayerList(rc);
      await emitScoreboard(rc);

      // If a round is already active, send the current question and progress to this player
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
      if (room.rows.length && room.rows[0].active_question_id) {
        const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [room.rows[0].active_question_id]);
        const ans = await pool.query(
          "SELECT answer FROM answers WHERE room_code=$1 AND LOWER(player_name)=LOWER($2) AND question_id=$3 AND round_number=$4",
          [rc, name, room.rows[0].active_question_id, room.rows[0].current_round]
        );
        const { activeCount, submittedActiveCount } = await getActiveStats(rc);

        socket.emit("roundStarted", {
          questionId: room.rows[0].active_question_id,
          prompt: q.rows[0].prompt,
          playerCount: activeCount,
          roundNumber: room.rows[0].current_round,
          myAnswer: ans.rows.length ? ans.rows[0].answer : null
        });

        io.to(rc).emit("submissionProgress", {
          submittedCount: submittedActiveCount,
          totalPlayers: activeCount
        });

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
		
      // Only select questions that are not discarded
      const qr = await pool.query("SELECT id FROM questions WHERE discard IS NULL ORDER BY id ASC");
      if (qr.rows.length === 0) return;

      // Pick a random question
      const qid = qr.rows[Math.floor(Math.random() * qr.rows.length)].id;
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);

    // Update room state: increment round, set active question, and mark popup_active=true
    await pool.query(
      "UPDATE rooms SET current_round = current_round+1, active_question_id=$1, popup_active=true WHERE code=$2",
      [qid, rc]
    );
		
      // Reset player submissions		
   await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);
		
      await emitPlayerList(rc);
      const roundNum = (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round;
      const { activeCount } = await getActiveStats(rc);

	// Read popup_active from DB instead of hard‑coding
    const roomState = await pool.query("SELECT popup_active FROM rooms WHERE code=$1", [rc]);
		
      io.to(rc).emit("roundStarted", {
        questionId: qid,
        prompt: q.rows[0].prompt,
        playerCount: activeCount,
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
      if (!room.rows.length || room.rows[0].active_question_id !== questionId) return;

      // Insert answer (unique per player/round enforced by index)
      await pool.query(
        "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [rc, name, questionId, room.rows[0].current_round, answer]
      );

      // Mark player as submitted
      await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND LOWER(name)=LOWER($2)", [rc, name]);

      await emitPlayerList(rc);

      const { activeCount, submittedActiveCount } = await getActiveStats(rc);
      io.to(rc).emit("submissionProgress", {
        submittedCount: submittedActiveCount,
        totalPlayers: activeCount
      });

      // If all active players submitted, notify
      if (activeCount > 0 && submittedActiveCount === activeCount) {
        io.to(rc).emit("allSubmitted");
      }
    } catch (err) {
      console.error("Error in submitAnswer:", err);
    }
  });

  // Reveal all answers for the round
  socket.on("showAnswers", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
      if (!room.rows.length || !room.rows[0].active_question_id) return;

      const rr = await pool.query(
        "SELECT player_name AS name, answer FROM answers WHERE room_code=$1 AND question_id=$2 AND round_number=$3 ORDER BY name ASC",
        [rc, room.rows[0].active_question_id, room.rows[0].current_round]
      );
      io.to(rc).emit("answersRevealed", rr.rows);

      // Emit latest scoreboard so UI reflects points
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in showAnswers:", err);
    }
  });

  // Award points to a player for a round
  socket.on("awardPoint", async ({ roomCode, playerName, roundNumber, points }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query(
        `INSERT INTO scores (room_code, player_name, round_number, points)
         VALUES ($1, LOWER($2), $3, $4)
         ON CONFLICT (room_code, LOWER(player_name), round_number)
         DO UPDATE SET points=$4`,
        [rc, playerName, roundNumber, points]
      );
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPoint:", err);
    }
  });


	// Close a room (End Game)
	socket.on("closeRoom", async ({ roomCode }) => {
	  try {
		const rc = roomCode.toUpperCase();

		// Mark the room as closed in DB
		await pool.query(
		  "UPDATE rooms SET status='closed', active_question_id=NULL WHERE code=$1",
		  [rc]
		);

		// Broadcast to all players in this room
		io.to(rc).emit("roomClosed");

		console.log(`Room ${rc} closed by ${socket.data.name}`);
	  } catch (err) {
		console.error("Error in closeRoom:", err);
	  }
	});


  // Handle disconnect
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

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Udderly the Same running on port " + PORT));

