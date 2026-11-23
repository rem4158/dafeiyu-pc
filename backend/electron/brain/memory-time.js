// Convert a user's stated calendar date to an exclusive local deadline.
// A model-supplied date is never a substitute for a date in the evidence.
const numberText = '(?:[0-9]{1,3}|[零〇一二两三四五六七八九十]{1,3})';
const isoDate = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
const writtenDate = new RegExp('(?:([0-9]{4}|去|今|明|后)年)?(' + numberText + ')月(' + numberText + ')[日号]');
const relativeDay = /大后天|后天|明天|明早|明晚|今天|今日|今晚|今早|昨天|昨晚|前天/;
const relativeWeek = /(下下|下|本|这|上)(?:个)?(?:周|星期|礼拜)([一二三四五六日天末])?/;
const relativeMonthDay = new RegExp('(上|下|本|这)(?:个)?月(' + numberText + ')[日号]');
const relativeMonth = /(?:(上|下|本|这)(?:个)?月(?:底|末)?|月底|月末)/;
const calendarPattern = new RegExp(
  [isoDate, writtenDate, relativeDay, relativeWeek, relativeMonthDay, relativeMonth].map(re => re.source).join('|'), 'g');
const dayOffsets = { 前天: -2, 昨天: -1, 昨晚: -1, 今天: 0, 今日: 0, 今晚: 0, 今早: 0,
  明天: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3 };
const fullStops = /[。！？!?，,；;\n]/;
const uncertain = /时间(?:还)?(?:没定|未定)|待定|延期|改期|取消|不确定|大概|也许|可能|左右|暂定|不打算|不参加|不去|不再|没(?:有)?安排|(?:不是|并非)(?:在)?(?:今|明|本|下|\d)/;
const recurring = /每(?:天|日|周|星期|月|年|逢)|每个(?:周|星期|月)/;
const ambiguousRange = /月初|月中|上旬|中旬|下旬|周初|周中|为期|持续|开始放假|[之以]后/;

function integer(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = [...String(text).replaceAll('两', '二').replaceAll('〇', '零')];
  const numerals = '零一二三四五六七八九';
  const tens = digits.indexOf('十');
  if (tens === -1) return Number(digits.map(c => numerals.indexOf(c)).join(''));
  if (digits.lastIndexOf('十') !== tens || tens > 1 || digits.length > tens + 2) return NaN;
  return (tens === 0 ? 1 : numerals.indexOf(digits[0])) * 10 +
    (digits[tens + 1] ? numerals.indexOf(digits[tens + 1]) : 0);
}

function midnight(date, deltaDays = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + deltaDays);
}

function singleDay(start) {
  return { start, end: midnight(start, 1), oneDay: true };
}

function calendarPeriod(token, sourceDate) {
  const date = token.match(isoDate) || token.match(writtenDate);
  if (date) {
    const yearDelta = { 去: -1, 今: 0, 明: 1, 后: 2 };
    const year = /^\d+$/.test(date[1] || '') ? Number(date[1]) : sourceDate.getFullYear() + (yearDelta[date[1]] || 0);
    const month = integer(date[2]), day = integer(date[3]);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null;
    // With no year, do not silently roll an already-past date into this or next year.
    if (!date[1] && start < midnight(sourceDate)) return null;
    return singleDay(start);
  }
  const dayOfMonth = token.match(relativeMonthDay);
  if (dayOfMonth) {
    const delta = dayOfMonth[1] === '下' ? 1 : dayOfMonth[1] === '上' ? -1 : 0;
    const monthStart = new Date(sourceDate.getFullYear(), sourceDate.getMonth() + delta, 1);
    const day = integer(dayOfMonth[2]), start = midnight(monthStart, day - 1);
    return start.getMonth() === monthStart.getMonth() ? singleDay(start) : null;
  }
  if (Object.hasOwn(dayOffsets, token)) return singleDay(midnight(sourceDate, dayOffsets[token]));
  const week = token.match(relativeWeek);
  if (week) {
    const offsetWeeks = ({ 上: -1, 下: 1, 下下: 2 })[week[1]] || 0;
    const start = midnight(sourceDate, offsetWeeks * 7 - ((sourceDate.getDay() + 6) % 7));
    if (!week[2] || week[2] === '末') return { start: midnight(start, week[2] ? 5 : 0), end: midnight(start, 7) };
    const weekday = '一二三四五六'.indexOf(week[2]);
    return singleDay(midnight(start, weekday < 0 ? 6 : weekday));
  }
  const month = token.match(relativeMonth);
  if (!month) return null;
  const delta = month[1] === '下' ? 1 : month[1] === '上' ? -1 : 0;
  const end = new Date(sourceDate.getFullYear(), sourceDate.getMonth() + delta + 1, 1);
  // "月底" identifies a period towards month's end, without fixing an exact day or hour.
  return { end };
}

function deadlineFor(clause, sourceDate) {
  const matches = [...clause.matchAll(calendarPattern)];
  if (matches.length !== 1 || ambiguousRange.test(clause)) return null;
  // Refuse partial interpretations of an unsupported date, e.g. "农历五月初一",
  // "下下个月" or "明年月底" with a missing month.
  const prefix = clause.slice(0, matches[0].index);
  if (/农历|阴历/.test(clause) || /(?:年|下|上)$/.test(prefix)) return null;
  const afterDate = clause.slice(matches[0].index + matches[0][0].length);
  if (/^(?:起|开始|之后|以后)/.test(afterDate)) return null;
  const period = calendarPeriod(matches[0][0], sourceDate);
  if (!period) return null;
  const explicitEnd = /截止|截至|到期|最晚|之前|以前|为止|点前|分前|\d前/.test(clause);
  const timePattern = new RegExp('(?:(凌晨|早上|上午|中午|下午|晚上)\\s*)?(' + numberText +
    ')(?:[:：](\\d{2})(?!\\d)|[点时](?:(半|一刻|三刻)|(' + numberText + ')分?)?)', 'g');
  const remaining = clause.replace(matches[0][0], ' ');
  const clockTimes = [...remaining.matchAll(timePattern)];
  if (explicitEnd && clockTimes.length) {
    if (!period.oneDay || clockTimes.length !== 1) return null;
    if (/[:：]\d{2}[:：]\d/.test(remaining)) return null;
    const [, periodLabel, hourText, minutes, fraction, minuteText] = clockTimes[0];
    const part = periodLabel || (matches[0][0].endsWith('晚') ? '晚上' : '');
    let hour = integer(hourText);
    const minute = fraction ? { 半: 30, 一刻: 15, 三刻: 45 }[fraction] : minutes ? Number(minutes) : minuteText ? integer(minuteText) : 0;
    if (hour > 23 || minute > 59 || (part && hour > 12)) return null;
    if (part === '晚上' && hour === 12) return null;
    if (['下午', '晚上'].includes(part) && hour < 12) hour += 12;
    if (part === '中午' && hour >= 1 && hour <= 3) hour += 12;
    if (part === '凌晨' && hour === 12) hour = 0;
    const time = new Date(period.start);
    time.setHours(hour, minute, 0, 0);
    return time.getHours() === hour && time.getMinutes() === minute ? time.getTime() : null;
  }
  if (explicitEnd && /[:：]\d|[点时钟刻]/.test(clause.replace(/时间/g, '')) && !clockTimes.length) return null;
  if (period.oneDay && /^(?:[之以]前|前)/.test(afterDate))
    return period.start.getTime();
  // A meeting time says when it starts, not when it ended. Day-only or period-only
  // plans remain eligible through that calendar period, with an exclusive boundary.
  return period.end.getTime();
}

function groundTemporalFact(fact, evidence, sourceAt) {
  if (fact.factType !== 'temporary' && fact.category !== 'plan') return fact;
  if (!Number.isFinite(sourceAt)) return null;
  const sourceDate = new Date(sourceAt);
  if (!Number.isFinite(sourceDate.getTime())) return null;
  const value = String(fact.factValue || '').trim();
  if (!value) return null;
  const clauses = String(evidence || '').split(fullStops).map(s => s.trim()).filter(Boolean);
  // The value and its date must belong to the same claim. Adjacent clauses may
  // describe another person, a different appointment, or an ongoing preference.
  const matching = clauses.filter(s => s.includes(value));
  if (matching.length !== 1) return null;
  const clause = matching[0].replace(/《[^》]*》|“[^”]*”|「[^」]*」/g, '');
  if (uncertain.test(clause) || recurring.test(clause)) return null;
  const expiresAt = deadlineFor(clause, sourceDate);
  return expiresAt == null ? null : { ...fact, factType: 'temporary', expiresAt };
}

module.exports = { groundTemporalFact };
