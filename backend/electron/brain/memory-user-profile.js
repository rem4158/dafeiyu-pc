/**
 * 用户画像：JSON 存储 + prose 注入
 */

const { chatCloud } = require('./cloud');
const { isCloudExtractAvailable } = require('./extract');
const { listPeople } = require('./memory-people');
const { textSimilarity } = require('./text-similarity');
const { RECALLABLE_FACT_SQL, datedFactValue } = require('./memory-validity');
const { isResidenceFact } = require('./memory-residence');

const CONSOLIDATE_COOLDOWN_MS = 10 * 60 * 1000;
const PROFILE_SIMILARITY_THRESHOLD = 0.65;
const PROFILE_MINOR_CHANGE_THRESHOLD = 0.98;
let consolidateScheduled = false;
let consolidateRunning = false;
let lastConsolidateTime = 0;

/**
 * @returns {object}
 */
function emptyProfile() {
  return {
    identity: { name: '', city: '', occupation: '' },
    preferences: [],
    traits: [],
    recent: '',
    tone: '',
  };
}

/**
 * @param {unknown} raw
 */
function parseProfileJson(raw) {
  if (!raw) return emptyProfile();
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const src = /** @type {Record<string, unknown>} */ (raw);
    return {
      identity: {
        name: String(src.identity?.name || '').trim(),
        city: String(src.identity?.city || '').trim(),
        occupation: String(src.identity?.occupation || '').trim(),
      },
      preferences: Array.isArray(src.preferences)
        ? src.preferences.map((p) => String(p).trim()).filter(Boolean)
        : [],
      traits: Array.isArray(src.traits)
        ? src.traits.map((t) => String(t).trim()).filter(Boolean)
        : [],
      recent: String(src.recent || '').trim(),
      tone: String(src.tone || '').trim(),
    };
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return emptyProfile();
    return {
      identity: {
        name: String(parsed.identity?.name || '').trim(),
        city: String(parsed.identity?.city || '').trim(),
        occupation: String(parsed.identity?.occupation || '').trim(),
      },
      preferences: Array.isArray(parsed.preferences)
        ? parsed.preferences.map((p) => String(p).trim()).filter(Boolean)
        : [],
      traits: Array.isArray(parsed.traits)
        ? parsed.traits.map((t) => String(t).trim()).filter(Boolean)
        : [],
      recent: String(parsed.recent || '').trim(),
      tone: String(parsed.tone || '').trim(),
    };
  } catch {
    return emptyProfile();
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getUserProfileRow(db) {
  return db
    .prepare(
      `SELECT id, profile_json AS profileJson, prose_cache AS proseCache,
              revision, consolidated_at AS consolidatedAt, updated_at AS updatedAt
       FROM user_profile WHERE id = 1`,
    )
    .get();
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getUserProfile(db) {
  const row = getUserProfileRow(db);
  if (!row) return null;
  return {
    ...row,
    profile: parseProfileJson(row.profileJson),
  };
}

// Older prose may contain free-form model guesses in tone as well as factual fields.
// Only the local style analyser can mark a tone as observed. It has no factual payload.
function observedTone(row) {
  if (!row) return '';
  try {
    const json = JSON.parse(row.profileJson);
    return typeof json.tone === 'string' && json.toneOrigin === 'local_style' ? json.tone : '';
  } catch {
    return '';
  }
}

/**
 * @param {object} profile
 */
function renderProfileProse(profile) {
  const p = parseProfileJson(profile);
  const parts = [];

  const idBits = [];
  if (p.identity.name) idBits.push(p.identity.name);
  if (p.identity.city) idBits.push(`在${p.identity.city}`);
  if (p.identity.occupation) idBits.push(p.identity.occupation);
  if (idBits.length) parts.push(idBits.join('，'));

  if (p.preferences.length) {
    parts.push(`偏好：${p.preferences.slice(0, 6).join('；')}`);
  }
  if (p.traits.length) {
    parts.push(`性格：${p.traits.slice(0, 4).join('；')}`);
  }
  if (p.recent) {
    parts.push(`近况：${p.recent}`);
  }
  if (p.tone) {
    parts.push(`说话习惯：${p.tone}`);
  }

  if (!parts.length) return '';
  return parts.join('。').replace(/。+/g, '。') + (parts.length ? '。' : '');
}

/**
 * @param {object} oldProfile
 * @param {object} newProfile
 */
function mergeProfilesConservatively(oldProfile, newProfile) {
  const oldP = parseProfileJson(oldProfile);
  const newP = parseProfileJson(newProfile);

  return {
    identity: {
      name: oldP.identity.name || newP.identity.name,
      city: oldP.identity.city || newP.identity.city,
      occupation: oldP.identity.occupation || newP.identity.occupation,
    },
    preferences: [...new Set([...oldP.preferences, ...newP.preferences])].slice(0, 8),
    traits: [...new Set([...oldP.traits, ...newP.traits])].slice(0, 6),
    recent: newP.recent || oldP.recent,
    tone: oldP.tone || newP.tone,
  };
}

/**
 * @param {string} oldProse
 * @param {string} newProse
 * @returns {{ accepted: boolean, reason: string, similarity: number }}
 */
function checkProfileRevision(oldProse, newProse) {
  const oldText = String(oldProse || '').trim();
  const newText = String(newProse || '').trim();

  if (!oldText) {
    return { accepted: Boolean(newText), reason: newText ? 'initial' : 'empty', similarity: 1 };
  }
  if (!newText) {
    return { accepted: false, reason: 'empty_revision', similarity: 0 };
  }

  const similarity = textSimilarity(oldText, newText);
  console.log(`[memory] Profile revision similarity: ${similarity.toFixed(3)}`);

  if (similarity < PROFILE_SIMILARITY_THRESHOLD) {
    return { accepted: false, reason: 'change_too_drastic', similarity };
  }
  if (similarity > PROFILE_MINOR_CHANGE_THRESHOLD) {
    return { accepted: false, reason: 'change_too_minor', similarity };
  }
  return { accepted: true, reason: 'accepted', similarity };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} profile
 * @param {string} [proseOverride]
 * @param {{ skipSimilarityCheck?: boolean, toneFromStyle?: boolean }} [options]
 */
function saveUserProfile(db, profile, proseOverride, options = {}) {
  const now = Date.now();
  let parsed = parseProfileJson(profile);
  let prose = proseOverride != null ? proseOverride : renderProfileProse(parsed);
  const existing = getUserProfileRow(db);

  if (existing && !options.skipSimilarityCheck) {
    const revisionCheck = checkProfileRevision(existing.proseCache, prose);
    if (revisionCheck.reason === 'change_too_minor') {
      return { saved: false, reason: revisionCheck.reason, similarity: revisionCheck.similarity };
    }
    if (revisionCheck.reason === 'change_too_drastic') {
      parsed = mergeProfilesConservatively(existing.profileJson, parsed);
      prose = renderProfileProse(parsed);
      console.warn(
        `[memory] Profile revision too drastic (${revisionCheck.similarity.toFixed(3)}), merged conservatively`,
      );
    }
  }

  const revision = (existing?.revision ?? 0) + (existing ? 1 : 0);
  const stored = { ...parsed };
  if (parsed.tone && (options.toneFromStyle || observedTone(existing) === parsed.tone)) {
    stored.toneOrigin = 'local_style';
  }

  if (existing) {
    db.prepare(`
      UPDATE user_profile SET
        profile_json = @profileJson,
        prose_cache = @proseCache,
        revision = @revision,
        consolidated_at = @now,
        updated_at = @now
      WHERE id = 1
    `).run({
      profileJson: JSON.stringify(stored),
      proseCache: prose,
      revision,
      now,
    });
  } else {
    db.prepare(`
      INSERT INTO user_profile (id, profile_json, prose_cache, revision, consolidated_at, updated_at)
      VALUES (1, @profileJson, @proseCache, 0, @now, @now)
    `).run({
      profileJson: JSON.stringify(stored),
      proseCache: prose,
      now,
    });
  }

  return { saved: true, revision, prose };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function buildProfileContextBlock(db, now = Date.now(), options) {
  // Cache is an editable/inspectable snapshot, not live evidence. Never feed old
  // prose or free-form inferred traits back into the prompt after a correction/expiry.
  const profile = buildHeuristicProfile(db,now,options);
  profile.tone = observedTone(getUserProfileRow(db));
  const prose = renderProfileProse(profile);
  if (!prose) return '';
  return `【关于你】${prose}`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function collectFactsForConsolidation(db, limit = 40, now = Date.now()) {
  return db
    .prepare(
      `SELECT id,category, fact_key AS factKey, fact_value AS factValue, importance, fact_type AS factType,keywords,
              expires_at AS expiresAt,
              CASE WHEN fact_type='temporary' THEN (SELECT created_at FROM messages WHERE id=facts.source_message_id) END AS sourceAt
       FROM facts
       WHERE episode_status IS NULL AND NOT (category='other' AND substr(fact_key,1,5)='交互教导：')
         AND ${RECALLABLE_FACT_SQL}
       ORDER BY importance DESC, updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all({ recallNow: now }, limit);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 */
function collectSummariesForConsolidation(db, sessionId, limit = 5) {
  return db
    .prepare(
      `SELECT summary, created_at AS createdAt
       FROM summaries
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [now]
 */
function buildHeuristicProfile(db, now = Date.now(), {allowFact,extraCandidates=0} = {}) {
  const candidates = collectFactsForConsolidation(db,30+extraCandidates,now);
  const facts = allowFact ? candidates.filter(allowFact).slice(0,30) : candidates;
  const profile = emptyProfile();

  for (const f of facts) {
    const cat = String(f.category || '');
    const key = String(f.factKey || '');
    const val = String(f.factValue || '');

    if (cat === 'profile') {
      // A friend's name, a pet's name or a previous address is not the user's identity.
      const personalKey = key.replace(/^(?:用户的?|我的?)/, '');
      if (/^(?:名字|姓名|昵称|称呼)$/.test(personalKey)) profile.identity.name ||= val;
      else if (isResidenceFact(f)) profile.identity.city ||= val;
      else if (/^(?:职业|工作|工作岗位|职位)$/.test(personalKey)) profile.identity.occupation ||= val;
    } else if (cat === 'preference') {
      profile.preferences.push(`${key}：${val}`);
    } else if (cat === 'opinion' || cat === 'habit') {
      profile.traits.push(`${key}：${val}`);
    } else if (cat === 'plan' || cat === 'event') {
      const line = datedFactValue(f);
      const next = profile.recent ? `${profile.recent}；${line}` : line;
      if (next.length <= 120) profile.recent = next;
    }
  }

  profile.preferences = profile.preferences.slice(0, 8);
  profile.traits = profile.traits.slice(0, 5);

  return profile;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} settings
 * @param {string} sessionId
 */
async function consolidateProfileWithLLM(db, settings, sessionId = 'main') {
  const facts = collectFactsForConsolidation(db, 35);
  const summaries = collectSummariesForConsolidation(db, sessionId, 4);
  const people = listPeople(db, 12);
  const current = getUserProfile(db)?.profile || emptyProfile();

  if (!facts.length && !summaries.length && !people.length) {
    return null;
  }

  const factLines = facts.map((f) => `- [${f.category}] ${f.factKey}：${f.factValue}`);
  const summaryLines = summaries.map((s) => `- ${s.summary}`);
  const peopleLines = people.map(
    (p) => `- ${p.displayName}（${p.relationType}）${p.notes ? `：${p.notes}` : ''}`,
  );

  const prompt = `你是用户画像整理助手。根据以下证据，输出一份 JSON 用户画像（不要 markdown）。

结构：
{
  "identity": { "name": "", "city": "", "occupation": "" },
  "preferences": ["..."],
  "traits": ["..."],
  "recent": "一句话近况",
  "tone": "沟通习惯，可空"
}

规则：
- 只写能从证据推断的内容，不要编造
- preferences/traits 各最多 6 条，短句
- recent 聚焦「最近在忙什么、待跟进的事」
- 与当前画像一致的信息可保留；有新信息则更新

当前画像：
${JSON.stringify(current, null, 2)}

事实记忆：
${factLines.join('\n') || '（无）'}

近期摘要：
${summaryLines.join('\n') || '（无）'}

用户提到的人：
${peopleLines.join('\n') || '（无）'}`;

  const raw = await chatCloud(settings, [{ role: 'user', content: prompt }], { temperature: 0.3,
    usageContext: { purpose: 'memory_profile' } });
  const text = String(raw || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  const profile = parseProfileJson(parsed);
  const prose = renderProfileProse(profile);
  const saveResult = saveUserProfile(db, profile, prose);
  if (saveResult?.saved === false && saveResult.reason === 'change_too_minor') {
    return null;
  }
  return { profile: parseProfileJson(getUserProfileRow(db)?.profileJson), prose: saveResult?.prose || prose };
}

/**
 * 从语言风格分析结果持久化 profile.tone（对话后轻量更新）
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./digital-life-linguistic').LinguisticStyle} style
 */
function updateProfileToneFromStyle(db, style) {
  const { styleToToneDescription } = require('./digital-life-linguistic');
  const newTone = styleToToneDescription(style);
  if (!newTone) return false;

  const row = getUserProfileRow(db);
  const profile = row ? parseProfileJson(row.profileJson) : emptyProfile();
  const previousTone = observedTone(row);
  if (previousTone === newTone) return false;
  if (previousTone && textSimilarity(previousTone, newTone) > 0.92) return false;

  profile.tone = newTone;
  saveUserProfile(db, profile, undefined, { skipSimilarityCheck: true, toneFromStyle: true });
  return true;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} settings
 * @param {string} [sessionId]
 */
async function maybeConsolidateProfile(db, settings, sessionId = 'main') {
  if (consolidateRunning) return;
  if (Date.now() - lastConsolidateTime < CONSOLIDATE_COOLDOWN_MS) return;

  consolidateRunning = true;
  try {
    if (isCloudExtractAvailable(settings)) {
      await consolidateProfileWithLLM(db, settings, sessionId);
    } else {
      const profile = buildHeuristicProfile(db);
      if (renderProfileProse(profile)) {
        saveUserProfile(db, profile);
      }
    }
    lastConsolidateTime = Date.now();
  } catch (err) {
    console.error('[memory] profile consolidation failed:', err);
  } finally {
    consolidateRunning = false;
    consolidateScheduled = false;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} settings
 * @param {string} [sessionId]
 */
function scheduleProfileConsolidation(db, settings, sessionId = 'main') {
  if (consolidateScheduled) return;
  consolidateScheduled = true;

  setTimeout(() => {
    void maybeConsolidateProfile(db, settings, sessionId);
  }, 2000);
}

module.exports = {
  emptyProfile,
  parseProfileJson,
  getUserProfile,
  saveUserProfile,
  renderProfileProse,
  buildProfileContextBlock,
  maybeConsolidateProfile,
  scheduleProfileConsolidation,
  buildHeuristicProfile,
  checkProfileRevision,
  mergeProfilesConservatively,
  updateProfileToneFromStyle,
  PROFILE_SIMILARITY_THRESHOLD,
};
