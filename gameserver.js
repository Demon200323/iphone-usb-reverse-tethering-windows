// modules/gameserver.js — AUREX-9 v3.0
const dgram = require("dgram");

async function getServerOnline(cfg) {
  if (!cfg?.ip) return null;
  if (cfg.type === "minecraft") return getMinecraft(cfg);
  return getSourceQuery(cfg);
}

function getSourceQuery(cfg) {
  return new Promise(resolve => {
    const sock = dgram.createSocket("udp4");
    const challenge = Buffer.from([0xFF,0xFF,0xFF,0xFF,0x54,...Buffer.from("Source Engine Query\0")]);
    const timeout   = setTimeout(() => { sock.close(); resolve(null); }, 3000);
    sock.on("message", msg => {
      clearTimeout(timeout);
      sock.close();
      try {
        let i = 4;
        if (msg[i] !== 0x49) return resolve(null);
        i += 7; // skip protocol, name
        const readStr = () => {
          const end = msg.indexOf(0, i); const s = msg.slice(i,end).toString(); i = end+1; return s;
        };
        const serverName = readStr(), map = readStr();
        readStr(); // folder
        readStr(); // game
        i += 2; // app id
        const players = msg[i++], maxPlayers = msg[i];
        resolve({ name:serverName, map, online:players, max:maxPlayers });
      } catch { resolve(null); }
    });
    sock.on("error", () => { clearTimeout(timeout); resolve(null); });
    sock.send(challenge, cfg.port || 27015, cfg.ip);
  });
}

function getMinecraft(cfg) {
  return new Promise(resolve => {
    const net = require("net");
    const sock = net.createConnection({ host:cfg.ip, port:cfg.port||25565 }, () => {
      sock.write(Buffer.from([0xFE,0x01]));
    });
    sock.setTimeout(3000);
    sock.on("data", d => {
      sock.destroy();
      try {
        const str = d.toString("utf16le");
        const parts = str.split("\x00\x00\x00");
        resolve({ name:cfg.name||"Minecraft", map:"Minecraft", online:parseInt(parts[3])||0, max:parseInt(parts[4])||0 });
      } catch { resolve(null); }
    });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => { sock.destroy(); resolve(null); });
  });
}

module.exports = { getServerOnline };
