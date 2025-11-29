// ==========================
//  CRICKET AUCTION SERVER (FINAL POLISHED)
// ==========================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

// --- RULES ---
const MAX_SQUAD_SIZE = 25;       
const MIN_SQUAD_TO_PLAY = 18;    // UPDATED: Min 18 players required
const PLAYING_11_SIZE = 11;      
const MAX_OVERSEAS_SQUAD = 8;
const MAX_OVERSEAS_P11 = 4;

// --- RATING CALCULATOR ---
function calculateWeightedRating(role, bat, bowl, field) {
    let rating = 0;
    const b = parseInt(bat) || 0;
    const bo = parseInt(bowl) || 0;
    const f = parseInt(field) || 0;

    if (role === "Batsman" || role === "WK") rating = (b * 0.75) + (f * 0.20) + (bo * 0.05);
    else if (role === "Bowler") rating = (bo * 0.75) + (f * 0.20) + (b * 0.05);
    else if (role === "All-Rounder") rating = (b * 0.40) + (bo * 0.40) + (f * 0.20);
    else if (role === "Wicketkeeper") rating = (b * 0.50) + (f * 0.50);
    else rating = (b + bo + f) / 3; 
    return Math.round(rating);
}

// --- LOAD DATABASE (PURE JSON) ---
function loadPlayerDatabase() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, "players.json"), "utf-8");
    const players = JSON.parse(rawData);
    
    // Validate and Calculate Ratings
    return players.map(p => {
        const weightedRating = calculateWeightedRating(p.role, p.bat, p.bowl, p.field);
        return {
            ...p,
            country: p.country || "India",   
            status: p.status || "Uncapped",  
            rating: weightedRating,          
            basePrice: p.basePrice || 0.2,
            img: p.img || "https://cdn-icons-png.flaticon.com/512/166/166344.png"
        };
    });
  } catch (error) {
    console.error("CRITICAL: players.json not found or invalid!", error.message);
    return []; 
  }
}

// --- SHUFFLE ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- GLOBAL GAME LOGIC ---

function checkEliminations(room) {
    if(!room || !room.teams) return;
    Object.values(room.teams).forEach(team => {
        // Eliminated if purse is 0 (or less) AND they haven't reached the minimum squad size yet
        if (team.purse <= 0 && team.squad.length < MIN_SQUAD_TO_PLAY) {
            team.isEliminated = true;
        }
    });
}

function endAuctionPhase(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    room.auction.phase = "SELECTION";
    io.to(roomId).emit("start-selection-phase");
}

function checkAuctionCompletion(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const teams = Object.values(room.teams);
    
    // Active bidders are those not eliminated, not finished, and have space in squad
    const activeBidders = teams.filter(t => !t.isEliminated && !t.isFinishedBidding && t.squad.length < MAX_SQUAD_SIZE);
    
    if (activeBidders.length === 0) {
        if(room.auction.timer) clearInterval(room.auction.timer);
        endAuctionPhase(roomId);
    }
}

function calculateWinner(roomId) {
    const room = rooms[roomId];
    room.auction.phase = "RESULT";
    const teams = Object.values(room.teams).filter(t => !t.isEliminated);
    teams.sort((a, b) => b.totalScore - a.totalScore);
    io.to(roomId).emit("game-over-results", { winner: teams[0], rankings: teams });
}

function emitResults(roomId) {
    const room = rooms[roomId];
    if(room && room.auction.phase === "RESULT") {
      const teams = Object.values(room.teams).filter(t => !t.isEliminated);
      teams.sort((a, b) => b.totalScore - a.totalScore);
      io.to(roomId).emit("game-over-results", { winner: teams[0], rankings: teams });
    }
}

function removePlayerFromRoom(socketId, roomId) {
    const room = rooms[roomId];
    if (!room || !room.teams[socketId]) return;

    delete room.teams[socketId];

    if (room.hostId === socketId) {
        const remainingIds = Object.keys(room.teams);
        if (remainingIds.length > 0) room.hostId = remainingIds[0];
        else { delete rooms[roomId]; return; }
    }

    io.to(roomId).emit("teams-updated", Object.values(room.teams));
    checkAuctionCompletion(roomId);

    if (room.auction && room.auction.currentBidderId === socketId) {
        room.auction.currentBidderId = null;
        room.auction.currentBid = room.auction.playerPool[room.auction.currentPlayerIndex].basePrice;
        io.to(roomId).emit("bid-updated", { currentBid: room.auction.currentBid, bidderId: null, bidderName: null });
    }
}

// --- SOCKET CONNECTION ---
io.on("connection", (socket) => {

  socket.on("create-room", ({ teamName, purse }) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const hostPurse = parseFloat(purse) || 100;

    let initialPool = loadPlayerDatabase();
    if(initialPool.length === 0) {
        initialPool = [{ id: "0", name: "Error: No Players", role: "N/A", bat:0, bowl:0, field:0, rating:0, basePrice:0, country:"India", status:"Uncapped", img:"" }];
    } else {
        initialPool = shuffleArray(initialPool);
    }

    rooms[roomId] = {
      hostId: socket.id,
      config: { startingPurse: hostPurse }, 
      teams: {
        [socket.id]: { id: socket.id, name: teamName, purse: hostPurse, squad: [], isEliminated: false, isFinishedBidding: false, submitted11: false, totalScore: 0 }
      },
      auction: {
        playerPool: initialPool, 
        currentPlayerIndex: 0,
        currentBid: 0,
        currentBidderId: null,
        biddingOpen: false,
        phase: "LOBBY",
        skippedBy: []
      }
    };

    socket.join(roomId);
    socket.emit("room-created", { roomId, team: rooms[roomId].teams[socket.id], isHost: true });
    io.to(roomId).emit("teams-updated", Object.values(rooms[roomId].teams));
  });

  socket.on("join-room", ({ roomId, teamName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error-message", "Room not found");

    if (!room.teams[socket.id]) {
      room.teams[socket.id] = { id: socket.id, name: teamName, purse: room.config.startingPurse, squad: [], isEliminated: false, isFinishedBidding: false, submitted11: false, totalScore: 0 };
    }

    socket.join(roomId);
    socket.emit("joined-room", { roomId, team: room.teams[socket.id], isHost: (socket.id === room.hostId) });
    
    if(room.auction.phase === "SELECTION") socket.emit("start-selection-phase");
    else if (room.auction.phase === "RESULT") emitResults(roomId);
    else if (room.auction.biddingOpen) {
        const player = room.auction.playerPool[room.auction.currentPlayerIndex];
        socket.emit("new-player", { player, currentBid: room.auction.currentBid });
    }

    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
  });

  socket.on("leave-room", ({ roomId }) => {
    if(roomId && rooms[roomId]) {
        removePlayerFromRoom(socket.id, roomId);
        socket.leave(roomId);
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      if (rooms[roomId].teams[socket.id]) {
        removePlayerFromRoom(socket.id, roomId);
        break; 
      }
    }
  });

  socket.on("finish-bidding-for-me", ({ roomId }) => {
      const room = rooms[roomId];
      if(!room) return;
      const team = room.teams[socket.id];
      // Updated Check: Must have at least MIN_SQUAD_TO_PLAY (18)
      if(team && team.squad.length >= MIN_SQUAD_TO_PLAY) {
          team.isFinishedBidding = true;
          io.to(roomId).emit("teams-updated", Object.values(room.teams));
          checkAuctionCompletion(roomId);
      }
  });

  socket.on("start-auction", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    if (room.auction.phase !== "LOBBY") return;

    room.auction.phase = "AUCTION";
    io.to(roomId).emit("auction-started-signal");
    startNextPlayer(roomId);
  });

  function startAuctionTimer(roomId) {
    const room = rooms[roomId];
    if (!room || !room.auction) return;
    const auction = room.auction;
    auction.timeLeft = 10; 
    if (auction.timer) clearInterval(auction.timer);
    auction.timer = setInterval(() => {
      auction.timeLeft--;
      io.to(roomId).emit("timer-update", auction.timeLeft);
      if (auction.timeLeft <= 0) {
        clearInterval(auction.timer);
        if (auction.currentBidderId) finishBidding(roomId);
        else finishPlayerUnsold(roomId);
      }
    }, 1000);
  }

  function startNextPlayer(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    const auction = room.auction;
    if (auction.currentPlayerIndex >= auction.playerPool.length) {
      endAuctionPhase(roomId);
      return;
    }
    const player = auction.playerPool[auction.currentPlayerIndex];
    auction.currentBid = player.basePrice;
    auction.currentBidderId = null;
    auction.skippedBy = [];
    auction.biddingOpen = true;
    io.to(roomId).emit("new-player", { player, currentBid: auction.currentBid });
    startAuctionTimer(roomId);
  }

  socket.on("place-bid", ({ roomId, bidAmount }) => {
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    const auction = room.auction;
    const team = room.teams[socket.id];
    
    if (!team || team.isEliminated || team.isFinishedBidding) return;
    if (team.squad.length >= MAX_SQUAD_SIZE) return;
    if (bidAmount > team.purse) return;
    if (bidAmount <= auction.currentBid) return;

    // RULE: Max 8 Overseas in Squad
    const player = auction.playerPool[auction.currentPlayerIndex];
    if (player.country === "Overseas") {
        const overseasCount = team.squad.filter(p => p.country === "Overseas").length;
        if (overseasCount >= MAX_OVERSEAS_SQUAD) return; 
    }

    auction.currentBid = parseFloat(bidAmount);
    auction.currentBidderId = socket.id;
    io.to(roomId).emit("bid-updated", { currentBid: auction.currentBid, bidderId: socket.id, bidderName: team.name });
    startAuctionTimer(roomId);
  });

  socket.on("skip-for-me", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    const auction = room.auction;

    // Add user to skip list if not already there
    if (!auction.skippedBy.includes(socket.id)) auction.skippedBy.push(socket.id);

    // Calculate how many active bidders are left in the room
    const teams = Object.values(room.teams);
    const activeBidders = teams.filter(t => !t.isEliminated && !t.isFinishedBidding && t.squad.length < MAX_SQUAD_SIZE);
    
    // If there is a current bidder, they can't skip, so we don't count them
    const requiredSkips = auction.currentBidderId ? (activeBidders.length - 1) : activeBidders.length;

    // If enough people skipped, end the round
    if (auction.skippedBy.length >= requiredSkips) {
        clearInterval(auction.timer);
        if (auction.currentBidderId) finishBidding(roomId);
        else finishPlayerUnsold(roomId);
    }
  });

  function finishBidding(roomId) {
    const room = rooms[roomId];
    if (!room) return; // <--- ADD THIS SAFETY CHECK

    const auction = room.auction;
    auction.biddingOpen = false;
    const player = auction.playerPool[auction.currentPlayerIndex];
    const team = room.teams[auction.currentBidderId];
    
    const finalPrice = parseFloat(auction.currentBid);
    team.purse = parseFloat((team.purse - finalPrice).toFixed(2));
    const soldPlayer = { ...player, soldPrice: finalPrice };
    team.squad.push(soldPlayer);

    checkEliminations(room);
    io.to(roomId).emit("player-sold", { player, price: auction.currentBid, teamName: team.name, eliminated: team.isEliminated });
    checkAuctionCompletion(roomId);
    prepareNext(roomId);
  }
  
  function finishPlayerUnsold(roomId) {
    const room = rooms[roomId];
    if (!room) return; // <--- ADD THIS SAFETY CHECK

    room.auction.biddingOpen = false;
    const player = room.auction.playerPool[room.auction.currentPlayerIndex];
    io.to(roomId).emit("player-unsold", { player });
    prepareNext(roomId);
  }

  function prepareNext(roomId) {
    const room = rooms[roomId];
    if(room.auction.phase !== "AUCTION") return;
    room.auction.currentPlayerIndex++;
    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
    setTimeout(() => { startNextPlayer(roomId); }, 3000);
  }

  socket.on("submit-playing-11", ({ roomId, playerIds, cId, vcId }) => {
      const room = rooms[roomId];
      if(!room) return;
      const team = room.teams[socket.id];
      // Validation: Playing 11 should be 11, or squad size if less than 11 (though min squad is 18 now)
      const requiredSelection = Math.min(PLAYING_11_SIZE, team.squad.length);
      
      if(!team || playerIds.length !== requiredSelection) return;
      if(!playerIds.includes(cId) || !playerIds.includes(vcId)) return;
      if(cId === vcId) return;

      const selectedPlayers = team.squad.filter(p => playerIds.includes(p.id));
      const overseasCount = selectedPlayers.filter(p => p.country === "Overseas").length;
      if (overseasCount > MAX_OVERSEAS_P11) return; // Validation

      // --- UPDATED RATING LOGIC ---
      const getEffectiveRating = (p) => {
          const factor = p.soldPrice / p.basePrice;
          let finalRating = p.rating;

          if (factor > 6) {
              finalRating = p.rating - 5; // Penalty for overpurchasing
          } else if (factor < 2) {
              finalRating = p.rating + 5; // Reward for good deal
          }
          // Else: Rating stays the same

          return Math.max(0, finalRating); // Ensure rating doesn't go negative
      };

      const captain = team.squad.find(p => p.id === cId);
      const viceCaptain = team.squad.find(p => p.id === vcId);
      const cEffRating = getEffectiveRating(captain);
      const vcEffRating = getEffectiveRating(viceCaptain);

      let score = 0;
      score += (cEffRating * 2);      // Captain 2x
      score += (vcEffRating * 1.5);   // VC 1.5x
      
      // Leadership bonus applied to others
      const leadershipBonus = (cEffRating * 0.10) + (vcEffRating * 0.05);
      
      playerIds.forEach(pid => {
          if (pid !== cId && pid !== vcId) {
              const p = team.squad.find(pl => pl.id === pid);
              if(p) score += (getEffectiveRating(p) + leadershipBonus);
          }
      });

      team.totalScore = Math.round(score * 100) / 100;
      team.submitted11 = true;
      team.playing11 = selectedPlayers;

      const activeTeams = Object.values(room.teams).filter(t => !t.isEliminated);
      const allSubmitted = activeTeams.every(t => t.submitted11);

      if(allSubmitted) calculateWinner(roomId);
      else io.to(roomId).emit("teams-updated", Object.values(room.teams));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));