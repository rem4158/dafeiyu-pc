/** @typedef {{ emotion?: string | null, scene?: string | null, openingReason?: string | null, styleHint?: string | null }} TtsSpeakContext */

const EMOTION_ALIASES = {
  星星眼: '开心',
  脸红: '害羞',
  黑脸: '生气',
};

/** @type {Record<string, string>} */
const EMOTION_DIRECTIVES = {
  开心: '语气明亮愉悦，语速中等偏快，像真心高兴地在说话。',
  害羞: '语速略慢，音量轻柔，尾音微微上扬，有点不好意思。',
  哭哭: '语速偏慢，带一点哽咽和气声，委屈但没嚎啕大哭。',
  生气: '语气硬一些，有压迫感，语速中等，像在质问或赌气。',
  记笔记: '语气认真专注，语速平稳，像在耐心解释。',
  看手机: '语气自然随意，像在边看边聊。',
  晕晕眼: '语气有点迷糊慵懒，语速略慢。',
};

/** @type {Record<string, string>} */
const SCENE_DIRECTIVES = {
  chat: '【场景】日常文字聊天，自然亲切，像面对面说话。',
  call: '【场景】正在和用户打电话，口语化，像真实通话，不要播音腔。',
  proactive: '【场景】主动找用户说话，语气自然，不要太正式。',
};

/** @type {Record<string, string>} */
const OPENING_SCENE_HINTS = {
  ignore_escalation: '【场景】你主动打来，用户刚接听；你之前被冷落，现在忍不住想当面问清楚。',
  evening: '【场景】晚间陪伴来电，用户刚接听，想轻轻聊几句、听听对方声音。',
  chat_invite: '【场景】你刚在聊天里邀请煲电话粥，用户点了打来，刚接通。',
};

function normalizeEmotion(emotion) {
  const raw = String(emotion || '').trim();
  if (!raw) return '';
  return EMOTION_ALIASES[raw] || raw;
}

/**
 * @param {TtsSpeakContext} [ctx]
 */
function buildDynamicDirectorBlock(ctx = {}) {
  /** @type {string[]} */
  const parts = [];

  const openingReason = ctx.openingReason?.trim();
  if (openingReason && OPENING_SCENE_HINTS[openingReason]) {
    parts.push(OPENING_SCENE_HINTS[openingReason]);
  } else {
    const scene = ctx.scene?.trim();
    if (scene && SCENE_DIRECTIVES[scene]) {
      parts.push(SCENE_DIRECTIVES[scene]);
    }
  }

  const emotion = normalizeEmotion(ctx.emotion);
  if (emotion && EMOTION_DIRECTIVES[emotion]) {
    parts.push(`【指导】本轮情绪「${emotion}」：${EMOTION_DIRECTIVES[emotion]}`);
  }

  const extra = ctx.styleHint?.trim();
  if (extra) {
    parts.push(extra);
  }

  return parts.join('\n');
}

/**
 * @param {TtsSpeakContext} [ctx]
 */
function emotionFromOpeningReason(openingReason) {
  switch (openingReason) {
    case 'ignore_escalation':
      return '生气';
    case 'evening':
      return '开心';
    case 'chat_invite':
      return '害羞';
    default:
      return null;
  }
}

const QWEN_INSTRUCTIONS_MAX_CHARS = 4800;

/**
 * Qwen Instruct TTS：将角色描述 + 情绪场景合并为 instructions
 * @param {{
 *   voiceDesignPrompt?: string,
 *   speakStyleHint?: string,
 *   emotion?: string | null,
 *   scene?: string | null,
 *   openingReason?: string | null,
 *   styleHint?: string | null,
 * }} [opts]
 */
function buildQwenInstructions(opts = {}) {
  const parts = [];

  const design = opts.voiceDesignPrompt?.trim();
  if (design) parts.push(design);

  const staticHint = opts.speakStyleHint?.trim();
  if (staticHint) parts.push(staticHint);

  const dynamic = buildDynamicDirectorBlock({
    emotion: opts.emotion,
    scene: opts.scene,
    openingReason: opts.openingReason,
    styleHint: opts.styleHint,
  });
  if (dynamic) parts.push(dynamic);

  let text = parts.join('\n').trim();
  if (text.length > QWEN_INSTRUCTIONS_MAX_CHARS) {
    text = `${text.slice(0, QWEN_INSTRUCTIONS_MAX_CHARS)}…`;
  }
  return text;
}

module.exports = {
  buildDynamicDirectorBlock,
  buildQwenInstructions,
  emotionFromOpeningReason,
  normalizeEmotion,
  EMOTION_DIRECTIVES,
};
