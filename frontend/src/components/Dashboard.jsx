import React, { useState } from 'react';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ChevronDown, ChevronUp, Send, Loader2, Film } from 'lucide-react';
import MapHeatmap from './MapHeatmap';

// Only tiers that beat same-role, same-side peers count as habits; "occasional" is normal play.
const isShown = h => (h.tier === 'pattern' || h.tier === 'strong habit') && h.k > 0;
const ROLES = ['Duelist', 'Initiator', 'Controller', 'Sentinel'];

// Plain names and one-sentence explanations, so a new player never needs the detector jargon.
const PLAIN = {
  TRADES_WELL: ['Trading teammates', h => `When a teammate died near you with the killer in front of you, you killed the killer within 5 s ${h.k} of ${h.n} times.`],
  DOESNT_TRADE: ['Missed trades', h => `When a teammate died near you with the killer in front of you, you did not kill them back within 5 s ${h.k} of ${h.n} times.`],
  STAYS_WITH_TEAM: ['Staying in trade range', h => `Your kills and deaths on attack happened within 15 m of a teammate ${h.k} of ${h.n} times.`],
  ISOLATED_PLAY: ['Fighting far from your team', h => `Your kills and deaths on attack happened more than 25 m from every teammate ${h.k} of ${h.n} times.`],
  TAKES_SPACE: ['Taking space', h => `You were one of the two teammates closest to the first fight in ${h.k} of ${h.n} attack rounds.`],
  LETS_TEAMMATES_ENTER_FIRST: ['Letting others go first', h => `At least two teammates were closer to the first fight than you in ${h.k} of ${h.n} attack rounds.`],
  SUPPORTED_ENTRY: ['Supported entries', h => `When you died early on attack, a teammate was within 15 m or traded you ${h.k} of ${h.n} times.`],
  UNSUPPORTED_ENTRY: ['Solo entries', h => `When you died early on attack, no teammate was within 15 m and nobody traded you ${h.k} of ${h.n} times.`],
  ANCHORED_WITH_SUPPORT: ['Holding with support', h => `When 3+ attackers reached you, a teammate was within 25 m ${h.k} of ${h.n} times.`],
  SOLO_HOLD_VS_STACK: ['Holding alone vs a stack', h => `When 3+ attackers reached you, no teammate was within 25 m ${h.k} of ${h.n} times. Falling back to retake is often better.`],
  OPENING_DUEL_WIN: ['Winning first duels', h => `You won the round's first duel ${h.k} of the ${h.n} times you were in it.`],
  OPENING_DUEL_LOSS: ['Losing first duels', h => `You lost the round's first duel ${h.k} of the ${h.n} times you were in it.`],
  SYNCED_LURK_KILL: ['Well-timed lurk kills', h => `Your lurk kills (30 m+ from the team) came within 10 s of a team kill or plant ${h.k} of ${h.n} times.`],
  UNSYNCED_LURK_DEATH: ['Early lurk deaths', h => `You died lurking before your team made contact ${h.k} of ${h.n} times.`],
  EARLY_DEATH_NO_ALLY: ['Early deaths alone', h => `You died in the first 22 s with no teammate within 15 m in ${h.k} of ${h.n} rounds.`],
  DRY_PEEK: ['Dry peeks', h => `You died in the first 22 s alone and without utility in ${h.k} of ${h.n} rounds.`],
  EARLY_DEATH_NO_UTILITY: ['Early deaths without utility', h => `You died in the first 22 s without using utility in ${h.k} of ${h.n} rounds.`],
  BACKSTAB_DEATH: ['Killed from behind', h => `You were killed from more than 85° off your aim ${h.k} of ${h.n} times.`],
  CROSSHAIR_FACING_DUEL: ['Facing your killer', h => `You were aiming within 45° of your killer ${h.k} of ${h.n} times.`],
  POST_PLANT_ISOLATION: ['Far from team after plant', h => `After the plant you fought more than 25 m from every teammate ${h.k} of ${h.n} times.`]
};
const nameOf = h => h.title; // backend titles are the plain names
const sentenceOf = h => PLAIN[h.id]?.[1](h) || h.narrative;
const evidenceOf = n => (n >= 80 ? 'Strong evidence' : n >= 30 ? 'Moderate evidence' : 'Early evidence');
const fmtDate = d => { try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };

function CompareBars({ h }) {
  const peer = h.peer_baseline?.p0_pct;
  const bar = (label, pct, cls) => (
    <div className="flex items-center gap-2 text-secondary">
      <span className="w-36 shrink-0 text-gray-400">{label}</span>
      <div className="flex-1 h-2 rounded bg-white/10 overflow-hidden"><div className={`h-full ${cls}`} style={{ width: `${Math.min(100, pct || 0)}%` }} /></div>
      <span className="w-12 text-right tabular-nums">{pct == null ? 'n/a' : `${pct}%`}</span>
    </div>
  );
  return (
    <div className="space-y-1">
      {bar('You', h.ratePct, h.polarity === 'flaw' ? 'bg-amber-400' : 'bg-emerald-400')}
      {bar('Players like you', peer, 'bg-gray-400')}
    </div>
  );
}

function Moments({ cues }) {
  if (!cues?.length) return <p className="text-secondary text-gray-400">No replay moments saved for this one.</p>;
  return (
    <ul className="space-y-1.5">
      {cues.map((c, i) => (
        <li key={i} className="text-secondary text-gray-300 flex flex-wrap gap-x-2">
          <Film className="w-4 h-4 text-gray-500 mt-0.5" />
          <span className="tabular-nums">{fmtDate(c.playedAt || c.played_at)}</span>
          <span>{c.map}</span>
          <span>{c.agent}</span>
          {c.score && <span className="tabular-nums">{c.score}</span>}
          <span className="text-white">Round {c.round}, {c.clockTime || c.clock_display}</span>
        </li>
      ))}
    </ul>
  );
}

function HabitCard({ h, label }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl bg-black/30 border border-white/10 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-body font-semibold text-white">{nameOf(h)} <span className="text-secondary font-normal text-gray-400">as {h.role} on {h.side}</span></div>
        <span className="text-min text-gray-300 bg-white/10 rounded px-2 py-0.5">{label || evidenceOf(h.n)}</span>
      </div>
      <p className="text-secondary text-gray-300">{sentenceOf(h)}</p>
      <CompareBars h={h} />
      <button onClick={() => setOpen(o => !o)} className="text-secondary text-gray-300 hover:text-white flex items-center gap-1">
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />} Show me ({h.exampleCues?.length || 0} replay moments)
      </button>
      {open && <Moments cues={h.exampleCues} />}
    </div>
  );
}

function Panel({ title, children, right }) {
  return (
    <section className="glass-panel p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-section font-bold text-white">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="text-secondary text-gray-400 bg-black/20 rounded-lg p-4">{children}</p>;
}

function DebriefText({ text }) {
  return (
    <div className="space-y-2 text-body text-gray-300">
      {String(text || '').split('\n').map((line, i) => {
        const t = line.replace(/\*\*/g, '').trim();
        if (!t) return null;
        if (t.startsWith('#')) return <h3 key={i} className="text-body font-bold text-white pt-2">{t.replace(/^#+\s*/, '').replace(/^\([abc]\)\s*/, '')}</h3>;
        if (t.startsWith('- ')) return <p key={i}>• {t.slice(2)}</p>;
        return <p key={i}>{t}</p>;
      })}
    </div>
  );
}

function EconomyTab({ eco }) {
  if (!eco?.has_data) return <Empty>No economy data: needs at least 15 rounds with buy information.</Empty>;
  return (
    <div className="space-y-4">
      {Object.values(eco.metrics || {}).map(m => (
        <div key={m.label} className="space-y-1.5">
          <div className="text-body font-semibold text-white">{m.label}</div>
          <p className="text-secondary text-gray-300">{m.plain}</p>
          {m.enough_data && (
            <div className="space-y-1">
              {[['You', m.rate_pct, 'bg-sky-400'], ['Players in your lobbies', m.peer_baseline?.p0_pct, 'bg-gray-400']].map(([l, v, c]) => (
                <div key={l} className="flex items-center gap-2 text-secondary">
                  <span className="w-44 shrink-0 text-gray-400">{l}</span>
                  <div className="flex-1 h-2 rounded bg-white/10 overflow-hidden"><div className={`h-full ${c}`} style={{ width: `${Math.min(100, v || 0)}%` }} /></div>
                  <span className="w-12 text-right tabular-nums">{v == null ? 'n/a' : `${v}%`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <p className="text-min text-gray-400">Based on {eco.total_rounds_analyzed} rounds. Buy types come from your team's average loadout value.</p>
    </div>
  );
}

function TrendsTab({ trends, session }) {
  if (!trends?.has_sufficient_data) return <Empty>{trends?.reason || 'Trends need at least 20 matches.'}</Empty>;
  const ht = trends.habit_trend;
  return (
    <div className="space-y-5">
      <div>
        <div className="text-body font-semibold text-white mb-1">ACS per match <span className="text-secondary font-normal text-gray-400">(line = 10-match average)</span></div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trends.series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <XAxis dataKey="match_index" tick={{ fill: '#9ca3af', fontSize: 13 }} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 13 }} />
              <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 14 }} />
              <Line type="monotone" dataKey="acs" stroke="#6b7280" strokeWidth={1} dot={false} name="ACS" />
              <Line type="monotone" dataKey="acs_ma10" stroke="#ff4655" strokeWidth={2.5} dot={false} name="10-match avg" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-min text-gray-400">Oldest match on the left. Latest 10-match average: ACS {trends.series.at(-1)?.acs_ma10}, K/D {trends.series.at(-1)?.kd_ma10}.</p>
      </div>
      {ht && (
        <div className="space-y-1">
          <div className="text-body font-semibold text-white">Is your key habit changing?</div>
          {ht.verdict === 'not enough data' ? (
            <p className="text-secondary text-gray-400">{ht.reason}</p>
          ) : (
            <p className="text-secondary text-gray-300">
              Older half of matches {ht.older.rate_pct}% ({ht.older.k}/{ht.older.n}), newer half {ht.newer.rate_pct}% ({ht.newer.k}/{ht.newer.n}): <b className="text-white">{ht.verdict}</b>.
            </p>
          )}
        </div>
      )}
      <p className="text-secondary text-gray-400">
        Long sessions: {session?.has_sufficient_data ? session.finding : session?.reason || 'not enough data.'}
      </p>
    </div>
  );
}

function DetailsTab({ habits }) {
  const rows = habits.filter(h => h.tier !== 'not applicable for role' && h.tier !== 'not enough data' && h.polarity !== 'info' && h.n >= 15);
  if (!rows.length) return <Empty>Not enough chances yet in any role and side.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-secondary">
        <thead className="text-gray-400 text-left">
          <tr><th className="py-2 pr-3 font-medium">Habit</th><th className="pr-3 font-medium">Role · side</th><th className="pr-3 font-medium text-right">You</th><th className="pr-3 font-medium text-right">Peers</th><th className="pr-3 font-medium text-right">Chances</th><th className="font-medium">Status</th></tr>
        </thead>
        <tbody>
          {rows.map(h => (
            <tr key={h.cell} className="border-t border-white/5">
              <td className="py-2 pr-3 text-white">{nameOf(h)}</td>
              <td className="pr-3 text-gray-300">{h.role} · {h.side}</td>
              <td className="pr-3 text-right">{h.ratePct}%</td>
              <td className="pr-3 text-right text-gray-300">{h.peer_baseline?.p0_pct != null ? `${h.peer_baseline.p0_pct}%` : 'n/a'}</td>
              <td className="pr-3 text-right text-gray-300">{h.n}</td>
              <td className={isShown(h) ? (h.polarity === 'flaw' ? 'text-amber-300' : 'text-emerald-300') : 'text-gray-400'}>
                {isShown(h) ? (h.polarity === 'flaw' ? 'Work on it' : 'Strength') : 'Normal range'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-min text-gray-400 mt-2">"Peers" are the other players in your own matches who played the same role on the same side.</p>
    </div>
  );
}

function Chat({ analysis }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const send = async text => {
    const q = (text || input).trim();
    if (!q || loading) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const r = await axios.post('/api/coaching/chat', { riotId: analysis.player, messages: next, contextData: analysis });
      setMessages([...next, { role: 'coach', content: r.data.reply }]);
    } catch {
      setMessages([...next, { role: 'coach', content: 'The coach is unavailable right now. Try again in a moment.' }]);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="glass-panel p-5 space-y-3">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between text-section font-bold text-white">
        Ask the coach {open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </button>
      {open && (
        <>
          <p className="text-secondary text-gray-400">Answers come only from your match data. If something isn't in it, the coach says so.</p>
          <div className="flex flex-wrap gap-2">
            {['What should I work on first?', 'Show me a round where I traded well', 'Where do I die most on defense?'].map(q => (
              <button key={q} onClick={() => send(q)} className="text-secondary bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5">{q}</button>
            ))}
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {messages.map((m, i) => (
              <p key={i} className={`text-body rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-white/10 text-white ml-8' : 'bg-black/30 text-gray-200 mr-8'}`}>{m.content}</p>
            ))}
            {loading && <Loader2 className="w-5 h-5 animate-spin text-gray-400" />}
          </div>
          <form onSubmit={e => { e.preventDefault(); send(); }} className="flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about your rounds, habits or deaths" className="flex-1 min-w-0 bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-body" />
            <button className="bg-valo-red hover:bg-red-500 rounded-lg px-3" aria-label="Send"><Send className="w-4 h-4" /></button>
          </form>
        </>
      )}
    </section>
  );
}

export default function Dashboard({ data, onSwitchContext, isSwitching }) {
  const { analysis, debrief } = data;
  const { player, actual_rank, trends, spatial_data, session_analytics, economy_analytics, context } = analysis;
  const habits = analysis.habits || [];
  const [role, setRole] = useState('all');
  const [side, setSide] = useState('both');
  const [tab, setTab] = useState('debrief');

  const inView = h => (role === 'all' || h.role === role) && (side === 'both' || h.side === side);
  const strengths = habits.filter(h => h.polarity === 'positive' && isShown(h) && inView(h));
  const flaws = habits.filter(h => h.polarity === 'flaw' && isShown(h) && inView(h));
  // Unproven but measured: within normal range of peers. Shown as "not a pattern yet" so a view never looks empty
  const measured = h => inView(h) && h.n >= 15 && h.k > 0 && h.tier === 'occasional' && h.peer_baseline?.p0 != null;
  const gap = h => h.rate - h.peer_baseline.p0;
  const biggestGap = polarity => habits.filter(h => h.polarity === polarity && measured(h) && gap(h) > 0).sort((a, b) => gap(b) - gap(a))[0];
  const leadStrength = strengths.length ? null : biggestGap('positive');
  const watchFlaw = flaws.length ? null : biggestGap('flaw');
  const viewHabits = habits.filter(inView);
  const measuredCount = viewHabits.filter(h => h.n >= 15 && h.polarity !== 'info' && h.tier !== 'not applicable for role' && h.tier !== 'not enough data').length;
  // Same rule as the backend's next_focus, applied to the current view: proven flaw > closest flaw > proven strength
  const focusHabit = flaws[0] || watchFlaw || strengths[0];
  const focus = focusHabit && {
    type: focusHabit.polarity === 'flaw' ? 'reduce' : 'keep',
    cell: focusHabit.cell, title: focusHabit.title, role: focusHabit.role, side: focusHabit.side,
    current_pct: focusHabit.ratePct,
    target_pct: focusHabit.polarity === 'flaw' ? focusHabit.peer_baseline.p0_pct : focusHabit.ratePct,
    proven: isShown(focusHabit)
  };
  const normalRange = `All ${measuredCount} measured habits in this view are within the normal range of players like you. The All habits tab has every number.`;
  const ht = trends?.habit_trend;
  const roleMix = analysis.role_mix || {};
  const matchesInView = role === 'all' ? analysis.total_matches_analyzed : (roleMix[role] || 0);

  const tabs = [['debrief', 'Coach summary'], ['map', 'Map'], ['economy', 'Economy'], ['trends', 'Trends'], ['details', 'All habits']];

  return (
    <div className={`max-w-6xl mx-auto space-y-5 animate-slide-up ${isSwitching ? 'opacity-60 pointer-events-none' : ''}`}>
      {/* Header */}
      <section className="glass-panel p-5 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-title font-black text-white uppercase break-all">{player}</h1>
          <span className="text-body font-semibold text-white bg-white/10 rounded px-2 py-0.5">{actual_rank}</span>
        </div>
        <p className="text-secondary text-gray-300 tabular-nums">
          {analysis.total_matches_analyzed} matches analyzed
          {analysis.total_matches_skipped > 0 && ` · ${analysis.total_matches_skipped} skipped (not competitive, unrated or premier)`}
          {' · '}{Object.entries(roleMix).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <select value={role} onChange={e => setRole(e.target.value)} className="bg-black/40 border border-white/15 rounded-lg px-3 py-1.5 text-secondary" aria-label="Role filter">
            <option value="all">All roles</option>
            {ROLES.map(r => <option key={r} value={r}>{r} ({roleMix[r] || 0} matches)</option>)}
          </select>
          <select value={side} onChange={e => setSide(e.target.value)} className="bg-black/40 border border-white/15 rounded-lg px-3 py-1.5 text-secondary" aria-label="Side filter">
            <option value="both">Attack and defense</option>
            <option value="attack">Attack</option>
            <option value="defense">Defense</option>
          </select>
          <span className="text-secondary text-gray-400 self-center">{matchesInView} matches in this view. You are compared with players on the same role and side in your own matches.</span>
        </div>
      </section>

      {/* Your report */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel title="Strengths">
          {strengths.length ? strengths.map(h => <HabitCard key={h.cell} h={h} />)
            : leadStrength ? (<><p className="text-secondary text-gray-400">Nothing proven yet. Where you're most ahead:</p><HabitCard h={leadStrength} label="Not a pattern yet" /></>)
              : <Empty>{measuredCount ? normalRange : 'Not enough chances in this view yet.'}</Empty>}
        </Panel>
        <Panel title="Work on">
          {flaws.length ? flaws.map(h => <HabitCard key={h.cell} h={h} />)
            : watchFlaw ? (<><p className="text-secondary text-gray-400">No proven weak habit. Closest one to watch:</p><HabitCard h={watchFlaw} label="Not a pattern yet" /></>)
              : <Empty>{measuredCount ? normalRange : 'Not enough chances in this view yet.'}</Empty>}
        </Panel>
        <Panel title="Next session">
          {focus ? (
            <div className="space-y-3">
              <p className="text-body text-white">
                {focus.type === 'reduce'
                  ? <>Bring <b>{focus.title.toLowerCase()}</b> as {focus.role} on {focus.side} from <b className="tabular-nums">{focus.current_pct}%</b> to <b className="tabular-nums">{focus.target_pct}%</b> or lower.</>
                  : <>Keep <b>{focus.title.toLowerCase()}</b> as {focus.role} on {focus.side} at <b className="tabular-nums">{focus.current_pct}%</b> or higher.</>}
              </p>
              <p className="text-secondary text-gray-400">Measured over your next 10 matches.{focus.proven === false && ' This one is not a proven habit yet, so treat it as a check, not a fix.'}</p>
              {ht && ht.cell === focus.cell && ht.verdict !== 'not enough data' && (
                <p className="text-secondary text-gray-300">Last {trends.matches_count} matches: {ht.older.rate_pct}% then {ht.newer.rate_pct}% ({ht.verdict}).</p>
              )}
            </div>
          ) : <Empty>Nothing in this view stands out enough to set a goal. Play more matches here or pick another view.</Empty>}
        </Panel>
      </div>

      {/* Detail tabs */}
      <section className="glass-panel p-5 space-y-4">
        <div className="flex flex-wrap gap-1.5 border-b border-white/10 pb-3" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`text-secondary font-semibold rounded-lg px-3 py-1.5 ${tab === k ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
          ))}
        </div>
        {tab === 'debrief' && <DebriefText text={debrief} />}
        {tab === 'map' && (
          <MapHeatmap spatialData={spatial_data} currentMap={context?.map}
            onSelectMap={m => onSwitchContext && onSwitchContext(m, context?.role)} />
        )}
        {tab === 'economy' && <EconomyTab eco={economy_analytics} />}
        {tab === 'trends' && <TrendsTab trends={trends} session={session_analytics} />}
        {tab === 'details' && <DetailsTab habits={viewHabits} />}
      </section>

      <Chat analysis={analysis} />
    </div>
  );
}
