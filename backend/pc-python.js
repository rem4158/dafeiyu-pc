const fs = require('node:fs');
const path = require('node:path');

function pcPython(root) {
  const venv = path.join(root, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(venv) ? venv : path.join(root, 'runtime', 'python', 'python.exe');
}

module.exports = { pcPython };
