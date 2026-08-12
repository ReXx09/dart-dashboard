const GAME_MODES = {
  '501':   { label: '501',   type: 'x01',  startScore: 501,  cricketNumbers: null,   description: '501' },
  '301':   { label: '301',   type: 'x01',  startScore: 301,  cricketNumbers: null,   description: '301' },
  '701':   { label: '701',   type: 'x01',  startScore: 701,  cricketNumbers: null,   description: '701' },
  'cricket': { label: 'Cricket', type: 'cricket', startScore: 0, cricketNumbers: [15,16,17,18,19,20,25], description: 'Cricket' },
  'elimination': { label: '301-Elimination', type: 'elimination', startScore: 0, targetScore: 301, cricketNumbers: null, description: '301-Elimination: bis 301 oder maximal 10 Aufnahmen' },
  'shanghai': { label: 'Shanghai', type: 'shanghai', startScore: 0, cricketNumbers: null, description: 'Shanghai' },
  'atc':    { label: 'Around the Clock', type: 'atc', startScore: 0, cricketNumbers: null, description: 'Around the Clock' },
  'split':  { label: 'Split', type: 'split', startScore: 0, cricketNumbers: null, description: 'Split Score' }
};

const CHECKOUT_RULES = {
  'single': { label: 'Single Out', description: 'Beliebiger Wurf auf 0' },
  'double': { label: 'Double Out', description: 'Nur Double auf 0' },
  'master': { label: 'Master Out', description: 'Double oder Triple auf 0' }
};

const DEFAULT_MODE = '501';
const DEFAULT_CHECKOUT_RULE = 'double';

function normalizeModeKey(mode) {
  const key = String(mode || DEFAULT_MODE).trim();
  return GAME_MODES[key] ? key : DEFAULT_MODE;
}

function getModeConfig(mode) {
  return GAME_MODES[normalizeModeKey(mode)] || GAME_MODES[DEFAULT_MODE];
}

function getStartScoreForMode(mode) {
  return getModeConfig(mode).startScore;
}

function getCricketNumbersForMode(mode) {
  const def = getModeConfig(mode);
  return def && def.type === 'cricket' ? [...def.cricketNumbers] : null;
}

module.exports = {
  GAME_MODES,
  CHECKOUT_RULES,
  DEFAULT_MODE,
  DEFAULT_CHECKOUT_RULE,
  normalizeModeKey,
  getModeConfig,
  getStartScoreForMode,
  getCricketNumbersForMode
};
