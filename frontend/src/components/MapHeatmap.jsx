import React, { useState } from 'react';
import { Crosshair, Skull, ShieldAlert, Sparkles, Filter } from 'lucide-react';
import { MAP_CONFIG, worldToMiniMap } from '../utils/mapUtils';

export default function MapHeatmap({ spatialData, currentMap, onSelectMap }) {
  const [filterMode, setFilterMode] = useState('deaths'); // 'deaths' | 'kills' | 'all'
  const [hoveredEvent, setHoveredEvent] = useState(null);

  const activeMapKey = (currentMap || spatialData?.active_map || 'ascent').toLowerCase().trim();
  const mapConfig = MAP_CONFIG[activeMapKey] || MAP_CONFIG.ascent;
  
  const deaths = spatialData?.deaths || [];
  const kills = spatialData?.kills || [];
  const stats = spatialData?.map_stats || { kills_count: 0, deaths_count: 0, kd_ratio: 0 };
  const availableMaps = spatialData?.available_maps || Object.keys(MAP_CONFIG);

  return (
    <div className="glass-panel p-6 space-y-4">
      {/* Header with Title and Map Selector */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-white/5 pb-4">
        <div>
          <h3 className="font-black tracking-wider uppercase text-lg flex items-center gap-2 text-white">
            <ShieldAlert className="w-5 h-5 text-valo-red" />
            Tactical 2D Positioning Radar
          </h3>
          <p className="text-xs text-gray-400">
            Real in-game spatial coordinates plotted against official Riot radar calibration
          </p>
        </div>

        {/* Map Switcher Dropdown */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1">
            <Filter className="w-3.5 h-3.5" />
            Map:
          </label>
          <select
            value={activeMapKey}
            onChange={(e) => onSelectMap && onSelectMap(e.target.value)}
            className="bg-black/60 border border-white/10 text-white font-bold text-sm px-3 py-1.5 rounded-lg focus:outline-none focus:border-valo-red cursor-pointer"
          >
            {Object.keys(MAP_CONFIG).map((mk) => (
              <option key={mk} value={mk}>
                {MAP_CONFIG[mk].name} {availableMaps.map(m => m.toLowerCase()).includes(mk) ? '★' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Subheader: Filter Toggles & K/D Performance */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {/* Toggle Buttons */}
        <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-lg border border-white/5">
          <button
            onClick={() => setFilterMode('deaths')}
            className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
              filterMode === 'deaths'
                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Skull className="w-3.5 h-3.5" />
            Fatal Deaths ({deaths.length})
          </button>
          
          <button
            onClick={() => setFilterMode('kills')}
            className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
              filterMode === 'kills'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            Frags ({kills.length})
          </button>

          <button
            onClick={() => setFilterMode('all')}
            className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-all ${
              filterMode === 'all'
                ? 'bg-white/20 text-white border border-white/30'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            All Events
          </button>
        </div>

        {/* Map Ratio Badge */}
        <div className="flex items-center gap-4 text-xs font-mono font-bold">
          <span className="text-gray-400">Map Record:</span>
          <span className="text-emerald-400">{stats.kills_count} K</span>
          <span className="text-gray-600">/</span>
          <span className="text-red-400">{stats.deaths_count} D</span>
          <span className={`px-2 py-0.5 rounded text-xs ${stats.kd_ratio >= 1.0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            {stats.kd_ratio} KD
          </span>
        </div>
      </div>

      {/* Mini-map 2D Radar Canvas */}
      <div className="relative w-full aspect-square max-w-[540px] mx-auto bg-black/80 rounded-2xl border-2 border-white/10 overflow-hidden shadow-2xl flex items-center justify-center group">
        {/* Radar Background Image */}
        <img
          src={mapConfig.icon}
          alt={`${mapConfig.name} Radar`}
          className="w-full h-full object-contain filter brightness-90 contrast-125 opacity-80 select-none pointer-events-none"
        />

        {/* Dark Grid Overlay */}
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff08_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />

        {/* Deaths Layer */}
        {(filterMode === 'deaths' || filterMode === 'all') &&
          deaths.map((d, idx) => {
            const pos = worldToMiniMap(d.x, d.y, mapConfig.name);
            return (
              <div
                key={`death-${idx}`}
                onMouseEnter={() => setHoveredEvent({ ...d, type: 'Death' })}
                onMouseLeave={() => setHoveredEvent(null)}
                style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
                className="absolute w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full bg-red-500 border border-white shadow-[0_0_10px_#ef4444] cursor-pointer hover:scale-150 hover:z-30 transition-transform duration-200"
              >
                {/* Subtle pulse ring for danger hotspots */}
                <span className="animate-ping absolute inset-0 rounded-full bg-red-400 opacity-40"></span>
              </div>
            );
          })}

        {/* Kills Layer */}
        {(filterMode === 'kills' || filterMode === 'all') &&
          kills.map((k, idx) => {
            const pos = worldToMiniMap(k.x, k.y, mapConfig.name);
            return (
              <div
                key={`kill-${idx}`}
                onMouseEnter={() => setHoveredEvent({ ...k, type: 'Kill' })}
                onMouseLeave={() => setHoveredEvent(null)}
                style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
                className="absolute w-3 h-3 -ml-[6px] -mt-[6px] rotate-45 bg-emerald-400 border border-white shadow-[0_0_8px_#10b981] cursor-pointer hover:scale-150 hover:z-30 transition-transform duration-200"
              />
            );
          })}

        {/* Interactive Event Hover Tooltip */}
        {hoveredEvent && (
          <div className="absolute bottom-4 left-4 right-4 bg-black/90 backdrop-blur-md p-3 rounded-xl border border-white/20 text-xs shadow-2xl animate-fade-in flex items-center justify-between pointer-events-none z-40">
            <div className="flex items-center gap-2.5">
              <span
                className={`px-2 py-0.5 rounded font-black uppercase text-[10px] ${
                  hoveredEvent.type === 'Death'
                    ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                }`}
              >
                {hoveredEvent.type}
              </span>
              <span className="text-gray-300 font-medium">
                Round {hoveredEvent.round} • {hoveredEvent.weapon || 'Weapon'}
              </span>
            </div>
            <div className="text-gray-400">
              {hoveredEvent.type === 'Death' ? (
                <span>Eliminated by <strong className="text-white">{hoveredEvent.killer}</strong></span>
              ) : (
                <span>Fragged <strong className="text-white">{hoveredEvent.victim}</strong></span>
              )}
            </div>
          </div>
        )}

        {/* Watermark badge */}
        <div className="absolute top-3 right-3 text-[10px] uppercase font-mono tracking-widest text-gray-400 bg-black/60 px-2.5 py-1 rounded-md border border-white/5 pointer-events-none">
          {mapConfig.name} • High-Precision Radar
        </div>

        {/* Empty State message if no data */}
        {deaths.length === 0 && kills.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm p-6 text-center text-gray-400">
            <Sparkles className="w-8 h-8 text-valo-red mb-2" />
            <p className="font-bold text-white text-sm">No Recorded Encounters on {mapConfig.name}</p>
            <p className="text-xs text-gray-400 max-w-xs mt-1">
              No matches on this map in the current 10-game window. Radar overview is calibrated and ready.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
