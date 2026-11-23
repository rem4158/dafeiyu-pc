/**
 * @param {object} settings
 */
function resolveMemorySettings(settings) {
  return {
    enabled: settings.memory?.enabled !== false,
    maxRecentMessages: settings.memory?.maxRecentMessages ?? 30,
    maxContextFacts: settings.memory?.maxContextFacts ?? 8,
    maxContextEvents: settings.memory?.maxContextEvents ?? 5,
    tokenBudget: settings.memory?.tokenBudget ?? 800,
  };
}

module.exports = { resolveMemorySettings };
