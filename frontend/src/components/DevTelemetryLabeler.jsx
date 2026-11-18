import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { Check, X, HelpCircle, SkipForward, ChevronLeft, ChevronRight, UserPlus, Database } from 'lucide-react';
import { MAP_CONFIG, worldToMiniMap, minimapViewAngleDeg } from '../utils/mapUtils';
import agentData from '../utils/agentData.json';
import mapSites from '../utils/mapSites.json';

// Plain-English rule for every detector, so labelers judge the same thing the code checks.
const TAGS = {
  DRY_PEEK: { name: 'Dry peek', kind: 'flaw', rule: 'Died in the first 22 s with no teammate within 15 m and no utility used.' },
  EARLY_DEATH_NO_ALLY: { name: 'Early death, no teammate near', kind: 'flaw', rule: 'Died in the first 22 s with no teammate within 15 m (utility was used, or the data does not say).' },
  EARLY_DEATH_NO_UTILITY: { name: 'Early death, no utility', kind: 'flaw', rule: 'Died in the first 22 s with a teammate near, but no utility used.' },
  UNSUPPORTED_ENTRY: { name: 'Unsupported entry', kind: 'flaw', rule: 'Duelist on attack died in the first 25 s, no teammate within 15 m, not traded.' },
  SUPPORTED_ENTRY: { name: 'Supported entry', kind: 'good', rule: 'Duelist on attack died early, but a teammate was within 15 m or traded.' },
  ISOLATED_PLAY: { name: 'Isolated from team', kind: 'flaw', rule: 'Initiator/Controller on attack: kill or death more than 25 m from every teammate, before plant.' },
  STAYS_WITH_TEAM: { name: 'Stays with team', kind: 'good', rule: 'Initiator/Controller on attack: kill or death within 15 m of a teammate.' },
  SOLO_HOLD_VS_STACK: { name: 'Solo hold vs stack', kind: 'flaw', rule: 'Defense death with 3+ enemies within 20 m and no teammate within 25 m.' },
  ANCHORED_WITH_SUPPORT: { name: 'Anchored with support', kind: 'good', rule: 'Defense death with 3+ enemies within 20 m, but a teammate within 25 m.' },
  LETS_TEAMMATES_ENTER_FIRST: { name: 'Let teammates enter first', kind: 'flaw', rule: 'At first contact on attack, not one of the 2 teammates nearest to it.' },
  TAKES_SPACE: { name: 'Takes space', kind: 'good', rule: 'At first contact on attack, one of the 2 teammates nearest to it.' },
  DOESNT_TRADE: { name: "Didn't trade", kind: 'flaw', rule: 'Teammate died within 15 m, killer within 25 m and in view, but no trade within 5 s.' },
  TRADES_WELL: { name: 'Traded teammate', kind: 'good', rule: 'Teammate died within 15 m, killer within 25 m and in view, and was killed back within 5 s.' },
  OPENING_DUEL_LOSS: { name: 'Lost opening duel', kind: 'flaw', rule: 'Duelist died in the first kill of the round.' },
  OPENING_DUEL_WIN: { name: 'Won opening duel', kind: 'good', rule: 'Duelist got the first kill of the round.' },
  BACKSTAB_DEATH: { name: 'Killed from behind', kind: 'flaw', rule: 'Killer was more than 85° away from where the player was looking.' },
  CROSSHAIR_FACING_DUEL: { name: 'Facing the killer', kind: 'good', rule: 'Player was looking within 45° of the killer.' },
  UNSYNCED_LURK_DEATH: { name: 'Unsynced lurk death', kind: 'flaw', rule: 'Sentinel on attack died 30 m+ from every teammate, before the team made contact.' },
  SYNCED_LURK_KILL: { name: 'Synced lurk kill', kind: 'good', rule: 'Sentinel on attack got a kill 30 m+ from the team within 10 s of a team kill or plant.' },
  POST_PLANT_ISOLATION: { name: 'Post-plant far from team', kind: 'info', rule: 'After plant, kill or death more than 25 m from every teammate.' },
  REPEAT_DEATH_SPOT: { name: 'Repeat death spot', kind: 'flaw', rule: '3+ deaths in the same ~8 m spot, same side, same match.' }
};
const NOTHING_WRONG = 'CLEAN_ENGAGEMENT';

const REGIONS = ['ap', 'eu', 'na', 'kr', 'latam', 'br'];
const raterKey = 'valocoach.rater';
const inviteKey = 'valocoach.invite';

function readStored(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: name just isn't remembered */ }
}

// Every labeler call carries the invite code (the hosted backend rejects calls without it)
const api = axios.create();
api.interceptors.request.use(cfg => {
  const code = readStored(inviteKey);
  if (code) cfg.headers['X-Invite-Code'] = code;
  return cfg;
});

function agentIcon(character) {
  const key = (character || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return agentData[key]?.icon || null;
}

function formatClock(timeMs, plantTimeMs) {
  const t = Math.max(0, Math.round(timeMs / 1000));
  if (plantTimeMs != null && timeMs >= plantTimeMs) {
    return `spike ${Math.max(0, Math.round(45 - (timeMs - plantTimeMs) / 1000))}s left`;
  }
  const left = Math.max(0, 100 - t);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} in · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
}

function Radar({ snapshot, mapName }) {
  const key = (mapName || '').toLowerCase();
  const cfg = MAP_CONFIG[key];
  if (!snapshot) return <div className="aspect-square grid place-items-center text-gray-400">No snapshot for this kill.</div>;
  if (!cfg) return <div className="aspect-square grid place-items-center text-gray-400 text-center p-6">Map "{mapName}" is not calibrated yet, so positions can't be drawn.</div>;

  const pos = loc => (loc ? worldToMiniMap(loc.x, loc.y, key) : null);
  const killer = snapshot.allPlayers.find(p => p.isKiller);
  const victim = snapshot.allPlayers.find(p => p.isVictim);
  const kPos = pos(killer?.location);
  const vPos = pos(victim?.location);

  return (
    <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-black/60 border border-white/10">
      <img src={cfg.icon} alt={`${cfg.name} minimap`} className="absolute inset-0 w-full h-full object-contain opacity-70" />
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
        {kPos && vPos && <line x1={kPos.left} y1={kPos.top} x2={vPos.left} y2={vPos.top} stroke="#f87171" strokeWidth="0.5" strokeDasharray="1.5 1" />}
      </svg>
      {(mapSites[key] || []).map(site => {
        const p = pos(site);
        return p && (
          <div key={site.letter} className="absolute -translate-x-1/2 -translate-y-1/2 text-body font-bold text-white/60" style={{ left: `${p.left}%`, top: `${p.top}%` }}>{site.letter}</div>
        );
      })}
      {snapshot.allPlayers.map((p, i) => {
        const at = pos(p.location);
        if (!at) return null;
        const angle = minimapViewAngleDeg(p.view_radians, key);
        const ring = p.isSubject ? 'ring-[3px] ring-yellow-300' : (p.isAlly ? 'ring-2 ring-cyan-400' : 'ring-2 ring-rose-500');
        const icon = agentIcon(p.character);
        return (
          <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${at.left}%`, top: `${at.top}%` }} title={`${p.character}${p.isSubject ? ' (subject)' : ''}${p.isVictim ? ' (died here)' : ''}`}>
            {angle != null && (
              <div className="absolute left-1/2 top-1/2 h-[2px] w-6 origin-left" style={{ transform: `rotate(${angle}deg)`, background: p.isAlly ? '#22d3ee' : '#f43f5e' }} />
            )}
            <div className={`relative w-7 h-7 rounded-full bg-gray-900 ${ring} ${p.isVictim ? 'opacity-50 grayscale' : ''}`}>
              {icon ? <img src={icon} alt={p.character} className="w-full h-full rounded-full" /> : <span className="text-min grid place-items-center h-full">{(p.character || '?')[0]}</span>}
              {p.isVictim && <span className="absolute inset-0 grid place-items-center text-rose-400 text-section font-bold">✕</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SeedForm({ onAdded }) {
  const [riotId, setRiotId] = useState('');
  const [region, setRegion] = useState('ap');
  const [source, setSource] = useState('friend');
  const [msg, setMsg] = useState(null);
  const submit = async e => {
    e.preventDefault();
    try {
      await api.post('/api/dev/pool/seeds', { riotId, region, source });
      setMsg(`Added ${riotId}. It will be crawled soon.`);
      setRiotId('');
      onAdded();
    } catch (err) {
      setMsg(err.response?.data?.error || 'Could not add that account.');
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input value={riotId} onChange={e => setRiotId(e.target.value)} placeholder="Name#Tag" className="bg-black/40 border border-white/15 rounded-lg px-3 py-2 w-44" />
      <select value={region} onChange={e => setRegion(e.target.value)} className="bg-black/40 border border-white/15 rounded-lg px-2 py-2">
        {REGIONS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
      </select>
      <select value={source} onChange={e => setSource(e.target.value)} className="bg-black/40 border border-white/15 rounded-lg px-2 py-2">
        <option value="friend">Friend</option>
        <option value="pro">Pro</option>
        <option value="owner">Me</option>
      </select>
      <button className="bg-white/10 hover:bg-white/20 rounded-lg px-3 py-2 flex items-center gap-1.5"><UserPlus className="w-4 h-4" />Add account</button>
      {msg && <span className="text-gray-300">{msg}</span>}
    </form>
  );
}

export default function DevTelemetryLabeler() {
  const [rater, setRater] = useState(() => readStored(raterKey));
  const [nameDraft, setNameDraft] = useState('');
  const [inviteDraft, setInviteDraft] = useState(() => readStored(inviteKey));
  const [needInvite, setNeedInvite] = useState(false);
  const [focus, setFocus] = useState('');
  const [card, setCard] = useState(null);
  const [frame, setFrame] = useState(0);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const saving = useRef(false);

  const loadStatus = useCallback(() => {
    api.get('/api/dev/pool/status').then(r => setStatus(r.data)).catch(() => {});
  }, []);

  const loadNext = useCallback(async () => {
    if (!rater) return;
    setLoading(true);
    setError(null);
    setPicking(false);
    setNote('');
    try {
      const r = await api.get('/api/dev/next', { params: { rater, focus: focus || undefined } });
      if (r.status === 204 || !r.data) {
        setCard(null);
        setEmpty(true);
      } else {
        setCard(r.data);
        setFrame(r.data.focusIndex || 0);
        setEmpty(false);
      }
    } catch (err) {
      if (err.response?.status === 401) setNeedInvite(true);
      else setError('Could not load a round. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }, [rater, focus]);

  useEffect(() => { loadNext(); }, [loadNext]);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 10000);
    return () => clearInterval(t);
  }, [loadStatus]);
  // Pool empty: keep asking while the crawler refills it
  useEffect(() => {
    if (!empty) return;
    const t = setInterval(loadNext, 15000);
    return () => clearInterval(t);
  }, [empty, loadNext]);

  const save = useCallback(async (humanLabel, justified) => {
    if (!card || saving.current) return;
    saving.current = true;
    try {
      await api.post('/api/dev/verdicts', {
        candidate_id: card.candidate_id,
        matchId: card.matchId,
        round: card.round,
        elapsed: card.elapsed,
        agent: card.agent,
        side: card.side,
        role: card.role,
        map: card.map,
        rank_band: card.rank_band,
        source: card.source,
        category: card.category,
        detector_tag: card.detector_tag || 'UNFLAGGED',
        human_label: humanLabel,
        justified,
        confidence: humanLabel === 'UNSURE' ? 1 : 3,
        why: note.trim(),
        rater
      });
      setSessionCount(c => c + 1);
      loadStatus();
      await loadNext();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed. Try again.');
    } finally {
      saving.current = false;
    }
  }, [card, note, rater, loadNext, loadStatus]);

  const flagged = card?.category === 'flagged';
  const answerRight = () => save(flagged ? card.detector_tag : NOTHING_WRONG, 'Y');
  const answerWrong = () => setPicking(true);
  const answerUnsure = () => save('UNSURE', 'N');
  const pick = tag => save(tag, 'N');

  useEffect(() => {
    const onKey = e => {
      if (!card || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const n = card.timeline.length;
      if (e.key === 'ArrowLeft') setFrame(f => Math.max(0, f - 1));
      else if (e.key === 'ArrowRight') setFrame(f => Math.min(n - 1, f + 1));
      else if (e.key === 'Escape') setPicking(false);
      else if (picking) return;
      else if (e.key === '1') answerRight();
      else if (e.key === '2') answerWrong();
      else if (e.key === '3') answerUnsure();
      else if (e.key.toLowerCase() === 's') loadNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!rater || needInvite) {
    const start = e => {
      e.preventDefault();
      const n = (rater || nameDraft).trim();
      if (!n) return;
      writeStored(raterKey, n);
      writeStored(inviteKey, inviteDraft.trim());
      setNeedInvite(false);
      setRater(n);
      loadNext();
    };
    return (
      <div className="max-w-md mx-auto mt-24 p-6 rounded-2xl bg-gray-900/80 border border-white/10 text-body space-y-4">
        <h1 className="text-title font-bold">Round Labeler</h1>
        <p className="text-gray-300">Enter a name so your labels are counted separately from your friends'.</p>
        {needInvite && <p className="text-amber-300">That invite code didn't work. Ask the owner for the current one.</p>}
        <form onSubmit={start} className="space-y-2">
          {!rater && <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)} placeholder="Your name" className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2" />}
          <input value={inviteDraft} onChange={e => setInviteDraft(e.target.value)} placeholder="Invite code (hosted site only)" className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2" />
          <button className="w-full bg-cyan-500/80 hover:bg-cyan-500 text-black font-semibold rounded-lg px-4 py-2">Start</button>
        </form>
      </div>
    );
  }

  const snap = card?.timeline?.[frame]?.snapshot;
  const tagInfo = card?.detector_tag ? TAGS[card.detector_tag] : null;
  const myTotal = status?.labels?.byRater?.[rater] || 0;
  const buckets = Object.keys(status?.pool?.readyByBucket || {}).sort();

  return (
    <div className="max-w-7xl mx-auto px-4 py-4 text-body text-gray-100 space-y-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-section font-bold mr-auto">Round Labeler</h1>
        <span className="text-gray-300">You: <b className="text-white tabular-nums">{myTotal}</b> ({sessionCount} this session)</span>
        <span className="text-gray-300">Team: <b className="text-white tabular-nums">{status?.labels?.total ?? '…'}</b></span>
        <span className="text-gray-300">Ready: <b className="text-white tabular-nums">{status?.pool?.roundsReady ?? '…'}</b> from {status?.pool?.matches ?? '…'} matches</span>
        <span className={status?.crawler?.running ? 'text-emerald-400' : 'text-gray-400'}>
          {status?.crawler?.running ? 'Fetching new matches' : 'Crawler idle'}
        </span>
        <select value={focus} onChange={e => setFocus(e.target.value)} className="bg-black/40 border border-white/15 rounded-lg px-2 py-1.5">
          <option value="">All detectors (balanced)</option>
          {buckets.map(b => <option key={b} value={b}>{TAGS[b]?.name || b.toLowerCase()}</option>)}
        </select>
        <button onClick={() => setShowSources(v => !v)} className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5"><Database className="w-4 h-4" />Sources</button>
        <button onClick={() => { writeStored(raterKey, ''); setRater(''); }} className="text-gray-400 hover:text-white">{rater} · switch</button>
      </div>

      {showSources && (
        <div className="rounded-xl bg-gray-900/80 border border-white/10 p-4 space-y-3">
          <SeedForm onAdded={loadStatus} />
          <div className="text-gray-300 space-y-1">
            <div>Matches by source: {Object.entries(status?.pool?.matchesBySource || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet'}</div>
            <div>Waiting to crawl: {Object.entries(status?.crawler?.frontierBySource || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</div>
            <div>Ready rounds by rank: {Object.entries(status?.pool?.readyByRankBand || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</div>
            {status?.crawler?.lastError && <div className="text-amber-300">{status.crawler.lastError}</div>}
            <div className="text-gray-400">New matches are fetched only while someone is labeling (about 10 matches every 20 s). Pro accounts usually play on NA, EU or KR, so pick the right region.</div>
          </div>
        </div>
      )}

      {error && <div className="rounded-lg bg-rose-950/60 border border-rose-500/30 px-4 py-2 text-rose-200">{error}</div>}

      {!card && !loading && empty && (
        <div className="rounded-xl bg-gray-900/80 border border-white/10 p-8 text-center text-gray-300">
          No unlabeled rounds{focus ? ` for "${TAGS[focus]?.name || focus}"` : ''} right now. The crawler is fetching more; this page checks again every 15 s.
          {!status?.crawler?.seeds?.length && <div className="mt-2">Add a few accounts under <b>Sources</b> to give it more players to pull from.</div>}
        </div>
      )}

      {card && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Map + kill timeline */}
          <div className="lg:col-span-7 space-y-3">
            <Radar snapshot={snap} mapName={card.map} />
            <div className="flex items-center gap-2">
              <button onClick={() => setFrame(f => Math.max(0, f - 1))} className="p-2 rounded-lg bg-white/10 hover:bg-white/20" aria-label="Previous kill"><ChevronLeft className="w-4 h-4" /></button>
              <div className="flex-1 flex gap-1.5 overflow-x-auto">
                {card.timeline.map((t, i) => (
                  <button key={i} onClick={() => setFrame(i)}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-min border tabular-nums ${i === frame ? 'bg-white/20 border-white/40' : 'bg-black/30 border-white/10'} ${i === card.focusIndex ? 'ring-1 ring-yellow-300' : ''}`}>
                    {formatClock(t.timeMs, card.plantTimeMs).split(' · ')[0]} {t.snapshot?.killer?.agent} ✕ {t.snapshot?.victim?.agent}
                  </button>
                ))}
              </div>
              <button onClick={() => setFrame(f => Math.min(card.timeline.length - 1, f + 1))} className="p-2 rounded-lg bg-white/10 hover:bg-white/20" aria-label="Next kill"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <div className="text-min text-gray-400">
              Yellow ring = player being judged · cyan = their team · red = enemies · line = where each player was looking.
              Positions exist only at kill moments; players who died earlier are not shown; utility usage is not in the data.
            </div>
          </div>

          {/* Context + question */}
          <div className="lg:col-span-5 space-y-3">
            <div className="rounded-xl bg-gray-900/80 border border-white/10 p-4 space-y-1.5">
              <div className="text-section font-semibold">{card.agent} <span className="text-gray-400 font-normal">({card.role})</span> · {card.side}</div>
              <div className="text-gray-300">{card.map} · Round {card.round} · {card.rank_band}</div>
              <div className="text-gray-300 tabular-nums">Showing kill {frame + 1}/{card.timeline.length}: {formatClock(card.timeline[frame]?.timeMs || 0, card.plantTimeMs)}</div>
              {snap && <div className="text-gray-300">{snap.killer?.agent} killed {snap.victim?.agent} with {snap.killer?.weapon} · {snap.combatDistanceMeters} m</div>}
            </div>

            <div className="rounded-xl bg-gray-900/80 border border-white/10 p-4 space-y-3">
              {flagged ? (
                <>
                  <div className="text-gray-400">The detector says</div>
                  <div className={`text-section font-bold ${tagInfo?.kind === 'good' ? 'text-emerald-300' : tagInfo?.kind === 'info' ? 'text-sky-300' : 'text-amber-300'}`}>{tagInfo?.name || card.detector_tag}</div>
                  <div className="text-gray-300">{tagInfo?.rule}</div>
                </>
              ) : (
                <>
                  <div className="text-gray-400">The detector flagged nothing at this kill.</div>
                  <div className="text-gray-300">Was there a mistake (or a clear good play) it should have caught?</div>
                </>
              )}
              <details className="text-min text-gray-400">
                <summary className="cursor-pointer">Numbers it used</summary>
                <div className="mt-1 space-y-0.5 tabular-nums">
                  {Object.entries(card.evidence || {}).map(([k, v]) => <div key={k}>{k}: {v === null ? 'n/a' : String(v)}</div>)}
                </div>
              </details>

              {!picking ? (
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={answerRight} className="rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 py-3 font-semibold flex flex-col items-center gap-1">
                    <Check className="w-5 h-5" />{flagged ? 'Right call' : 'Nothing to flag'}<span className="text-min text-gray-400">key 1</span>
                  </button>
                  <button onClick={answerWrong} className="rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 py-3 font-semibold flex flex-col items-center gap-1">
                    <X className="w-5 h-5" />{flagged ? 'Wrong call' : 'Missed something'}<span className="text-min text-gray-400">key 2</span>
                  </button>
                  <button onClick={answerUnsure} className="rounded-lg bg-white/5 hover:bg-white/10 border border-white/15 py-3 font-semibold flex flex-col items-center gap-1">
                    <HelpCircle className="w-5 h-5" />Can't tell<span className="text-min text-gray-400">key 3</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-gray-300">What was it really? <span className="text-gray-500">(Esc to go back)</span></div>
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => pick(NOTHING_WRONG)} className="rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5">Nothing notable</button>
                    {Object.entries(TAGS).filter(([t]) => t !== card.detector_tag).map(([t, info]) => (
                      <button key={t} onClick={() => pick(t)} title={info.rule}
                        className={`rounded-lg px-3 py-1.5 border ${info.kind === 'good' ? 'border-emerald-500/40 hover:bg-emerald-500/20' : 'border-amber-500/40 hover:bg-amber-500/20'}`}>
                        {info.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note (why?)" className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2" />
              <button onClick={loadNext} className="flex items-center gap-1.5 text-gray-400 hover:text-white"><SkipForward className="w-4 h-4" />Skip (S)</button>
            </div>
            <div className="text-min text-gray-400">Keys: 1 / 2 / 3 answer · ← → step through the round's kills · S skip</div>
          </div>
        </div>
      )}
      {loading && !card && <div className="text-gray-400">Loading a round…</div>}
    </div>
  );
}
