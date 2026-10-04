// Local server + CLI.  Run: node cli.js   (Vercel uses api/index.js instead)
"use strict";
const http = require("node:http");
const app = require("./lib/guardian");

const PORT = Number(process.env.PORT || 3000);
const [cmd, ...args] = process.argv.slice(2);

(async () => {
  if (cmd === "create-user") {                                        // PASSWORD=... node server.js create-user alice
    await app.init();
    await app.createUser(args[0] || "", process.env.PASSWORD);
    console.log(`user ${args[0]} saved`);
  } else if (cmd === "create-device") {                               // node server.js create-device crate-3 [delicate|standard|sturdy]
    await app.init();
    const d = await app.createDevice(args[0], args[1]);
    console.log(`device ${d.name} (${d.produce})\nkey: ${d.key}\n(shown once, put it in the firmware config)`);
  } else if (cmd) {
    console.error("usage: node cli.js [create-user <name> | create-device <name> [profile]]"); process.exit(1);
  } else {
    await app.init();
    http.createServer(app.handle).listen(PORT, () => console.log(`Smart Produce Guardian on http://localhost:${PORT}  (db: ${app.dbLabel})`));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
