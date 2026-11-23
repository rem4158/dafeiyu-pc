// Read PC-owned local sticker packs; sourceRoot can select a custom library.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semantics = require('./sticker-semantics');
const DEFAULT_ROOT = path.resolve(__dirname, '../assets/stickers');
const EXTENSIONS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
let cache = null;
const CATEGORY_LABELS = { sleep:'休息', money:'资源与花费', food:'吃饭', affection:'亲近', angry:'生气', sad:'难过', confused:'疑惑', happy:'开心', work:'工作', greeting:'招呼', tech:'技术', portrait:'形象', teasing:'调侃' };
function displayText(value, limit=200) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,limit) : '';
}
function stickerName(filename, category, index) {
  const stem=path.parse(filename).name;
  const generic=/^[a-f0-9_-]{16,}$/i.test(stem) || /^(?:\d+[_-])?(?:sticker|meme|image|img|pic)(?:[_-].*|\d*)$/i.test(stem) || /^\d+$/.test(stem);
  return generic ? `${CATEGORY_LABELS[category] || category}表情 ${String(index).padStart(2,'0')}` : displayText(stem);
}
function readJson(file) {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Sticker metadata too large');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function inside(root, file) {
  const relative = path.relative(root, fs.realpathSync(file));
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function inventory(settings = {}) {
  const config = settings.stickers || {};
  const root = path.resolve(config.sourceRoot || DEFAULT_ROOT);
  if (config.enabled === false) return { root, packs: [], categories: {}, images: [] };
  try {
    const selection = path.join(root, 'selection_rules.json');
    const stamp = fs.statSync(selection).mtimeMs;
    const indexStamp = semantics.indexStamp();
    if (cache && cache.root === root && cache.stamp === stamp && cache.indexStamp === indexStamp && Date.now() - cache.time < 15000) return cache.value;
    const rules = readJson(selection).rules || [];
    const defaults = rules.filter(rule => rule.scope === 'default');
    const ids = [...new Set(defaults.flatMap(rule => rule.pack_ids || [rule.pack_id]).filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)))];
    const result = { root, packs: [], categories: {}, images: [] };
    for (const id of ids) {
      const pack = path.join(root, 'packs', id);
      if (!inside(root, pack)) continue;
      const manifest = readJson(path.join(pack, 'manifest.json'));
      result.packs.push({ id, name: manifest.name || id });
      const memes = path.join(pack, 'memes');
      for (const entry of fs.readdirSync(memes, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9_\-\u4e00-\u9fff]+$/.test(entry.name)) continue;
        const directory = path.join(memes, entry.name);
        if (!inside(pack, directory)) continue;
        for (const name of fs.readdirSync(directory).sort()) {
          const file = path.join(directory, name);
          const mime = EXTENSIONS[path.extname(name).toLowerCase()];
          if (!mime || !inside(pack, file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 20 * 1024 * 1024) continue;
          const index = (result.categories[entry.name]?.images.length || 0) + 1;
          let image = { id: crypto.createHash('sha256').update(root + '\0' + id + '/' + entry.name + '/' + name).digest('hex'),
            file, mime, relative_path: 'memes/' + entry.name + '/' + name, category: entry.name, category_label: CATEGORY_LABELS[entry.name] || entry.name,
            name: stickerName(name, entry.name, index),
            description: displayText(manifest.categories?.[entry.name]?.description,1000), pack_id: id };
          image = semantics.annotate(image);
          result.images.push(image);
          (result.categories[entry.name] ||= { description: manifest.categories?.[entry.name]?.description || '', images: [] }).images.push(image);
        }
      }
    }
    cache = { root, stamp, indexStamp, time: Date.now(), value: result };
    return result;
  } catch { return { root, packs: [], categories: {}, images: [] }; }
}
function getStickerMap(settings = {}) {
  const map = {};
  for (const [category, group] of Object.entries(inventory(settings).categories)) {
    const item = group.images[crypto.randomInt(group.images.length)];
    map[category] = { name: category, url: 'local-sticker:' + item.id, description: group.description };
  }
  return map;
}
function resolveSticker(reference, settings = {}) {
  const id = String(reference || '').replace(/^local-sticker:/, '');
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const result=inventory(settings), image=result.images.find(item => item.id === id);
  if (!image) return null;
  // Recheck cached entries before serving bytes; removed/replaced files are unavailable.
  try { const stat=fs.statSync(image.file);return stat.isFile()&&stat.size>0&&stat.size<=20*1024*1024&&inside(path.join(result.root,'packs',image.pack_id),image.file) ? semantics.annotate(image) : null; }
  catch { return null; }
}
function summary(settings = {}) {
  const result = inventory(settings);
  return { source: '本地表情库', packs: result.packs, count: result.images.length,
    categories: Object.entries(result.categories).map(([name, group]) => ({ name, description: group.description, count: group.images.length })) };
}
function catalog(settings = {}) {
  const result = inventory(settings);
  return { enabled: settings.stickers?.enabled !== false, ...summary(settings),
    categories: Object.entries(result.categories).map(([name,group])=>({name,label:CATEGORY_LABELS[name] || name,description:group.description,count:group.images.length})),
    stickers: result.images.map(({id,name,category,category_label,description,pack_id,semantic_status,semantic})=>({id,name,category,category_label,description,pack_id,semantic_status,semantic})) };
}
const semanticText = semantics.semanticText;

module.exports = { DEFAULT_ROOT, inventory, getStickerMap, resolveSticker, summary, catalog, semanticText };
