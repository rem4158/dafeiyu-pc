// Standalone local storage: never resolves paths from the original Nianan app.
const fs = require('node:fs');
const path = require('node:path');

function getUserDataRoot() {
  return path.resolve(process.env.DAFEIYU_DATA_DIR || path.join(
    process.env.DAFEIYU_PC_ROOT || path.resolve(__dirname, '../..'), 'data'));
}
function userFilePath(filename) { return path.join(getUserDataRoot(), filename); }
function getActiveUserId() { return 'local'; }
function ensureUserDir() { fs.mkdirSync(getUserDataRoot(), { recursive: true }); }
module.exports = { getUserDataRoot, userFilePath, getActiveUserId, ensureUserDir };
