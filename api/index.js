// Vercel entry point: every request is rewritten here (see vercel.json) and handled by lib/guardian.js.
const { handle } = require("../lib/guardian");
module.exports = (req, res) => handle(req, res);
