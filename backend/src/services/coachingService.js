const { GoogleGenerativeAI } = require('@google/generative-ai');
const { isSupportedQueue } = require('../config/telemetryConfig');
const { getRoleForAgent, getRoleForMatch } = require('./agentRoleService');
const { getPlayerTeam, getSideForRound } = require('./situationDetectors');

// Map names the narrator validator checks for; a name not in the evidence packet means a hallucination
const ALL_VALORANT_MAPS = ['ascent', 'bind', 'haven', 'split', 'lotus', 'sunset', 'abyss', 'corrode', 'icebox',
  'breeze', 'fracture', 'pearl', 'summit'];

// In-Memory Cache (TTL: 30 minutes)
const analysisCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function getCachedAnalysis(cacheKey) {
  const cached = analysisCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    analysisCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCachedAnalysis(cacheKey, data) {
  analysisCache.set(cacheKey, {
    timestamp: Date.now(),
    data
  });
}

function detectPrimaryRole(matches) {
  const roleCounts = { Duelist: 0, Initiator: 0, Controller: 0, Sentinel: 0 };
  for (const m of matches) {
    const agent = (m.agent || '').toLowerCase().trim();
    const role = getRoleForAgent(agent);
    if (role) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
  }
  let topRole = 'Duelist';
  let maxCount = -1;
  for (const [r, count] of Object.entries(roleCounts)) {
    if (count > maxCount) {
      maxCount = count;
      topRole = r;
    }
  }
  return topRole;
}

function detectPrimaryMap(matches) {
  const mapCounts = {};
  for (const m of matches) {
    const map = m.map || 'Ascent';
    mapCounts[map] = (mapCounts[map] || 0) + 1;
  }
  let topMap = 'Ascent';
  let maxCount = -1;
  for (const [map, count] of Object.entries(mapCounts)) {
    if (count > maxCount) {
      maxCount = count;
      topMap = map;
    }
  }
  return topMap;
}

// One line per habit for "(b) Why it matters": tactical consequence only, no invented numbers.
const WHY_IT_MATTERS = {
  TRADES_WELL: 'Fast trades turn a lost duel into an even exchange, which is how man-advantage rounds are kept.',
  DOESNT_TRADE: 'An untraded death hands the enemy a free man advantage in the fight that decides the site.',
  STAYS_WITH_TEAM: 'Staying within trade range means every duel you take can be answered by a teammate.',
  ISOLATED_PLAY: 'Fighting far from your team means your deaths cannot be traded and your utility supports no one.',
  TAKES_SPACE: 'Being first to contact gives your team the information and space to execute.',
  LETS_TEAMMATES_ENTER_FIRST: 'When entry falls to others, your team hits with less firepower at the front.',
  SUPPORTED_ENTRY: 'Entries with a teammate close behind get traded even when the first duel is lost.',
  UNSUPPORTED_ENTRY: 'Solo entries that die untraded start the round 4v5 with nothing gained.',
  ANCHORED_WITH_SUPPORT: 'Holding with a teammate in range forces attackers to win two fights instead of one.',
  SOLO_HOLD_VS_STACK: 'Holding alone against a stack usually trades your life for nothing; falling back keeps a retake alive.',
  OPENING_DUEL_WIN: 'Winning the opening duel starts the round 5v4, which swings round win odds the most.',
  OPENING_DUEL_LOSS: 'Losing the opening duel starts the round 4v5.',
  SYNCED_LURK_KILL: 'Lurk kills timed with the team hit split the defense when it matters.',
  UNSYNCED_LURK_DEATH: 'A lurk death before the team makes contact removes a player without pulling any rotations.',
  EARLY_DEATH_NO_ALLY: 'Early deaths with no teammate near cannot be traded and leave the round 4v5 early.'
};

/**
 * Layer C Narrator Post-Validation: the debrief may only mention maps and round numbers that exist in the
 * evidence packet (replay cues + active map). Anything else, an error or a cut-off answer -> deterministic text.
 */
function postValidateDebrief(debriefText, masterBlob) {
  const cues = masterBlob.telemetry_intelligence?.replay_cue_sheet || [];
  const allowedMaps = new Set([(masterBlob.context?.map || '').toLowerCase(), ...cues.map(c => (c.map || '').toLowerCase())]);
  const allowedRounds = new Set(cues.map(c => c.round));

  let isValid = Boolean(debriefText && typeof debriefText === 'string' && !debriefText.startsWith('Gemini LLM Provider Error'));
  if (isValid) {
    const textLower = debriefText.toLowerCase();
    // Capitalized whole words only: "split the defense" is English, "Split" is the map
    const badMap = ALL_VALORANT_MAPS.find(m => new RegExp(`\\b${m[0].toUpperCase()}${m.slice(1)}\\b`).test(debriefText) && !allowedMaps.has(m));
    const badRound = [...textLower.matchAll(/\b(?:round\s*#?|r)(\d{1,2})\b/g)].map(m => Number(m[1])).find(r => !allowedRounds.has(r));
    if (badMap || badRound != null) {
      console.warn(`[Narrator Validation] Unknown ${badMap ? `map "${badMap}"` : `round ${badRound}`} in debrief. Using deterministic template.`);
      isValid = false;
    }
  }
  return isValid ? debriefText : buildDeterministicDebrief(masterBlob);
}

/** Task-list format (a)/(b)/(c), built only from computed values. Strengths first, max 3 findings. */
function buildDeterministicDebrief(masterBlob) {
  const habits = masterBlob.habits || [];
  const cues = masterBlob.telemetry_intelligence?.replay_cue_sheet || [];
  const watchCell = masterBlob.telemetry_intelligence?.watch_item?.cell;
  const isShown = h => (h.tier === 'pattern' || h.tier === 'strong habit') && h.k > 0;
  const positives = habits.filter(h => h.polarity === 'positive' && isShown(h));
  const flaws = habits.filter(h => h.polarity === 'flaw' && isShown(h));
  const watch = habits.find(h => h.cell === watchCell);
  const findings = [...positives.slice(0, 2), ...flaws.slice(0, 2), ...(flaws.length ? [] : (watch ? [watch] : []))].slice(0, 3);
  const cueFor = h => cues.find(c => c.cell === h.cell);
  const peer = h => (h.peer_baseline?.p0_pct != null ? `, players like you ${h.peer_baseline.p0_pct}%` : '');

  const lines = ['### (a) What the data shows'];
  if (!findings.length) {
    lines.push(`- Across ${masterBlob.total_matches_analyzed} matches nothing stands out from players in your own lobbies yet.`);
  }
  for (const h of findings) {
    const c = cueFor(h);
    const label = h.cell === watchCell ? ' (worth watching, not a pattern yet)' : '';
    lines.push(`- **${h.title}** as ${h.role} on ${h.side}${label}: ${h.ratePct}% (${h.k} of ${h.n}${peer(h)}).` +
      (c ? ` See R${c.round}, ${c.map}, ${c.clock_display}.` : ''));
  }
  lines.push('', '### (b) Why it matters');
  for (const h of findings) if (WHY_IT_MATTERS[h.id]) lines.push(`- ${WHY_IT_MATTERS[h.id]}`);
  if (!findings.length) lines.push('- More matches on one role make differences from your lobby measurable.');

  lines.push('', '### (c) Next session');
  const focus = flaws[0] || watch;
  if (focus && focus.peer_baseline?.p0_pct != null) {
    lines.push(`- Focus: ${focus.title} as ${focus.role} on ${focus.side}. Target: at or below ${focus.peer_baseline.p0_pct}% over your next 10 matches (now ${focus.ratePct}%).`);
  } else if (positives[0]) {
    lines.push(`- Keep ${positives[0].title} as ${positives[0].role} on ${positives[0].side} at ${positives[0].ratePct}% or higher over your next 10 matches.`);
  } else {
    lines.push('- Play 10 more matches on your main role so the report can compare you with confidence.');
  }
  return lines.join('\n');
}

exports.generateCoachingDebrief = async (region, name, tag, requestedMap = null, requestedRole = null) => {
  const riotId = `${name}#${tag}`.toLowerCase();
  const cacheKey = `${region}:${riotId}:${(requestedMap || 'auto').toLowerCase()}:${(requestedRole || 'auto').toLowerCase()}`;

  // Check cache first
  const cached = getCachedAnalysis(cacheKey);
  if (cached) {
    return cached;
  }
  
  const storeService = require('./storeService');

  // 1. Fetch Player and up to 100 recent Matches (Store with MongoDB / In-memory resilience)
  let player = await storeService.getPlayer(riotId);
  let matches = await storeService.getMatches(riotId, 100);

  // Never fetch history inside a request: start (or join) the background sync and tell the client to poll
  if (!matches || matches.length === 0) {
    const { triggerBackgroundSync } = require('./ingestionQueue');
    const progress = triggerBackgroundSync(region, name, tag);
    const err = new Error('SYNC_IN_PROGRESS');
    err.code = 'SYNC_IN_PROGRESS';
    err.progress = progress;
    throw err;
  }

  player = player || { riotId, name, tag, currentRank: null };

  // Every downstream card (map list, radar, trends, economy) sees supported 5v5 queues only
  const skippedMatches = matches.filter(m => !isSupportedQueue(m).supported)
    .map(m => ({ matchId: m.matchId, reason: isSupportedQueue(m).reason }));
  matches = matches.filter(m => isSupportedQueue(m).supported);
  if (matches.length === 0) {
    const err = new Error('NO_SUPPORTED_MATCHES');
    err.code = 'NO_SUPPORTED_MATCHES';
    throw err;
  }

  // 2. Auto-Detect Primary Map and Role if not explicitly provided
  const primaryMap = requestedMap && requestedMap !== 'auto' 
    ? requestedMap 
    : detectPrimaryMap(matches);
  const primaryRole = requestedRole && requestedRole !== 'auto' 
    ? requestedRole 
    : detectPrimaryRole(matches);

  // 2. Trend Engine (Adaptive Rolling Average Deltas)
  const trends = {};
  if (matches.length >= 2) {
    const windowSize = Math.max(1, Math.floor(matches.length / 2));
    const latestMatches = matches.slice(0, windowSize);
    const oldestMatches = matches.slice(windowSize, windowSize * 2);

    const calcAvg = (arr, metricFn) => arr.length ? arr.reduce((acc, m) => acc + metricFn(m), 0) / arr.length : 0;
    
    // HS%
    const latestHS = calcAvg(latestMatches, m => m.headshotPct || 0);
    const oldestHS = calcAvg(oldestMatches, m => m.headshotPct || 0);
    trends.hs_pct = {
      delta: Number((latestHS - oldestHS).toFixed(3)),
      direction: latestHS >= oldestHS ? 'improving' : 'declining',
      window: windowSize
    };

    // ACS
    const latestACS = calcAvg(latestMatches, m => m.acs || 0);
    const oldestACS = calcAvg(oldestMatches, m => m.acs || 0);
    trends.acs = {
      delta: Number((latestACS - oldestACS).toFixed(1)),
      direction: latestACS >= oldestACS ? 'improving' : 'declining',
      window: windowSize
    };
  } else {
    trends.note = "Trend Engine requires at least 2 matches to compute delta trends.";
  }

  // 2. Rank Extraction (Requirement 2)
  // Priority: Most recent competitive match payload (verify tier field name)
  let verifiedRank = null;
  let rankSource = 'none';

  // Queue id, not mode name: skirmish_2v2 reports mode "Competitive" but has no rank
  const compMatches = matches.filter(m => isSupportedQueue(m).queue === 'competitive');

  if (compMatches.length > 0) {
    const latestComp = compMatches[0];
    const pRecord = (latestComp.all_players || []).find(p => 
      (player.puuid && p.puuid === player.puuid) ||
      (`${p.name}#${p.tag}`.toLowerCase() === riotId)
    );
    const tierFound = pRecord?.tier || latestComp.tier;
    if (tierFound && tierFound !== 'Unranked' && tierFound !== 'Unknown') {
      verifiedRank = tierFound;
      rankSource = 'latest_competitive_match';
    }
  }

  // Fallback to MMR endpoint only if competitive match had no tier
  if (!verifiedRank && player.currentRank && player.currentRank !== 'Unranked' && player.currentRank !== 'Unknown') {
    verifiedRank = player.currentRank;
    rankSource = 'mmr_endpoint_fallback';
  }

  if (!verifiedRank) {
    verifiedRank = 'Rank unavailable';
    rankSource = 'none';
  }

  console.log(`[Rank Resolver] Resolved rank for ${riotId}: "${verifiedRank}" (Source: ${rankSource})`);
  player.currentRank = verifiedRank;

  // 3. Spatial Analytics Extraction
  const availableMaps = [...new Set(matches.map(m => m.map).filter(Boolean))];
  const requestedMapNormalized = (primaryMap || 'ascent').toLowerCase();
  
  // Prefer matches on requested map, or fallback to all matches
  const targetMapMatches = matches.filter(m => (m.map || '').toLowerCase() === requestedMapNormalized);
  const activeMapName = targetMapMatches.length > 0 ? targetMapMatches[0].map : (availableMaps[0] || 'Ascent');
  const spatialMatches = matches.filter(m => (m.map || '').toLowerCase() === activeMapName.toLowerCase());

  const deaths = [];
  const kills = [];

  for (const m of spatialMatches) {
    const team = getPlayerTeam(m, player.puuid, player.riotId);
    const role = getRoleForMatch(m, player.riotId, player.puuid) || null;
    for (const k of (m.kill_events || [])) {
      const side = getSideForRound(team, k.round); // adapter kill rounds are 1-based
      if (!k.victim_death_location || k.victim_death_location.x == null || k.victim_death_location.y == null) continue;
      const isVictim = (player.puuid && k.victim_puuid === player.puuid) ||
                       (k.victim_display_name && k.victim_display_name.toLowerCase() === player.riotId.toLowerCase());
      const isKiller = (player.puuid && k.killer_puuid === player.puuid) ||
                       (k.killer_display_name && k.killer_display_name.toLowerCase() === player.riotId.toLowerCase());

      if (isVictim) {
        deaths.push({
          x: k.victim_death_location.x,
          y: k.victim_death_location.y,
          round: k.round ?? null,
          side,
          role,
          killer: k.killer_display_name || null,
          weapon: k.damage_weapon_name || null,
          matchId: m.matchId
        });
      }
      // A kill is plotted where the player stood when firing (their snapshot), not where the enemy fell
      const shooter = isKiller && (k.player_locations_on_kill || []).find(p =>
        (player.puuid && p.player_puuid === player.puuid) ||
        (p.player_display_name && p.player_display_name.toLowerCase() === player.riotId.toLowerCase()));
      if (shooter?.location) {
        kills.push({
          x: shooter.location.x,
          y: shooter.location.y,
          round: k.round ?? null,
          side,
          role,
          victim: k.victim_display_name || null,
          weapon: k.damage_weapon_name || null,
          matchId: m.matchId
        });
      }
    }
  }

  const spatialData = {
    active_map: activeMapName,
    requested_map: primaryMap || null,
    requested_map_has_data: targetMapMatches.length > 0,
    available_maps: availableMaps,
    deaths,
    kills,
    map_stats: {
      matches_count: spatialMatches.length,
      kills_count: kills.length,
      deaths_count: deaths.length,
      kd_ratio: deaths.length > 0 ? Number((kills.length / deaths.length).toFixed(2)) : kills.length
    }
  };

  // 5. Macro-Pattern Analytics (Session Fatigue & Economy Discipline & Telemetry Intelligence)
  const { analyzeEconomy } = require('./economyService');
  const { computeMatchTrends, evaluateSessionFatigue } = require('./trendsService');

  const sessionAnalytics = evaluateSessionFatigue(matches, riotId, player.puuid);
  const economyAnalytics = analyzeEconomy(matches, riotId, player.puuid);

  const telemetryIntelligenceService = require('./telemetryIntelligenceService');
  const telemetryIntelligence = telemetryIntelligenceService.analyzeTelemetry(
    matches, 
    riotId, 
    player.puuid, 
    player.currentRank
  );

  // Habit trend follows the habit the report leads with: first shown flaw, else the watch item, else first strength
  const shownHabits = (telemetryIntelligence?.habits || []).filter(h => (h.tier === 'pattern' || h.tier === 'strong habit') && h.k > 0);
  const keyCell = shownHabits.find(h => h.polarity === 'flaw')?.cell || telemetryIntelligence?.watch_item?.cell || shownHabits[0]?.cell || null;
  const trendsAnalytics = computeMatchTrends(matches, riotId, player.puuid, keyCell);

  // Matches per role (agent played in each match), for the header
  const roleMix = {};
  for (const m of matches) {
    const r = getRoleForMatch(m, riotId, player.puuid) || 'Unknown';
    roleMix[r] = (roleMix[r] || 0) + 1;
  }

  // One goal for the next session: first shown flaw, else the "worth watching" item, else keep the top strength
  const watchHabit = (telemetryIntelligence?.habits || []).find(h => h.cell === telemetryIntelligence?.watch_item?.cell);
  const focusHabit = shownHabits.find(h => h.polarity === 'flaw') || watchHabit;
  const keepHabit = shownHabits.find(h => h.polarity === 'positive');
  const nextFocus = focusHabit && focusHabit.peer_baseline?.p0_pct != null
    ? { type: 'reduce', cell: focusHabit.cell, title: focusHabit.title, role: focusHabit.role, side: focusHabit.side,
        current_pct: focusHabit.ratePct, target_pct: focusHabit.peer_baseline.p0_pct, proven: focusHabit !== watchHabit }
    : (keepHabit ? { type: 'keep', cell: keepHabit.cell, title: keepHabit.title, role: keepHabit.role, side: keepHabit.side,
        current_pct: keepHabit.ratePct, target_pct: keepHabit.ratePct, proven: true } : null);

  // Filter habits for dominant role
  const rawHabits = telemetryIntelligence?.habits || [];
  const roleFilteredHabits = rawHabits.filter(h => h.tier !== 'not applicable for role');


  // 7. Assemble the Master JSON (Single honest source of truth)
  const masterBlob = {
    player: riotId,
    total_matches_analyzed: matches.length,
    total_matches_skipped: skippedMatches.length,
    skipped_matches: skippedMatches,
    actual_rank: verifiedRank,
    rank_source: rankSource,
    trends: trendsAnalytics,
    spatial_data: spatialData,
    session_analytics: sessionAnalytics,
    economy_analytics: economyAnalytics,
    // replay_cue_sheet inside is already role-aware per match (habit engine + isFlawForRole)
    telemetry_intelligence: telemetryIntelligence,
    habits: roleFilteredHabits,
    role_mix: roleMix,
    next_focus: nextFocus,
    context: {
      map: primaryMap,
      role: primaryRole,
      is_auto_detected: (!requestedMap || requestedMap === 'auto') && (!requestedRole || requestedRole === 'auto'),
      primary_map: primaryMap,
      primary_role: primaryRole
    }
  };

  // 8. Gemini LLM Orchestration
  let debriefText = "Tactical debrief generated from verified telemetry.";
  try {
    const key = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
    if (key) {
      const genAI = new GoogleGenerativeAI(key);
      const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } } // 2.5 Flash counts thinking against the cap
      });

      // Strict evidence packet without fake impacts or persona intro
      const prompt = `
        You are a high-ELO tactical coach debriefing a player named ${masterBlob.player} on map: ${masterBlob.context.map} as role: ${masterBlob.context.role} (Rank: ${masterBlob.actual_rank}).
        Match window: Based on ${masterBlob.total_matches_analyzed} matches.
        
        CRITICAL RULES:
        - NO persona intro ("I've seen countless agents...").
        - Blunt, practical tone. Strengths first. Maximum ~200 words.
        - Wording must match tier: occasional habits must NEVER be described with "frequently" or "often".
        - Do not cite uncalibrated numeric impacts.
        - Strict 3-section format:
          ### (a) What the Data Shows
          Up to 3 findings, each citing concrete evidence numbers and one specific round replay cue [R#, map, elapsed/on-clock time].
          ### (b) Why It Matters
          Tactical impact of these specific tendencies for a ${masterBlob.context.role} on ${masterBlob.context.map}.
          ### (c) Next Session
          Restate next_focus from the packet exactly: its habit, role, side, current % and target %, over the next 10 matches.
          If next_focus.proven is false, say it is not a proven habit yet. Never invent any other metric or count.
        
        Evidence Packet:
        ${JSON.stringify({
          player: masterBlob.player,
          actual_rank: masterBlob.actual_rank,
          habits: (masterBlob.habits || []).filter(h => h.tier === 'pattern' || h.tier === 'strong habit').slice(0, 6).map(h => ({
            id: h.id,
            title: h.title,
            role: h.role,
            side: h.side,
            tier: h.tier,
            ratePct: h.ratePct,
            k: h.k,
            n: h.n,
            peer_p0: h.peer_baseline?.p0_pct
          })),
          trade_metrics: masterBlob.telemetry_intelligence?.trade_metrics?.you_trade_teammates,
          replay_cues: (masterBlob.telemetry_intelligence?.replay_cue_sheet || []).slice(0, 6).map(c => ({
            habit: c.habit, role: c.role, side: c.side, map: c.map, round: c.round, clock: c.clock_display
          })),
          next_focus: masterBlob.next_focus,
          session_fatigue: masterBlob.session_analytics?.recommendation,
          context: masterBlob.context
        }, null, 2)}
      `;

      const result = await model.generateContent(prompt);
      // A cut-off answer is worse than the deterministic template: postValidate falls back on this marker
      const finish = result.response.candidates?.[0]?.finishReason;
      debriefText = finish && finish !== 'STOP'
        ? `Gemini LLM Provider Error: incomplete response (${finish})`
        : result.response.text();
    }
  } catch (error) {
    console.error("Gemini Error:", error);
    debriefText = `Gemini LLM Provider Error: ${error.message}. Please verify your API Key or Network permissions.`;
  }

  // Post-validate debrief against evidence packet
  debriefText = postValidateDebrief(debriefText, masterBlob);

  const output = {
    analysis: masterBlob,
    debrief: debriefText
  };

  // Cache result
  setCachedAnalysis(cacheKey, output);

  return output;
};

/**
 * Interactive Coach Chat with Gemini & Function Calling Tools (Requirement 7)
 */
exports.chatWithCoach = async ({ riotId, messages, contextData }) => {
  const key = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
  if (!key) {
    throw new Error("Gemini API key is not configured.");
  }

  const genAI = new GoogleGenerativeAI(key);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'get_habits',
          description: "Returns observed behavioral habits, rates, sample sizes (k/n), and peer comparisons for the player's primary role and side.",
          parameters: {
            type: 'OBJECT',
            properties: {}
          }
        },
        {
          name: 'get_round',
          description: "Returns replay moments, kills and deaths for one round of one match. matchId comes from get_habits cues.",
          parameters: {
            type: 'OBJECT',
            properties: {
              matchId: { type: 'STRING', description: 'Match id from a replay cue' },
              round: { type: 'NUMBER', description: 'Round number (e.g. 1-26)' }
            },
            required: ['matchId', 'round']
          }
        },
        {
          name: 'get_deaths',
          description: "Returns fatal engagement locations, distances, and circumstances filtered by map, side, and role.",
          parameters: {
            type: 'OBJECT',
            properties: {
              map: { type: 'STRING', description: 'Map name, e.g. Ascent, Abyss' },
              side: { type: 'STRING', description: 'Side: attack or defense' },
              role: { type: 'STRING', description: 'Role: Duelist, Sentinel, Initiator, Controller' }
            }
          }
        }
      ]
    }
  ];

  const model = genAI.getGenerativeModel({ 
    model: modelName,
    tools,
    generationConfig: { maxOutputTokens: 1024, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } } // 2.5 Flash counts thinking against the cap
  });

  const chat = model.startChat({
    history: []
  });

  const systemContext = `
    You are ValoCoach, a tactical coach speaking directly with player: ${riotId || 'Student'}.
    Rank: ${contextData?.actual_rank || 'Rank unavailable'}. Role: ${contextData?.context?.role || 'Flex'}. Map: ${contextData?.context?.map || 'unknown'}.
    
    STRICT RULES (Requirement 7):
    - Answer ONLY from tool results (get_habits, get_round, get_deaths) or verified facts in the conversation.
    - CITE specific rounds and timestamps [e.g. Round 4 at 0:24 elapsed].
    - Occasional habits must NEVER be described with "frequently" or "often".
    - Do NOT cite uncalibrated numeric impacts (e.g. do not say "-24%" or "+0.2 rounds/match").
    - If you do not have data on a particular question, say: "I don't have data on that."
    - Keep answers blunt, tactical, and under ~150 words.
  `;

  // Build dialogue
  const conversationHistory = (messages || []).map(m => `${m.role === 'user' ? 'Student' : 'Coach'}: ${m.content}`).join('\n');
  const initialPrompt = `${systemContext}\n\nConversation:\n${conversationHistory}\n\nCoach:`;

  try {
    let result = await chat.sendMessage(initialPrompt);
    const functionCalls = result.response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      let toolData = {};

      if (call.name === 'get_habits') {
        const cues = contextData?.telemetry_intelligence?.replay_cue_sheet || [];
        toolData = {
          habits: (contextData?.habits || []).filter(h => h.tier !== 'not applicable for role' && h.n > 0).map(h => ({
            title: h.title,
            role: h.role,
            side: h.side,
            tier: h.tier,
            rate: `${h.k}/${h.n} (${h.ratePct}%)`,
            peer_baseline: h.peer_baseline?.p0_pct != null ? `${h.peer_baseline.p0_pct}%` : 'no baseline',
            cues: cues.filter(c => c.cell === h.cell).map(c => ({ matchId: c.matchId, round: c.round, map: c.map, clock: c.clock_display }))
          }))
        };
      } else if (call.name === 'get_round') {
        const roundNum = Number(call.args?.round);
        const matchId = String(call.args?.matchId || '');
        const inRound = x => x.round === roundNum && x.matchId === matchId;
        const cues = (contextData?.telemetry_intelligence?.replay_cue_sheet || []).filter(inRound);
        const kills = (contextData?.spatial_data?.kills || []).filter(inRound);
        const deaths = (contextData?.spatial_data?.deaths || []).filter(inRound);
        toolData = cues.length || kills.length || deaths.length
          ? { matchId, round: roundNum, cues, kills, deaths }
          : { error: 'No data for that match and round.' };
      } else if (call.name === 'get_deaths') {
        const { map, side, role } = call.args || {};
        const sd = contextData?.spatial_data || {};
        const eq = (a, b) => !b || String(a || '').toLowerCase() === String(b).toLowerCase();
        // Positions are only loaded for the active map; any other map has no data here
        const deaths = eq(sd.active_map, map) ? (sd.deaths || []).filter(d => eq(d.side, side) && eq(d.role, role)) : [];
        toolData = { map: sd.active_map, total: deaths.length, deaths: deaths.slice(0, 15) };
      }

      // Send tool response to model
      const followUp = await chat.sendMessage([
        {
          functionResponse: {
            name: call.name,
            response: toolData
          }
        }
      ]);
      return { reply: followUp.response.text() };
    }

    return { reply: result.response.text() };
  } catch (err) {
    console.warn("[chatWithCoach] Tool call or Gemini error, using grounded fallback:", err.message);
    // Grounded fallback
    const latestUserMsg = (messages[messages.length - 1]?.content || '').toLowerCase();
    const cues = contextData?.telemetry_intelligence?.replay_cue_sheet || [];
    const habits = contextData?.habits || [];

    if (latestUserMsg.includes('habit') || latestUserMsg.includes('playstyle')) {
      const topHabit = habits.find(h => (h.tier === 'pattern' || h.tier === 'strong habit') && h.k > 0);
      return { 
        reply: topHabit 
          ? `Your clearest habit is ${topHabit.title} as ${topHabit.role} on ${topHabit.side} (${topHabit.tier}): ${topHabit.k} of ${topHabit.n} (${topHabit.ratePct}%). ${topHabit.narrative}`
          : "I don't have data on that."
      };
    }
    if (latestUserMsg.includes('round') || latestUserMsg.includes('cue')) {
      const topCue = cues[0];
      return {
        reply: topCue
          ? `Round ${topCue.round} on ${topCue.map} (${topCue.clock_display}): ${topCue.habit_title}, as ${topCue.role} on ${topCue.side}.`
          : "I don't have data on that."
      };
    }
    return {
      reply: "I don't have data on that."
    };
  }
};
exports._test = { postValidateDebrief, buildDeterministicDebrief };
