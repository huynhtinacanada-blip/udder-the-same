// v1.1.0 release — Game Server
// -----------------------------------
// This file sets up the Express server, PostgreSQL tables, and Socket.IO game logic.
//  - Proper filtering of questions with discard IS NULL
//  - Unique index on answers to enforce one answer per player per round
//  - Consistent LOWER(name) normalization
//  - try/catch around DB calls to prevent crashes
//  - did not code for check by access direcltly from URL 


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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- Initialize Tables ----------------
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      current_round INT DEFAULT 0,
      active_question_id INT,
      popup_active BOOLEAN DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
	
	// if (!process.env.DEBUG) {
    // console.log("// **Debug Output: DB INIT -> rooms table created or already exists.");
	// }

    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      submitted BOOLEAN DEFAULT FALSE,
      has_unicorn BOOLEAN DEFAULT false, -- corrected from TINYINT
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
    // console.log("**Debug Output: DB INIT -> players table created or already exists.");

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS players_name_room_unique
      ON players (LOWER(name), room_code);`);
    // console.log("**Debug Output: DB INIT -> players unique index created or already exists.");

    await pool.query(`CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      discard DATE DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
    // console.log("**Debug Output: DB INIT -> questions table created or already exists.");

    await pool.query(`CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      round_number INT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
    // console.log("**Debug Output: DB INIT -> answers table created or already exists.");

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS answers_unique_per_round
      ON answers (room_code, LOWER(player_name), question_id, round_number);`);
    // console.log("**Debug Output: DB INIT -> answers unique index created or already exists.");

    await pool.query(`CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      round_number INT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      tag TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (room_code, player_name, round_number)
    );`);
    // console.log("**Debug Output: DB INIT -> scores table created or already exists.");

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scores_unique_per_round
      ON scores (room_code, LOWER(player_name), round_number);`);
    // console.log("**Debug Output: DB INIT -> scores unique index created or already exists.");
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
  // console.log("**Debug Output: DB READ -> players:", dbPlayers.rows);

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

// Function to build the scoreboard for a given room
async function getScoreboard(roomCode) {
  const r = await pool.query(
    `SELECT p.name AS player_name,
            COALESCE(SUM(s.points),0) AS total,
            COALESCE(json_object_agg(s.round_number, s.points) FILTER (WHERE s.points IS NOT NULL), '{}') AS rounds,
            MAX(s.tag) AS tag   -- NEW: include unicorn tag if present
     FROM players p
     LEFT JOIN scores s
       ON p.room_code = s.room_code
      AND LOWER(p.name) = LOWER(s.player_name)
     WHERE p.room_code=$1
     GROUP BY p.name
     ORDER BY p.name`,
    [roomCode]
  );
  return r.rows;
}


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

async function emitScoreboard(roomCode) {
  const scoreboard = await getScoreboard(roomCode);
  io.to(roomCode).emit("scoreboardUpdated", scoreboard);
}

function isPlayerActive(roomCode, playerName) {
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name && s.data.name.toLowerCase() === playerName.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// ---------------- Admin Login API ----------------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  // console.log("**Debug Output: ADMIN LOGIN attempt:", { username, password });
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

// ---------------- Room Management APIs ----------------
app.get("/api/rooms", async (_req, res) => {
  const r = await pool.query("SELECT code, status, created_at FROM rooms ORDER BY id DESC");
  // console.log("**Debug Output: DB READ -> rooms:", r.rows);
  res.json(r.rows);
});

app.post("/api/rooms", async (req, res) => {
  const { code, status } = req.body;
  await pool.query("INSERT INTO rooms (code, status) VALUES ($1,$2)", [code.toUpperCase(), status || "open"]);
  // console.log("**Debug Output: DB WRITE -> rooms:", { code: code.toUpperCase(), status: status || "open" });
  res.json({ success: true });
});

app.patch("/api/rooms/:code", async (req, res) => {
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status", [status, code]);
  // console.log("**Debug Output: DB WRITE -> rooms update:", r.rows);
  res.json(r.rows[0]);
});

// ---------------- Question Management APIs ----------------
app.get("/api/questions", async (_req, res) => {
  const r = await pool.query("SELECT id, prompt, discard FROM questions ORDER BY id DESC");
  // console.log("**Debug Output: DB READ -> questions:", r.rows);
  res.json(r.rows);
});

app.post("/api/questions", async (req, res) => {
  const { text } = req.body;
  const r = await pool.query("INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt", [text.trim()]);
  // console.log("**Debug Output: DB WRITE -> questions:", r.rows[0]);
  res.json(r.rows[0]);
});

app.put("/api/questions/:id", async (req, res) => {
  const { text } = req.body;
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("UPDATE questions SET prompt=$1 WHERE id=$2 RETURNING id, prompt, discard", [text.trim(), id]);
  // console.log("**Debug Output: DB WRITE -> questions update:", r.rows[0]);
  res.json(r.rows[0]);
});

app.delete("/api/questions/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("DELETE FROM questions WHERE id=$1 RETURNING id", [id]);
  // console.log("**Debug Output: DB DELETE -> questions:", r.rows);
  res.json({ success: true });
});


// ---------------- Clear Discard APIs ----------------

// Clear discard for ALL questions
app.patch("/api/questions/clearDiscardAll", async (_req, res) => {
  try {
    await pool.query("UPDATE questions SET discard=NULL");
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing all discards:", err);
    res.status(500).json({ error: "Failed to clear all discards" });
  }
});

// Clear discard for SELECTED questions
app.patch("/api/questions/clearDiscardSome", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No IDs provided" });
    }
    await pool.query("UPDATE questions SET discard=NULL WHERE id = ANY($1::int[])", [ids]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error clearing selected discards:", err);
    res.status(500).json({ error: "Failed to clear selected discards" });
  }
});


// ---------------- Player Join API ----------------
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();

  try {
    const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
    // console.log("**Debug Output: DB READ -> rooms join:", room.rows);

    if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
      [name, rc]
    );
    // console.log("**Debug Output: DB WRITE -> players join:", { name, room_code: rc });

    const player = await pool.query(
      "SELECT name FROM players WHERE room_code=$1 AND LOWER(name)=LOWER($2)",
      [rc, name]
    );
    // console.log("**Debug Output: DB READ -> players lookup:", player.rows);

    if (!player.rows.length) return res.status(500).json({ error: "Player lookup failed" });
    const canonicalName = player.rows[0].name;

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
  socket.on("joinLobby", async ({ roomCode, name }) => {
    try {
      const rc = roomCode.toUpperCase();
      socket.data.name = name;
      socket.data.roomCode = rc;
      socket.join(rc);

      await pool.query(
        "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
        [name, rc]
      );
      // console.log("**Debug Output: DB WRITE -> players joinLobby:", { name, room_code: rc });

      await emitPlayerList(rc);
      await emitScoreboard(rc);

      const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
      // console.log("**Debug Output: DB READ -> rooms joinLobby:", room.rows);

      if (room.rows.length && room.rows[0].active_question_id) {
        const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [room.rows[0].active_question_id]);
        // console.log("**Debug Output: DB READ -> questions active:", q.rows[0]);

        const ans = await pool.query(
          "SELECT answer FROM answers WHERE room_code=$1 AND LOWER(player_name)=LOWER($2) AND question_id=$3 AND round_number=$4",
          [rc, name, room.rows[0].active_question_id, room.rows[0].current_round]
        );
        // console.log("**Debug Output: DB READ -> answers existing:", ans.rows);

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

// Assign unicorn
socket.on("assignUnicorn", async ({ roomCode, playerName, roundNumber }) => {
  // Reset unicorn flag in players table
  await pool.query("UPDATE players SET has_unicorn=false WHERE room_code=$1", [roomCode]);
  await pool.query("UPDATE players SET has_unicorn=true WHERE room_code=$1 AND name=$2", [roomCode, playerName]);

  // Reset unicorn tag for this round in scores
  await pool.query(
    "UPDATE scores SET tag=NULL WHERE room_code=$1 AND round_number=$2",
    [roomCode, roundNumber]
  );

  // Assign unicorn to selected player
  await pool.query(
    "UPDATE scores SET tag='🦄' WHERE room_code=$1 AND round_number=$2 AND LOWER(player_name)=LOWER($3)",
    [roomCode, roundNumber, playerName]
  );

  // Broadcast updated scoreboard
  const scoreboard = await getScoreboard(roomCode);
  io.to(roomCode).emit("scoreboardUpdated", scoreboard);

  // Broadcast updated answers list with tag
  const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [roomCode]);
  if (room.rows.length) {
    const answers = await pool.query(
      `SELECT a.player_name AS name, a.answer, s.tag
       FROM answers a
       LEFT JOIN scores s
         ON a.room_code=s.room_code
        AND a.round_number=s.round_number
        AND LOWER(a.player_name)=LOWER(s.player_name)
       WHERE a.room_code=$1 AND a.question_id=$2 AND a.round_number=$3
       ORDER BY name ASC`,
      [roomCode, room.rows[0].active_question_id, room.rows[0].current_round]
    );
    io.to(roomCode).emit("answersRevealed", answers.rows);
  }
});


  // Start a new round
  socket.on("startRound", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      const qr = await pool.query("SELECT id FROM questions WHERE discard IS NULL ORDER BY id ASC");
      // console.log("**Debug Output: DB READ -> questions available:", qr.rows);

      if (qr.rows.length === 0) return;
      const qid = qr.rows[Math.floor(Math.random() * qr.rows.length)].id;
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);
      // console.log("**Debug Output: DB READ -> question chosen:", q.rows[0]);

	    //  Mark this question as discarded with today's date
	    await pool.query(
	      "UPDATE questions SET discard = CURRENT_DATE WHERE id=$1",
	      [qid]
	    );
// console.log(`**Debug Output: DB WRITE -> questions discard: id=${qid}, date=${discardResult.rows[0].discard}`);

		
      await pool.query(
        "UPDATE rooms SET current_round=current_round+1, active_question_id=$1, popup_active=true WHERE code=$2",
        [qid, rc]
      );
      // console.log("**Debug Output: DB WRITE -> rooms startRound:", { room_code: rc, active_question_id: qid });

      await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);
      // console.log("**Debug Output: DB WRITE -> players reset submitted:", { room_code: rc });

      await emitPlayerList(rc);
      const roundNum = (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round;
      // console.log("**Debug Output: DB READ -> rooms current_round:", roundNum);

      const roomState = await pool.query("SELECT popup_active FROM rooms WHERE code=$1", [rc]);
      // console.log("**Debug Output: DB READ -> rooms popup_active:", roomState.rows[0]);

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
      // console.log("**Debug Output: DB READ -> rooms submitAnswer:", room.rows[0]);

      await pool.query(
        "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [rc, name, questionId, room.rows[0].current_round, answer]
      );
      // console.log("**Debug Output: DB WRITE -> answers:", { room_code: rc, player_name: name, question_id: questionId, round_number: room.rows[0].current_round, answer });

      await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND LOWER(name)=LOWER($2)", [rc, name]);
      // console.log("**Debug Output: DB WRITE -> players submitted flag:", { room_code: rc, player_name: name });

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
      // console.log("**Debug Output: DB READ -> rooms showAnswers:", room.rows[0]);

		// JOIN because the unicorn 🦄 lives in the scores table, not the answers table. 
		// Without joining, the front‑end would never know who has the unicorn when showing answers.
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

		
      // console.log("**Debug Output: DB READ -> answers showAnswers:", rr.rows);

      io.to(rc).emit("answersRevealed", rr.rows);
      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in showAnswers:", err);
    }
  });

  // Award points
  socket.on("awardPoint", async ({ roomCode, playerName, roundNumber, points }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query(
        `INSERT INTO scores (room_code, player_name, round_number, points)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_code, LOWER(player_name), round_number)
         DO UPDATE SET points=$4`,
        [rc, playerName, roundNumber, points]
      );
      // console.log("**Debug Output: DB WRITE -> scores awardPoint:", { room_code: rc, player_name: playerName, round_number: roundNumber, points });

      await emitScoreboard(rc);
    } catch (err) {
      console.error("Error in awardPoint:", err);
    }
  });

  // Close room
  socket.on("closeRoom", async ({ roomCode }) => {
    try {
      const rc = roomCode.toUpperCase();
      await pool.query("UPDATE rooms SET status='closed', active_question_id=NULL WHERE code=$1", [rc]);
      // console.log("**Debug Output: DB WRITE -> rooms closeRoom:", { room_code: rc, status: "closed" });

      io.to(rc).emit("roomClosed");
    //  console.log(`Room ${rc} closed by ${socket.data.name}`);
	// console.log(`**Debug Output: DB WRITE -> Room ${rc} closed by ${socket.data.name}`);

    } catch (err) {
      console.error("Error in closeRoom:", err);
    }
  });

  // Disconnect
  socket.on("disconnect", async () => {
    try {
      const r = socket.data?.roomCode;
      if (r) {
        await emitPlayerList(r);
     //   console.log("**Debug Output: SOCKET DISCONNECT ->", { room_code: r, player_name: socket.data?.name });
      }
    } catch (err) {
      console.error("Error in disconnect:", err);
    }
  });
}); // <-- closes io.on("connection")

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Udderly the Same running on port " + PORT));


