import React, { useState, useRef, useEffect } from 'react';
import { 
  Bot, 
  Target, 
  AlertTriangle, 
  TrendingUp, 
  Users, 
  MapPin, 
  UserCheck, 
  Loader2, 
  Zap, 
  BatteryCharging, 
  Coins, 
  Send, 
  MessageSquare,
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  Crosshair,
  Compass,
  Film,
  Flame,
  ArrowRight
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  LineChart, 
  Line, 
  XAxis, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import axios from 'axios';
import MapHeatmap from './MapHeatmap';

export default function Dashboard({ data, activeParams, onSwitchContext, isSwitching }) {
  const { analysis, debrief } = data;
  const { 
    player, 
    rank_estimate, 
    actual_rank, 
    agent_recommendations = [], 
    trends, 
    spatial_data, 
    sequence_analytics, 
    session_analytics,
    economy_analytics,
    telemetry_intelligence,
    playstyle_archetype,
    context 
  } = analysis;

  const currentMap = context?.map || activeParams?.map || spatial_data?.active_map || 'ascent';
  const currentRole = context?.role || activeParams?.role || 'Duelist';

  const ti = telemetry_intelligence || {};
  const tradeMetrics = ti.trade_metrics || {};
  const youTrade = tradeMetrics.you_trade_teammates || {};
  const tempo = ti.tempo || {};
  const top3ShareMap = ti.spatial_top_3_cell_share || {};
  const activeSliceKey = Object.keys(top3ShareMap).find(k => k.toLowerCase().startsWith(currentMap.toLowerCase())) || Object.keys(top3ShareMap)[0];
  const activeSlice = activeSliceKey ? top3ShareMap[activeSliceKey] : null;
  const impactFlaws = ti.impact_flaws || [];
  const replayCues = ti.replay_cue_sheet || [];
  const habits = analysis.habits || ti.habits || [];
  const positiveHabits = habits.filter(h => h.polarity === 'positive' && h.tier !== 'not enough data');
  const flawHabits = habits.filter(h => h.polarity === 'flaw' && h.tier !== 'not enough data');

  // Chat State
  const [messages, setMessages] = useState([
    {
      role: 'coach',
      content: `I've analyzed your telemetry across your matches. Ask me anything about your ${playstyle_archetype?.title || 'playstyle'}, positioning on ${currentMap}, your ${currentRole} utility, or your VOD replay cues.`
    }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatBottomRef = useRef(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (customPrompt) => {
    const textToSend = customPrompt || inputMessage;
    if (!textToSend.trim() || isChatLoading) return;

    const newMessages = [...messages, { role: 'user', content: textToSend }];
    setMessages(newMessages);
    setInputMessage('');
    setIsChatLoading(true);

    try {
      const response = await axios.post('/api/coaching/chat', {
        riotId: player,
        messages: newMessages,
        contextData: analysis
      });
      setMessages([...newMessages, { role: 'coach', content: response.data.reply }]);
    } catch {
      setMessages([
        ...newMessages,
        { role: 'coach', content: 'Coach radio disconnected. Please try asking again in a moment.' }
      ]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const windowSize = trends?.hs_pct?.window || 5;
  const trendData = [
    { name: `Prev ${windowSize}`, hs: trends?.hs_pct?.direction === 'improving' ? 0 : Math.abs(trends?.hs_pct?.delta || 0) * 100 },
    { name: `Latest ${windowSize}`, hs: trends?.hs_pct?.direction === 'improving' ? Math.abs(trends?.hs_pct?.delta || 0) * 100 : 0 }
  ];

  // Neural Momentum Win Probability Curve
  const momentumCurve = (sequence_analytics?.win_probability_curve || []).map((prob, idx) => ({
    round: `R${idx + 1}`,
    win_prob: Math.round(prob * 100)
  }));

  return (
    <div className="max-w-6xl mx-auto px-4 py-4 animate-slide-up space-y-6">

      {/* Header Profile */}
      <div className="glass-panel p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-valo-red/20 rounded-2xl flex items-center justify-center border border-valo-red/50 shadow-[0_0_20px_#ff465540] shrink-0">
            <Target className="w-8 h-8 text-valo-red" />
          </div>
          <div>
            <h2 className="text-3xl font-black uppercase tracking-wider">{player}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-gray-400 font-medium text-xs">Actual:</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-white/10 text-valo-light border border-white/20">
                {actual_rank}
              </span>
              <span className="text-xs text-gray-500 font-mono">
                Cohort: {ti.rank_cohort_context?.rank || actual_rank}
              </span>
            </div>
            {/* Auto-Detected Playstyle Archetype Badge & Traits */}
            {playstyle_archetype && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider bg-gradient-to-r from-valo-red/30 to-amber-500/20 text-white border border-valo-red/40 shadow-[0_0_15px_#ff465525]">
                  <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
                  {playstyle_archetype.title}
                </span>
                {(playstyle_archetype.traits || []).map((t, idx) => (
                  <span key={idx} className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-white/5 text-gray-300 border border-white/10">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="text-right glass-panel bg-black/40 px-6 py-4 rounded-xl border border-yellow-500/20 shrink-0">
          <p className="text-xs text-gray-400 uppercase font-bold tracking-widest mb-1">ML Estimated Form</p>
          <div className="text-2xl font-black bg-gradient-to-r from-yellow-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent">
            {rank_estimate}
          </div>
          <p className="text-[10px] text-gray-500 font-mono mt-0.5">XGBoost & Sequence Neural Eval</p>
        </div>
      </div>

      {/* 4 Hidden Telemetry Metrics Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Trade Conversion */}
        <div className="glass-panel p-3.5 bg-black/30 border border-white/5">
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-400 uppercase">
            <span className="flex items-center gap-1.5"><Crosshair className="w-3.5 h-3.5 text-valo-red" /> Team Trade Conv</span>
            <span className="text-xs font-mono text-emerald-400">
              {tradeMetrics.traded_deaths?.count ?? 0}/{tradeMetrics.eligible_trade_deaths ?? 0} ({tradeMetrics.traded_deaths?.pct ?? 0}%)
            </span>
          </div>
          <div className="text-xs font-mono text-gray-400 mt-1">
            Untradeable: <span className="text-amber-400 font-bold">{tradeMetrics.untradeable_deaths?.count ?? 0}/{tradeMetrics.eligible_trade_deaths ?? 0} ({tradeMetrics.untradeable_deaths?.pct ?? 0}%)</span>
          </div>
        </div>

        {/* You Trade Teammates (with Wilson 95% CI) */}
        <div className="glass-panel p-3.5 bg-black/30 border border-white/5">
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-400 uppercase">
            <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-blue-400" /> You Trade Allies</span>
            <span className="text-xs font-mono text-blue-400">
              {youTrade.trades_made ?? 0}/{youTrade.opportunities ?? 0} ({youTrade.rate_pct ?? 0}%)
            </span>
          </div>
          <div className="text-[11px] font-mono text-gray-400 mt-1">
            95% CI: <span className="text-gray-300 font-bold">[{youTrade.wilson_95_ci?.[0] ?? 0}%, {youTrade.wilson_95_ci?.[1] ?? 0}%]</span>
          </div>
        </div>

        {/* Opening Tempo (Attack vs Defense Split) */}
        <div className="glass-panel p-3.5 bg-black/30 border border-white/5">
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-400 uppercase">
            <span className="flex items-center gap-1.5"><Flame className="w-3.5 h-3.5 text-orange-400" /> Dry-Peeks & Tempo</span>
            <span className="text-xs font-mono text-orange-400">{tempo.avg_death_time_sec || 35}s avg</span>
          </div>
          <div className="text-xs font-mono text-gray-400 mt-1">
            Atk: <span className="text-white font-bold">{tempo.attack_dry_peeks?.pct ?? 0}%</span> | Def: <span className="text-white font-bold">{tempo.defense_dry_peeks?.pct ?? 0}%</span>
          </div>
        </div>

        {/* Spatial Top-3-Cell Death Share */}
        <div className="glass-panel p-3.5 bg-black/30 border border-white/5">
          <div className="flex items-center justify-between text-[11px] font-bold text-gray-400 uppercase">
            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-yellow-400" /> Top-3-Cell Share</span>
            <span className="text-xs font-mono text-yellow-400">
              {activeSlice?.is_valid_sample ? `${activeSlice.top_3_cell_share_pct}%` : 'Dispersed'}
            </span>
          </div>
          <div className="text-[11px] font-mono text-gray-300 mt-1 truncate">
            {activeSlice?.is_valid_sample ? `Baseline: ${activeSlice.shuffled_baseline_pct}% uniform` : 'Min-sample guard active'}
          </div>
        </div>
      </div>

      {/* Interactive Context Switcher Bar (Map & Role) */}
      <div className="glass-panel p-4 flex flex-wrap items-center justify-between gap-4 bg-black/30 border border-white/10">
        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-gray-400">
          <span>Active Strategy Context:</span>
          {isSwitching && (
            <span className="inline-flex items-center gap-1.5 text-valo-red text-xs font-bold animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Re-evaluating Telemetry & Debrief...
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Map Selector */}
          <div className="flex items-center gap-2 bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-xs">
            <MapPin className="w-3.5 h-3.5 text-valo-red" />
            <span className="text-gray-400 font-bold uppercase">Map:</span>
            <select
              value={currentMap.toLowerCase()}
              disabled={isSwitching}
              onChange={(e) => onSwitchContext && onSwitchContext(e.target.value, currentRole)}
              className="bg-transparent font-bold text-white outline-none cursor-pointer hover:text-valo-light capitalize"
            >
              {['ascent', 'bind', 'haven', 'split', 'sunset', 'lotus', 'abyss', 'icebox', 'breeze'].map(m => (
                <option key={m} value={m} className="bg-gray-900 capitalize">
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Role Selector */}
          <div className="flex items-center gap-2 bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-xs">
            <UserCheck className="w-3.5 h-3.5 text-yellow-400" />
            <span className="text-gray-400 font-bold uppercase">Role:</span>
            <select
              value={currentRole}
              disabled={isSwitching}
              onChange={(e) => onSwitchContext && onSwitchContext(currentMap, e.target.value)}
              className="bg-transparent font-bold text-white outline-none cursor-pointer hover:text-valo-light"
            >
              <option value="Duelist" className="bg-gray-900">Duelist</option>
              <option value="Initiator" className="bg-gray-900">Initiator</option>
              <option value="Controller" className="bg-gray-900">Controller</option>
              <option value="Sentinel" className="bg-gray-900">Sentinel</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Grid: 2D Spatial Radar + Trends & AI Coach */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Left Column (5 Cols): Mini-Map + Momentum + Trends */}
        <div className="lg:col-span-5 space-y-6">

          {/* 2D Mini-Map Positioning Radar */}
          <MapHeatmap
            spatialData={spatial_data}
            currentMap={currentMap}
            onSelectMap={(mapName) => onSwitchContext && onSwitchContext(mapName, currentRole)}
          />

          {/* Neural Match Momentum & Tilt Curve */}
          {momentumCurve.length > 0 && (
            <div className="glass-panel p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold flex items-center gap-2 text-gray-300 text-sm tracking-wider uppercase">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  Neural Momentum & Tilt Curve
                </h3>
                {sequence_analytics?.tilt_inflection_round && (
                  <span className="text-[10px] font-mono font-black uppercase px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                    Tilt Pivot: R{sequence_analytics.tilt_inflection_round}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-400 leading-tight">
                Round-by-round win expectancy trajectory modeled from 6 years of VCT pro sequences
              </p>
              <div className="h-28 w-full pt-1">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={momentumCurve}>
                    <XAxis dataKey="round" stroke="#666" fontSize={10} tickLine={false} />
                    <Tooltip
                      cursor={{ stroke: '#ff4655', strokeWidth: 1 }}
                      contentStyle={{ backgroundColor: '#111', border: '1px solid #333', borderRadius: '8px', fontSize: '11px' }}
                      formatter={(val) => [`${val}%`, 'Win Expectancy']}
                    />
                    <Line type="monotone" dataKey="win_prob" stroke="#ff4655" strokeWidth={2} dot={{ r: 2.5, fill: '#ff4655' }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Micro Trends Chart */}
          <div className="glass-panel p-6">
            <h3 className="font-bold flex items-center gap-2 mb-4 text-gray-300 text-sm tracking-wider uppercase">
              <TrendingUp className="w-4 h-4 text-green-400" />
              Rolling Performance Trends
            </h3>
            {trends?.note ? (
              <p className="text-sm text-gray-500">{trends.note}</p>
            ) : (
              <div className="h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData}>
                    <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} />
                    <Tooltip cursor={{ fill: '#222' }} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', borderRadius: '8px' }} />
                    <Bar dataKey="hs" fill="#ff4655" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-4 flex items-center justify-between text-xs font-mono font-bold border-t border-white/5 pt-3">
              <span className="text-gray-400">ACS Momentum Delta:</span>
              <span className={trends?.acs?.direction === 'improving' ? 'text-green-400' : 'text-red-400'}>
                {trends?.acs?.delta > 0 ? '+' : ''}{trends?.acs?.delta ?? 0}
              </span>
            </div>
          </div>

        </div>

        {/* Right Column (7 Cols): Impact Flaws + Meta + AI Debrief */}
        <div className="lg:col-span-7 space-y-6 flex flex-col">

          {/* Observed Behavioral Habits (Last 50 Matches): Good Habits next to Flaws */}
          {habits.length > 0 && (
            <div className="glass-panel p-5">
              <h3 className="font-bold flex items-center justify-between mb-3 text-xs tracking-wider uppercase text-gray-400">
                <span className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  Observed Playstyle Habits (Recent Matches)
                </span>
                <span className="text-[10px] font-mono text-gray-500">
                  Wilson 95% CI
                </span>
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Positive Habits */}
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Strengths & Anchor Habits
                  </div>
                  {positiveHabits.length > 0 ? (
                    positiveHabits.slice(0, 2).map((h, i) => (
                      <div key={i} className="bg-emerald-950/20 p-2.5 rounded-lg border border-emerald-500/20">
                        <div className="flex items-center justify-between text-[11px] font-bold mb-1">
                          <span className="text-emerald-300">{h.title}</span>
                          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                            {h.tier}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-300 leading-relaxed">{h.narrative}</p>
                      </div>
                    ))
                  ) : (
                    <div className="text-[11px] text-gray-500 italic bg-black/20 p-2.5 rounded-lg border border-white/5">
                      Building baseline across additional matches...
                    </div>
                  )}
                </div>

                {/* Flaws / Tendencies */}
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Tendencies to Watch
                  </div>
                  {flawHabits.length > 0 ? (
                    flawHabits.slice(0, 2).map((h, i) => (
                      <div key={i} className="bg-amber-950/20 p-2.5 rounded-lg border border-amber-500/20">
                        <div className="flex items-center justify-between text-[11px] font-bold mb-1">
                          <span className="text-amber-300">{h.title}</span>
                          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                            {h.tier}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-300 leading-relaxed">{h.narrative}</p>
                      </div>
                    ))
                  ) : (
                    <div className="text-[11px] text-gray-400 bg-black/20 p-2.5 rounded-lg border border-white/5">
                      No severe negative behavioral patterns observed.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Impact-Ranked Flaws & Meta Recommendations */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* Impact-Ranked Flaws */}
            <div className="glass-panel p-5">
              <h3 className="font-bold flex items-center gap-2 mb-3 text-xs tracking-wider uppercase text-gray-400">
                <AlertTriangle className="w-4 h-4 text-orange-400" />
                Impact-Ranked Flaws ({actual_rank} Cohort)
              </h3>
              <div className="space-y-2">
                {impactFlaws.length > 0 ? (
                  impactFlaws.slice(0, 3).map((f, i) => (
                    <div key={i} className="bg-black/40 p-2.5 rounded-lg border border-white/5">
                      <div className="flex items-center justify-between text-[11px] font-bold">
                        <span className="text-orange-400">{f.flaw}</span>
                        <span className="text-emerald-400 font-mono">{f.round_impact}</span>
                      </div>
                      <div className="text-[10px] text-gray-400 mt-1">
                        Your rate: {f.your_rate} (Cohort: {f.cohort_benchmark})
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400">Mechanics and spacing align solidly with cohort.</p>
                )}
              </div>
            </div>

            {/* VCT Meta Agents */}
            <div className="glass-panel p-5">
              <h3 className="font-bold flex items-center gap-2 mb-3 text-xs tracking-wider uppercase text-gray-400">
                <Users className="w-4 h-4 text-blue-400" />
                VCT Pro Meta ({currentRole} on {currentMap})
              </h3>
              <div className="space-y-2">
                {agent_recommendations.map((rec, i) => (
                  <div key={i} className="bg-black/40 px-3 py-2 rounded-lg border border-white/5 font-medium text-xs text-gray-300">
                    {rec}
                  </div>
                ))}
              </div>
            </div>

          </div>

          {/* AI Debrief */}
          <div className="glass-panel p-6 flex-1 flex flex-col bg-gradient-to-b from-black/40 to-black/60 border border-white/10">
            <h3 className="font-black flex items-center justify-between text-gray-200 border-b border-white/5 pb-4 mb-4">
              <span className="flex items-center gap-2.5 tracking-wider uppercase text-sm">
                <Bot className="w-5 h-5 text-valo-red" />
                Immortal Mentor Debrief
              </span>
              <span className="text-[10px] uppercase font-mono tracking-widest text-gray-500 bg-white/5 px-2 py-0.5 rounded">
                Gemini 2.5 Flash
              </span>
            </h3>

            <div className="flex-1 overflow-y-auto space-y-3.5 text-gray-300 leading-relaxed text-sm pr-2 max-h-[340px]">
              {debrief.split('\n').map((paragraph, i) => {
                if (!paragraph.trim()) return null;
                return (
                  <div key={i} className="bg-black/30 p-4 rounded-xl border border-white/5 shadow-inner">
                    {paragraph}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

      </div>

      {/* Killer Feature: Replay Cue Sheet (VOD Review Targets) */}
      {replayCues.length > 0 && (
        <div className="glass-panel p-6 border border-white/10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold flex items-center gap-2 text-sm tracking-wider uppercase text-white">
              <Film className="w-4 h-4 text-valo-red" />
              Replay Cue Sheet — Critical VOD Review Targets
            </h3>
            <span className="text-xs text-gray-500 font-mono">
              Scrub to these timestamps in your replay to fix round-losing blunders
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {replayCues.map((cue, idx) => (
              <div key={idx} className="bg-black/40 p-3.5 rounded-xl border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-valo-red/20 text-valo-red text-xs font-mono font-black border border-valo-red/30">
                      R{cue.round}
                    </span>
                    <span className="text-xs font-mono font-bold text-gray-300">
                      {cue.clock_display || `${cue.elapsed_time || '0:00'} elapsed (${cue.on_clock_remaining || '1:40'} on-clock)`}
                    </span>
                    <span className="text-xs text-gray-500 font-medium">on {cue.map}</span>
                  </div>
                  <span className="text-xs font-mono font-black text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">
                    {cue.win_prob_impact}
                  </span>
                </div>
                <div className="text-xs font-bold text-orange-400 flex items-center gap-1.5">
                  <ArrowRight className="w-3.5 h-3.5 text-valo-red" />
                  {cue.flaw}
                </div>
                <p className="text-xs text-gray-400 leading-relaxed bg-white/5 p-2 rounded-lg">
                  {cue.cue}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Macro Hidden Patterns: Session Fatigue + Economy Discipline */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Session Fatigue & Endurance Card */}
        <div className="glass-panel p-6 border border-white/10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold flex items-center gap-2 text-sm tracking-wider uppercase text-gray-300">
              <BatteryCharging className="w-4 h-4 text-emerald-400" />
              Session Fatigue & Endurance Curve
            </h3>
            {session_analytics?.fatigue_detected && (
              <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                Fatigue Decay: -{session_analytics.fatigue_drop_pct}%
              </span>
            )}
          </div>

          {session_analytics?.has_sufficient_data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="bg-black/40 p-3 rounded-xl border border-white/5">
                  <div className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Game 1-2 Form</div>
                  <div className="text-xl font-black text-white mt-1">{session_analytics.game1_avg_acs} ACS</div>
                  <div className="text-[11px] text-emerald-400 font-mono font-bold">{session_analytics.game1_avg_kd} K/D</div>
                </div>
                <div className="bg-black/40 p-3 rounded-xl border border-white/5">
                  <div className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Game 3+ Form</div>
                  <div className="text-xl font-black text-white mt-1">{session_analytics.game3_plus_avg_acs} ACS</div>
                  <div className={`text-[11px] font-mono font-bold ${session_analytics.fatigue_detected ? 'text-red-400' : 'text-emerald-400'}`}>
                    {session_analytics.game3_plus_avg_kd} K/D
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-400 bg-white/5 p-3 rounded-lg border border-white/5 leading-relaxed">
                {session_analytics.recommendation}
              </p>
            </div>
          ) : (
            <p className="text-xs text-gray-500">{session_analytics?.note || "Awaiting multi-game session data."}</p>
          )}
        </div>

        {/* Economy & Buy Discipline Card */}
        <div className="glass-panel p-6 border border-white/10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold flex items-center gap-2 text-sm tracking-wider uppercase text-gray-300">
              <Coins className="w-4 h-4 text-yellow-400" />
              Economy Discipline & Buy Habits
            </h3>
            <span className={`text-xs font-mono font-black uppercase px-2.5 py-0.5 rounded border ${
              economy_analytics?.economy_rating === 'S' || economy_analytics?.economy_rating === 'A'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
            }`}>
              Grade {economy_analytics?.economy_rating || 'B'}
            </span>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                <div className="text-[10px] text-gray-400 uppercase font-bold">Hero Buys</div>
                <div className={`text-lg font-black mt-1 ${economy_analytics?.hero_buys_count > 2 ? 'text-amber-400' : 'text-white'}`}>
                  {economy_analytics?.hero_buys_count ?? 0}
                </div>
              </div>
              <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                <div className="text-[10px] text-gray-400 uppercase font-bold">Bank Hoards</div>
                <div className="text-lg font-black text-white mt-1">
                  {economy_analytics?.hoarding_saves_count ?? 0}
                </div>
              </div>
              <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                <div className="text-[10px] text-gray-400 uppercase font-bold">Pistol Buys</div>
                <div className="text-lg font-black text-emerald-400 mt-1">
                  {economy_analytics?.pistol_win_conversions ?? 0}
                </div>
              </div>
            </div>
            <p className="text-xs text-gray-400 bg-white/5 p-3 rounded-lg border border-white/5 leading-relaxed">
              {economy_analytics?.verdict}
            </p>
          </div>
        </div>

      </div>

      {/* Interactive Multi-Turn Coach Chat */}
      <div className="glass-panel p-6 border border-white/10 bg-gradient-to-b from-black/50 to-black/80">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <MessageSquare className="w-5 h-5 text-valo-red" />
            <h3 className="font-black text-sm tracking-wider uppercase text-white">Direct Coach Comms</h3>
            <span className="text-[10px] font-mono uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
              Grounded in Telemetry
            </span>
          </div>
          <span className="text-xs text-gray-500 font-mono hidden sm:inline">Ask follow-up questions citing your exact rounds & angles</span>
        </div>

        {/* Quick Suggestion Chips */}
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            "Why is my untradeable death rate so high?",
            "How do I fix my flank blindspot deaths?",
            "Explain my top Replay Cue target",
            `How should I play ${currentRole} on ${currentMap}?`
          ].map((promptText, i) => (
            <button
              key={i}
              onClick={() => handleSendMessage(promptText)}
              disabled={isChatLoading}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 hover:text-white transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <Sparkles className="w-3 h-3 text-valo-red" />
              {promptText}
            </button>
          ))}
        </div>

        {/* Message Stream */}
        <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 mb-4">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`flex gap-3 text-xs sm:text-sm ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {m.role === 'coach' && (
                <div className="w-7 h-7 rounded-lg bg-valo-red/20 border border-valo-red/40 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-valo-red" />
                </div>
              )}
              <div
                className={`p-3.5 rounded-xl max-w-[85%] leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-valo-red text-white font-medium rounded-tr-none'
                    : 'bg-white/5 border border-white/10 text-gray-300 rounded-tl-none'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {isChatLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-400 italic py-2">
              <Loader2 className="w-4 h-4 text-valo-red animate-spin" />
              Coach is analyzing your round snapshots & formulating tactical advice...
            </div>
          )}
          <div ref={chatBottomRef} />
        </div>

        {/* Input Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="Ask your coach anything about your positioning, utility, or gun choice..."
            disabled={isChatLoading}
            className="flex-1 bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-valo-red transition-all disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isChatLoading || !inputMessage.trim()}
            className="bg-valo-red hover:bg-[#d93b49] text-white p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-valo-red/20"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

    </div>
  );
}
