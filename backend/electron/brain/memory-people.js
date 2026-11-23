/**
 * 用户社交人物网（只记人物；宠物/物件写入 notes）
 */

const VALID_RELATION_TYPES = new Set(['family', 'friend', 'colleague', 'other']);

const RELATION_LABELS = {
  family: '家人',
  friend: '朋友',
  colleague: '同事',
  other: '其他',
};

/** 家人称呼 canonical → 口语别名（用于消歧与 mention 匹配） */
const FAMILY_CANONICAL_ALIASES = {
  妈妈: ['妈', '母亲', '妈咪', '我妈'],
  爸爸: ['爸', '父亲', '爹', '我爸'],
  老公: ['丈夫', '我老公'],
  老婆: ['妻子', '我老婆'],
  男朋友: ['男友', '我男朋友'],
  女朋友: ['女友', '我女朋友'],
  奶奶: ['祖母', '我奶奶'],
  爷爷: ['祖父', '我爷爷'],
  外婆: ['姥姥', '外祖母', '我外婆'],
  外公: ['姥爷', '外祖父', '我外公'],
};

/**
 * @returns {{ displayName: string, aliases: string[], relationType: string, notes: string }}
 */
function emptyPersonTemplate(displayName) {
  return {
    displayName: String(displayName || '').trim(),
    aliases: [],
    relationType: 'other',
    notes: '',
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseAliasesJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => String(a).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string[]} aliases
 */
function serializeAliases(aliases) {
  const unique = [...new Set(aliases.map((a) => String(a).trim()).filter(Boolean))];
  return JSON.stringify(unique);
}

/**
 * @param {string} name
 */
function normalizeNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * 将口语称呼解析为 canonical 显示名（家人）；非家人原样返回
 * @param {string} name
 */
function getCanonicalFamilyName(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;

  const key = normalizeNameKey(raw);
  for (const [canonical, aliases] of Object.entries(FAMILY_CANONICAL_ALIASES)) {
    if (normalizeNameKey(canonical) === key) return canonical;
    if (aliases.some((alias) => normalizeNameKey(alias) === key)) return canonical;
  }
  return raw;
}

/**
 * @param {string} a
 * @param {string} b
 */
function namesReferToSamePerson(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (normalizeNameKey(left) === normalizeNameKey(right)) return true;
  return normalizeNameKey(getCanonicalFamilyName(left)) === normalizeNameKey(getCanonicalFamilyName(right));
}

/**
 * @param {string} displayName
 * @returns {string[]}
 */
function expandFamilyAliases(displayName) {
  const canonical = getCanonicalFamilyName(displayName);
  const aliases = Object.hasOwn(FAMILY_CANONICAL_ALIASES, canonical) ? FAMILY_CANONICAL_ALIASES[canonical] : [];
  return [canonical, ...aliases];
}

function supportsRelation(evidence, type, name) {
  const cues = {
    family: /家人|亲人|亲戚|父亲|母亲|爷爷|奶奶|姥姥|姥爷|祖父|祖母|我(?:的)?[爸妈]|弟弟|妹妹|哥哥|姐姐|老婆|老公|丈夫|妻子|男朋友|女朋友/,
    friend: /(?<![男女])朋友|好友|发小|闺蜜|伙伴|室友/,
    colleague: /同事|同僚|同组|同部门|一起共事/,
  };
  return type === 'other' || (type === 'family' && Object.hasOwn(FAMILY_CANONICAL_ALIASES, getCanonicalFamilyName(name)))
    || (cues[type]?.test(evidence) ?? false);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function listPeople(db, limit = 50) {
  return db
    .prepare(
      `SELECT id, display_name AS displayName, aliases_json AS aliasesJson,
              relation_type AS relationType, notes,
              last_mentioned_at AS lastMentionedAt, source_message_id AS sourceMessageId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM user_people
       ORDER BY last_mentioned_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 */
function getPersonById(db, id) {
  return db
    .prepare(
      `SELECT id, display_name AS displayName, aliases_json AS aliasesJson,
              relation_type AS relationType, notes,
              last_mentioned_at AS lastMentionedAt, source_message_id AS sourceMessageId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM user_people WHERE id = ?`,
    )
    .get(id);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} mention
 */
function findPersonByMention(db, mention, { forWrite = false } = {}) {
  const needle = normalizeNameKey(mention);
  if (!needle || needle.length < 1) return null;

  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, aliases_json AS aliasesJson,
              relation_type AS relationType, notes,
              last_mentioned_at AS lastMentionedAt, source_message_id AS sourceMessageId
       FROM user_people`,
    )
    .all();

  const byName = rows.filter(row => namesReferToSamePerson(row.displayName, mention));
  if (byName.length) return byName.length === 1 ? byName[0] : (forWrite ? false : null);
  const byAlias = rows.filter(row => parseAliasesJson(row.aliasesJson)
    .some(alias => namesReferToSamePerson(alias, mention)) &&
    !getCardEdits(db, row.id).retiredNames.has(needle));
  // Sharing part of a name is not evidence that two people are the same person.
  return byAlias.length === 1 ? byAlias[0] : (forWrite && byAlias.length > 1 ? false : null);
}

/**
 * @param {string} existingNotes
 * @param {string} incomingNotes
 */
function mergeNotes(existingNotes, incomingNotes) {
  const prev = String(existingNotes || '').trim();
  const next = String(incomingNotes || '').trim();
  if (!next) return prev;
  if (!prev) return next;
  if (prev.includes(next)) return prev;
  if (next.includes(prev)) return next;
  return `${prev}；${next}`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   displayName: string,
 *   aliases?: string[],
 *   relationType?: string,
 *   notes?: string,
 *   sourceMessageId?: number | null,
 * }} person
 */
function upsertPerson(db, person) {
  const rawName = String(person.displayName || '').trim();
  if (!rawName) return null;

  const canonicalName = getCanonicalFamilyName(rawName);
  const now = Date.now();
  let relationType = VALID_RELATION_TYPES.has(person.relationType)
    ? person.relationType
    : 'other';
  let incomingAliases = Array.isArray(person.aliases) ? person.aliases : [];
  const notes = String(person.notes || '').trim();
  const sourceMessageId = person.sourceMessageId ?? null;

  const existing = findPersonByMention(db, rawName, { forWrite: true });
  if (existing === false) return null; // ambiguous alias: do not create a third card
  if (sourceMessageId != null) {
    if ((existing?.sourceMessageId ?? 0) > sourceMessageId
        || !require('./memory-validity').makeSourceGuard(db, now)(sourceMessageId)) return null;
    const source = db.prepare('SELECT role, content FROM messages WHERE id=?').get(sourceMessageId);
    const evidence = person.evidence || source?.content;
    if (source?.role !== 'user' || !evidence || !source.content.includes(evidence)) return null;
    const names = [rawName, ...expandFamilyAliases(canonicalName), ...(existing ? parseAliasesJson(existing.aliasesJson) : [])];
    if (!names.some(name => evidence.includes(name)) || (notes && !evidence.includes(notes))) return null;
    incomingAliases = incomingAliases.map(a => String(a).trim()).filter(a => a && evidence.includes(a));
    if (!supportsRelation(evidence, relationType, rawName)) relationType = 'other';
    // A failed extraction may be replayed after the user edited/deleted its card.
    const revised = db.prepare(`SELECT 1 FROM memory_entity_revisions r
      WHERE r.entity_type='person' AND r.undone_by IS NULL
        AND (json_extract(r.before_json,'$.source_message_id')=? OR EXISTS (
          SELECT 1 FROM memory_people_sources s WHERE s.person_id=r.entity_id AND s.source_message_id=?
            AND s.created_at<=r.created_at))
        AND (json_extract(r.before_json,'$.display_name')=? OR r.entity_id=?) LIMIT 1`)
      .get(sourceMessageId, sourceMessageId, rawName, existing?.id ?? null);
    if (revised) return null;
  }
  const displayName = existing?.displayName || canonicalName;

  if (existing) {
    const mergedAliases = [
      ...parseAliasesJson(existing.aliasesJson),
      ...incomingAliases,
      ...expandFamilyAliases(displayName),
    ];
    if (!namesReferToSamePerson(existing.displayName, rawName)) {
      mergedAliases.push(rawName);
    }

    db.prepare(`
      UPDATE user_people SET
        relation_type = @relationType,
        aliases_json = @aliasesJson,
        notes = @notes,
        last_mentioned_at = @now,
        source_message_id = COALESCE(@sourceMessageId, source_message_id),
        updated_at = @now
      WHERE id = @id
    `).run({
      id: existing.id,
      relationType: (sourceMessageId != null ? getCardEdits(db, existing.id).manualRelation : null)
        ?? (relationType === 'other' ? existing.relationType : relationType),
      aliasesJson: serializeAliases(mergedAliases),
      notes: mergeNotes(existing.notes, notes),
      now,
      sourceMessageId,
    });
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO user_people (
      display_name, aliases_json, relation_type, notes,
      last_mentioned_at, source_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    displayName,
    serializeAliases([
      ...incomingAliases,
      ...expandFamilyAliases(displayName),
      ...(rawName !== displayName ? [rawName] : []),
    ]),
    FAMILY_CANONICAL_ALIASES[displayName] && relationType === 'other' ? 'family' : relationType,
    notes,
    now,
    sourceMessageId,
    now,
    now,
  );

  return Number(result.lastInsertRowid);
}

function cardNames(card) {
  return [...new Set([card.displayName, ...parseAliasesJson(card.aliasesJson),
    ...expandFamilyAliases(card.displayName)].map(normalizeNameKey))].filter(n => n.length >= 2);
}

// The management card is an archive: its notes may concatenate several conversations.
// For a model prompt, use only the latest user's evidence or a still-effective manual edit.
function getCardEdits(db, id) {
  const revisions = db.prepare(`SELECT before_json, after_json FROM memory_entity_revisions
    WHERE entity_type='person' AND entity_id=? AND undone_by IS NULL ORDER BY id`).all(id);
  const retiredNames = new Set();
  let manualNotes;
  let manualRelation;
  let edited = false;
  for (const revision of revisions) {
    if (!revision.after_json) continue;
    const before = JSON.parse(revision.before_json);
    const after = JSON.parse(revision.after_json);
    edited = true;
    if (after.display_name !== before.display_name) {
      for (const n of expandFamilyAliases(before.display_name)) retiredNames.add(normalizeNameKey(n));
      retiredNames.delete(normalizeNameKey(after.display_name));
    }
    if (after.notes !== before.notes) manualNotes = after.notes;
    if (after.relation_type !== before.relation_type) manualRelation = after.relation_type;
  }
  return { retiredNames, manualNotes, manualRelation, edited };
}

function projectPerson(db, person, sourceAllowed, now) {
  const { getFactRelevance, FACT_FORGET_THRESHOLD } = require('./memory-validity');
  const { retiredNames, manualNotes, manualRelation, edited } = getCardEdits(db, person.id);
  const aliases = parseAliasesJson(person.aliasesJson).filter(n => !retiredNames.has(normalizeNameKey(n)));
  const projected = { ...person, aliasesJson: serializeAliases(aliases) };
  if (person.sourceMessageId == null) return projected; // standalone/local card

  const source = db.prepare("SELECT created_at FROM messages WHERE id=? AND role='user'")
    .get(person.sourceMessageId);
  const usable = source && sourceAllowed(person.sourceMessageId);
  if (!usable && !edited) return null;
  const recent = usable && getFactRelevance({ importance: 3, updatedAt: source.created_at }, now) >= FACT_FORGET_THRESHOLD;
  // Once the observation has faded, do not reopen its raw message on a name
  // match. A separately recorded relationship may still support its broad label.
  const content = recent ? db.prepare('SELECT content FROM messages WHERE id=?').get(person.sourceMessageId).content : '';
  const notes = String(person.notes || '').split('；').filter(Boolean);
  if (manualRelation) projected.relationType = manualRelation;
  else if (!(recent && supportsRelation(content, person.relationType, person.displayName))) {
    const past = db.prepare(`SELECT source_message_id AS id, evidence FROM memory_people_sources
      WHERE person_id=? ORDER BY id DESC LIMIT 32`).all(person.id);
    if (!past.some(s => supportsRelation(s.evidence, person.relationType, person.displayName) && sourceAllowed(s.id))) {
      projected.relationType = 'other';
    }
  }
  let latestNotes = [];
  if (recent) {
    const recorded = db.prepare('SELECT evidence FROM memory_people_sources WHERE person_id=? AND source_message_id=?')
      .all(person.id, person.sourceMessageId);
    // Older cards may have just a message ID, with no separately recorded excerpt.
    const excerpts = recorded.length ? recorded.map(s => s.evidence).filter(e => content.includes(e)) : [content];
    latestNotes = notes.filter(note => excerpts.some(e => e.includes(note)));
  }
  // If automatic extraction appended an observation after a manual correction, keep the
  // user's version. They can edit it again; a retry/read must never reinstate older notes.
  projected.notes = manualNotes ?? latestNotes.join('；');
  return projected;
}

function mentionSpans(text, card) {
  const spans = [];
  for (const name of cardNames(card)) {
    for (let start = text.indexOf(name); start !== -1; start = text.indexOf(name, start + name.length)) {
      const end = start + name.length;
      if ((/^\w/.test(name) && /\w/.test(text[start - 1] || '')) ||
          (/\w$/.test(name) && /\w/.test(text[end] || ''))) continue;
      const prefix = text.slice(Math.max(0, start - 6), start);
      if (FAMILY_CANONICAL_ALIASES[getCanonicalFamilyName(card.displayName)] &&
          !name.startsWith('我') && /(?:他|她|你|它|朋友|同事|的)$/.test(prefix) && !/我(?:的)?$/.test(prefix)) continue;
      spans.push({ id: card.id, start, end });
    }
  }
  return spans;
}

function matchPeopleInText(db, userText, limit = 4, now = Date.now()) {
  const text = normalizeNameKey(userText);
  if (!text || limit <= 0) return [];
  // An explicitly named person can be arbitrarily far down the recent list.
  const names = db.prepare('SELECT id, display_name AS displayName, aliases_json AS aliasesJson FROM user_people ORDER BY last_mentioned_at DESC,id DESC');
  const candidates = [];
  for (const card of names.iterate()) {
    if (cardNames(card).some(name => text.includes(name))) candidates.push(card);
  }
  if (!candidates.length) return [];
  const sourceAllowed = require('./memory-validity').makeSourceGuard(db, now);
  const cards = candidates.map(p => getPersonById(db,p.id)).filter(Boolean);
  const people = cards.map(card => projectPerson(db, card, sourceAllowed, now)).filter(Boolean);
  const spans = people.flatMap(card => mentionSpans(text, card)).sort((a, b) => a.start - b.start);
  const reservations = candidates.flatMap(card => mentionSpans(text, card)).sort((a, b) => a.start - b.start);
  const scores = new Map();
  let pos = 0, first, second; // furthest right endpoint for two distinct cards at this position
  for (const span of spans) {
    // Shared aliases and a short name embedded in someone else's full name are ambiguous.
    while (pos < reservations.length && reservations[pos].start <= span.start) {
      const r = reservations[pos++];
      if (!first) first = r;
      else if (r.id === first.id) { if (r.end > first.end) first = r; }
      else if (r.end > first.end) { second = first; first = r; }
      else if (!second || r.end > second.end) second = r;
    }
    if ((first?.id === span.id ? second : first)?.end >= span.end) continue;
    scores.set(span.id, Math.max(scores.get(span.id) || 0, span.end - span.start));
  }
  return people.filter(p => scores.has(p.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, limit);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [userText]
 * @param {number} [limit]
 */
function buildPeopleContextBlock(db, userText, limit = 4, allow) {
  const matches = matchPeopleInText(db,userText,allow ? Infinity : limit);
  const people = allow ? matches.filter(allow).slice(0,limit) : matches;
  if (!people.length) return '';

  const lines = people.map((p) => {
    const rel = RELATION_LABELS[p.relationType] || '其他';
    const notePart = p.notes?.trim() ? ` — ${p.notes.trim()}` : '';
    return `- ${p.displayName}（${rel}）${notePart}`;
  });

  return `【你身边的人】\n${lines.join('\n')}`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getPeopleCount(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM user_people`).get();
  return row?.n ?? 0;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 */
function deletePerson(db, id) {
  const result = db.prepare(`DELETE FROM user_people WHERE id = ?`).run(id);
  return result.changes > 0;
}

module.exports = {
  VALID_RELATION_TYPES,
  RELATION_LABELS,
  FAMILY_CANONICAL_ALIASES,
  listPeople,
  projectPerson,
  getPersonById,
  findPersonByMention,
  getCanonicalFamilyName,
  namesReferToSamePerson,
  upsertPerson,
  matchPeopleInText,
  buildPeopleContextBlock,
  getPeopleCount,
  deletePerson,
  mergeNotes,
};
