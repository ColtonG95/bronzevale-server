const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const players = new Map();
const lastActionAt = new Map();

const world = {
  choppedTrees: new Set(),
  doors: {},
  goblins: {
    goblin_0: { id: 'goblin_0', x: 42, z: 31, homeX: 42, homeZ: 31, hp: 35, maxHp: 35, alive: true, respawnAt: 0, wander: Math.random() * Math.PI * 2 },
    goblin_1: { id: 'goblin_1', x: 50, z: 38, homeX: 50, homeZ: 38, hp: 35, maxHp: 35, alive: true, respawnAt: 0, wander: Math.random() * Math.PI * 2 },
    goblin_2: { id: 'goblin_2', x: -46, z: 32, homeX: -46, homeZ: 32, hp: 35, maxHp: 35, alive: true, respawnAt: 0, wander: Math.random() * Math.PI * 2 },
    goblin_3: { id: 'goblin_3', x: 43, z: -35, homeX: 43, homeZ: -35, hp: 35, maxHp: 35, alive: true, respawnAt: 0, wander: Math.random() * Math.PI * 2 },
  },
};

const BUILDINGS = [
  { id: 'home_west', x: -14, z: -7, width: 12.8, depth: 11.2 },
  { id: 'home_east', x: 15, z: -6, width: 12.8 * 0.95, depth: 11.2 * 0.95 },
  { id: 'general_store', x: -19, z: 14, width: 13.8 * 1.1, depth: 11.8 * 1.1 },
  { id: 'cookhouse', x: 20, z: 17, width: 13.5 * 1.08, depth: 11.5 * 1.08 },
];

function now() {
  return Date.now();
}

function allowed(id, type, cooldownMs) {
  const safeId = String(id || 'unknown');
  const key = `${safeId}:${type}`;
  const t = now();
  const last = lastActionAt.get(key) || 0;
  if (t - last < cooldownMs) return false;
  lastActionAt.set(key, t);
  return true;
}

function dist(x1, z1, x2, z2) {
  return Math.hypot(x1 - x2, z1 - z2);
}

function pointInsideBuilding(x, z, building, padding = 0) {
  return (
    Math.abs(x - building.x) < building.width / 2 + padding &&
    Math.abs(z - building.z) < building.depth / 2 + padding
  );
}

function lineSegmentIntersectsRect(x1, z1, x2, z2, rect) {
  const minX = rect.x - rect.width / 2;
  const maxX = rect.x + rect.width / 2;
  const minZ = rect.z - rect.depth / 2;
  const maxZ = rect.z + rect.depth / 2;

  if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX) || (z1 < minZ && z2 < minZ) || (z1 > maxZ && z2 > maxZ)) {
    return false;
  }

  if (x1 > minX && x1 < maxX && z1 > minZ && z1 < maxZ) return true;
  if (x2 > minX && x2 < maxX && z2 > minZ && z2 < maxZ) return true;

  const dx = x2 - x1;
  const dz = z2 - z1;
  const checks = [];

  if (Math.abs(dx) > 0.0001) checks.push((minX - x1) / dx, (maxX - x1) / dx);
  if (Math.abs(dz) > 0.0001) checks.push((minZ - z1) / dz, (maxZ - z1) / dz);

  return checks.some(t => {
    if (t < 0 || t > 1) return false;
    const x = x1 + dx * t;
    const z = z1 + dz * t;
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  });
}

function lineBlockedByBuilding(x1, z1, x2, z2) {
  return BUILDINGS.some(b => lineSegmentIntersectsRect(x1, z1, x2, z2, b));
}

function goblinBlockedByBuilding(x, z) {
  return BUILDINGS.some(b => pointInsideBuilding(x, z, b, 0.55));
}

function tryMoveGoblin(goblin, dx, dz) {
  const nx = goblin.x + dx;
  const nz = goblin.z + dz;

  if (!goblinBlockedByBuilding(nx, nz)) {
    goblin.x = nx;
    goblin.z = nz;
    return;
  }

  if (!goblinBlockedByBuilding(goblin.x + dx, goblin.z)) goblin.x += dx;
  if (!goblinBlockedByBuilding(goblin.x, goblin.z + dz)) goblin.z += dz;
}

function canGoblinSeePlayer(goblin, player) {
  if (!goblin || !player) return false;
  if (player.scene === 'dungeon') return false;
  if (dist(goblin.x, goblin.z, player.x, player.z) > 9) return false;
  return !lineBlockedByBuilding(goblin.x, goblin.z, player.x, player.z);
}

function updateGoblins(dt) {
  const playerList = Array.from(players.values()).filter(p => p.scene !== 'dungeon');

  for (const goblin of Object.values(world.goblins)) {
    if (!goblin.alive) {
      if (goblin.respawnAt && Date.now() >= goblin.respawnAt) {
        goblin.hp = goblin.maxHp;
        goblin.alive = true;
        goblin.x = goblin.homeX;
        goblin.z = goblin.homeZ;
        broadcast({ type: 'goblinRespawned', id: 'server', goblinId: goblin.id });
      }
      continue;
    }

    let nearest = null;
    let nearestDistance = Infinity;

    for (const player of playerList) {
      if (!canGoblinSeePlayer(goblin, player)) continue;

      const d = dist(goblin.x, goblin.z, player.x, player.z);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = player;
      }
    }

    if (nearest && nearestDistance < 9 && nearestDistance > 2.2) {
      const dx = (nearest.x - goblin.x) / nearestDistance;
      const dz = (nearest.z - goblin.z) / nearestDistance;
      tryMoveGoblin(goblin, dx * dt * 2.1, dz * dt * 2.1);
    } else {
      goblin.wander += dt * 0.6;
      const homeD = dist(goblin.x, goblin.z, goblin.homeX, goblin.homeZ);

      if (homeD < 5.5) {
        tryMoveGoblin(
          goblin,
          Math.sin(goblin.wander) * dt * 0.45,
          Math.cos(goblin.wander * 0.77) * dt * 0.45
        );
      } else if (homeD > 0.01) {
        const dx = (goblin.homeX - goblin.x) / homeD;
        const dz = (goblin.homeZ - goblin.z) / homeD;
        tryMoveGoblin(goblin, dx * dt, dz * dt);
      }
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(__dirname, safePath);

  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.bin': 'application/octet-stream',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function broadcast(payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on('connection', ws => {
  let playerId = null;
  let playerName = 'Adventurer';

  send(ws, {
    type: 'worldSnapshot',
    world: {
      choppedTrees: Array.from(world.choppedTrees),
      doors: world.doors,
      goblins: world.goblins,
    },
  });

  ws.on('message', message => {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!data || typeof data !== 'object') return;

    if (data.type === 'hello') {
      playerId = String(data.id || playerId || Math.random().toString(36).slice(2));
      playerName = String(data.name || 'Adventurer').slice(0, 18);

      ws.playerId = playerId;
      ws.playerName = playerName;

      broadcast({
        type: 'playerJoined',
        id: playerId,
        name: playerName,
      }, ws);

      return;
    }

    if (data.type === 'move') {
      playerId = String(data.id || playerId || Math.random().toString(36).slice(2));
      playerName = String(data.name || playerName || 'Adventurer').slice(0, 18);

      ws.playerId = playerId;
      ws.playerName = playerName;

      players.set(playerId, {
        id: playerId,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        z: Number(data.z) || 0,
        rot: Number(data.rot) || 0,
        scene: data.scene === 'dungeon' ? 'dungeon' : 'overworld',
        action: String(data.action || 'idle').slice(0, 20),
        name: playerName,
        lastSeen: Date.now(),
      });

      return;
    }

    if (data.type === 'chat') {
      const chatId = String(data.id || playerId || 'unknown');
      if (!allowed(chatId, 'chat', 500)) return;

      broadcast({
        type: 'chat',
        id: chatId,
        name: String(data.name || playerName || 'Adventurer').slice(0, 18),
        text: String(data.text || '').slice(0, 120),
      });

      return;
    }

    if (data.type === 'treeChopped') {
      const actorId = String(data.id || playerId || 'unknown');
      if (!allowed(actorId, `treeChopped:${data.treeId}`, 400)) return;

      world.choppedTrees.add(String(data.treeId));

      broadcast({
        type: 'treeChopped',
        id: actorId,
        treeId: data.treeId,
      });

      return;
    }

    if (data.type === 'treeRespawned') {
      const actorId = String(data.id || playerId || 'unknown');
      if (!allowed(actorId, `treeRespawned:${data.treeId}`, 400)) return;

      world.choppedTrees.delete(String(data.treeId));

      broadcast({
        type: 'treeRespawned',
        id: actorId,
        treeId: data.treeId,
      });

      return;
    }

    if (data.type === 'doorState') {
      const actorId = String(data.id || playerId || 'unknown');
      if (!allowed(actorId, `doorState:${data.doorId}`, 250)) return;

      world.doors[String(data.doorId)] = !!data.open;

      broadcast({
        type: 'doorState',
        id: actorId,
        doorId: data.doorId,
        open: !!data.open,
      });

      return;
    }

    if (data.type === 'goblinHit') {
      const actorId = String(data.id || playerId || 'unknown');
      if (!allowed(actorId, `goblinHit:${data.goblinId}`, 350)) return;

      const player = players.get(actorId);
      const goblin = world.goblins[data.goblinId];

      if (!player || player.scene === 'dungeon' || !goblin || !goblin.alive) return;

      const distanceToGoblin = dist(player.x, player.z, goblin.x, goblin.z);
      if (distanceToGoblin > 4.3) return;
      if (lineBlockedByBuilding(player.x, player.z, goblin.x, goblin.z)) return;

      const damage = Math.max(1, Math.min(25, Number(data.damage) || 1));
      goblin.hp = Math.max(0, goblin.hp - damage);

      if (goblin.hp <= 0) {
        goblin.alive = false;
        goblin.respawnAt = Date.now() + 6000;
      }

      broadcast({
        type: 'goblinHit',
        id: actorId,
        goblinId: goblin.id,
        hp: goblin.hp,
        alive: goblin.alive,
        damage,
      });

      return;
    }

    if (data.type === 'ping') {
      send(ws, { type: 'pong', t: data.t });
      return;
    }

    if (data.type === 'fishSplash') {
      const actorId = String(data.id || playerId || 'unknown');
      if (!allowed(actorId, 'fishSplash', 1000)) return;

      broadcast({
        type: 'fishSplash',
        id: actorId,
        success: !!data.success,
        x: Number(data.x) || 0,
        z: Number(data.z) || 0,
      });

      return;
    }
  });

  ws.on('close', () => {
    if (playerId) {
      players.delete(playerId);

      broadcast({
        type: 'playerLeft',
        id: playerId,
        name: playerName,
      });
    }
  });
});

let lastTick = Date.now();

setInterval(() => {
  const t = Date.now();
  const dt = Math.min(0.05, (t - lastTick) / 1000);
  lastTick = t;

  updateGoblins(dt);

  const staleCutoff = Date.now() - 15000;
  for (const [id, player] of players.entries()) {
    if ((player.lastSeen || 0) < staleCutoff) {
      players.delete(id);
      broadcast({
        type: 'playerLeft',
        id,
        name: player.name || 'Adventurer',
      });
    }
  }

  broadcast({
    type: 'sync',
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      rot: p.rot,
      scene: p.scene,
      action: p.action,
      name: p.name,
    })),
    goblins: Object.values(world.goblins).map(g => ({
      id: g.id,
      x: g.x,
      z: g.z,
      hp: g.hp,
      alive: g.alive,
    })),
  });
}, 100);

server.listen(PORT, HOST, () => {
  console.log(`Game + WebSocket server running on port ${PORT}`);
});