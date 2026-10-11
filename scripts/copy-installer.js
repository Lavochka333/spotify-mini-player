const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');
const output = path.join(__dirname, '..', 'dist');
fs.copyFileSync(path.join(output, `Spotify-Mini-Player-Setup-${version}.exe`), path.join(output, 'setup.exe'));
console.log('Installer ready: dist/setup.exe');
