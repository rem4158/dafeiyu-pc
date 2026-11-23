const fs = require('node:fs');
const path = require('node:path');

function createStickerLibrary(directory) {
  const library = path.join(directory, 'fixture-stickers');
  const pack = path.join(library, 'packs', 'fixture');
  const category = path.join(pack, 'memes', 'happy');
  fs.mkdirSync(category, { recursive: true });
  fs.writeFileSync(path.join(library, 'selection_rules.json'), JSON.stringify({
    rules: [{ scope: 'default', pack_id: 'fixture' }]
  }));
  fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({
    name: 'Test pack', categories: { happy: { description: '开心' } }
  }));
  fs.writeFileSync(path.join(category, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAANklEQVR4nGMM2PLsPwMNARMtDQeBUQsIgtEgIghGg4ggGA0igmA0iAiC0SAiCEaDiCCgeRABAFNfAxnx/9kmAAAAAElFTkSuQmCC', 'base64'));
  return library;
}

module.exports = { createStickerLibrary };
