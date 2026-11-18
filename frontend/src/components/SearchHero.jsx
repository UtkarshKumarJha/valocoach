import React, { useState, useEffect } from 'react';
import { Search, Loader2, Activity, Sparkles } from 'lucide-react';

const LOADING_STAGES = [
  'Querying official Riot match telemetry...',
  'Ingesting round economy & spatial kill coordinates...',
  'Auto-detecting player role & playstyle archetype...',
  'Evaluating ONNX Neural Sequence momentum & tilt pivots...',
  'Synthesizing Immortal-tier coaching debrief via Gemini AI...'
];

export default function SearchHero({ onSearch, isLoading }) {
  const [riotId, setRiotId] = useState('');
  const [region, setRegion] = useState('ap');
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setStageIndex((prev) => (prev + 1) % LOADING_STAGES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [isLoading]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (riotId.includes('#')) {
      setStageIndex(0);
      const [name, tag] = riotId.split('#');
      onSearch(region, name, tag);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] max-w-2xl mx-auto text-center px-4 animate-fade-in">
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-valo-red/10 border border-valo-red/30 text-valo-red text-xs font-black tracking-widest uppercase mb-6 animate-pulse">
        ✦ Immortal-Ranked AI Coaching Engine
      </div>

      <h1 className="text-5xl sm:text-6xl font-black italic tracking-tight mb-4 uppercase text-transparent bg-clip-text bg-gradient-to-r from-valo-light to-gray-400">
        AI Match <span className="text-valo-red">Coach</span>
      </h1>
      
      <p className="text-gray-400 mb-8 text-base sm:text-lg max-w-lg">
        Unlock hidden performance patterns, tactical 2D death heatmaps, and pro VCT debriefs powered by Machine Learning & Gemini.
      </p>

      <form onSubmit={handleSubmit} className="w-full space-y-4">
        {/* Riot ID & Region Search Input Container - Flex layout with ZERO overlap */}
        <div className="flex items-center bg-valo-gray/70 border-2 border-white/10 rounded-2xl p-2 focus-within:border-valo-red focus-within:shadow-[0_0_25px_#ff465530] transition-all shadow-2xl gap-2">
          {/* Region Pill */}
          <div className="shrink-0 bg-black/60 border border-white/10 rounded-xl px-3 py-2 flex items-center">
            <select 
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="bg-transparent text-gray-200 font-bold text-xs sm:text-sm outline-none cursor-pointer hover:text-white disabled:opacity-50"
              disabled={isLoading}
            >
              <option value="ap" className="bg-gray-900">AP (Asia)</option>
              <option value="na" className="bg-gray-900">NA (North America)</option>
              <option value="eu" className="bg-gray-900">EU (Europe)</option>
              <option value="kr" className="bg-gray-900">KR (Korea)</option>
            </select>
          </div>
          
          {/* Main Input */}
          <input
            type="text"
            placeholder="TenZ#00005 or PRX f0rsakeN#bibii"
            required
            disabled={isLoading}
            value={riotId}
            onChange={(e) => setRiotId(e.target.value)}
            className="flex-1 bg-transparent px-3 py-2 text-base sm:text-lg font-medium text-white placeholder-gray-500 focus:outline-none disabled:opacity-50 min-w-0"
          />
          
          {/* Search Button */}
          <button 
            type="submit"
            disabled={isLoading || !riotId.includes('#')}
            className="shrink-0 px-6 py-3 bg-valo-red text-white font-bold rounded-xl hover:bg-[#d93b49] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[54px] shadow-lg shadow-valo-red/20 active:scale-95 cursor-pointer"
          >
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
          </button>
        </div>

        {/* Live Loading Stage Tracker */}
        {isLoading && (
          <div className="glass-panel p-3.5 bg-black/50 border border-valo-red/30 rounded-xl flex items-center justify-center gap-3 animate-pulse">
            <Activity className="w-4 h-4 text-valo-red animate-spin" />
            <span className="text-xs font-mono font-bold text-gray-300">
              {LOADING_STAGES[stageIndex]}
            </span>
          </div>
        )}

        {/* System Auto-Detection Callout */}
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-gray-400 bg-white/5 border border-white/10 px-4 py-1.5 rounded-full">
          <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
          <span>Auto-detects Playstyle Archetype, Primary Role, and Map from recent matches</span>
        </div>
      </form>
    </div>
  );
}
