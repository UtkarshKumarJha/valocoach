import React, { useState } from 'react';
import { MAP_CONFIG, worldToMiniMap } from '../utils/mapUtils';

const CELL = 800; // ~8 m in game units: same cell size the repeat-death detector uses

/** Top N 8 m cells by event count, with the mean position of the events in each. */
function topSpots(events, n = 3) {
  const cells = new Map();
  for (const e of events) {
    const key = `${Math.floor(e.x / CELL)}_${Math.floor(e.y / CELL)}`;
    const c = cells.get(key) || { x: 0, y: 0, count: 0 };
    c.x += e.x; c.y += e.y; c.count += 1;
    cells.set(key, c);
  }
  return [...cells.values()].filter(c => c.count >= 2).sort((a, b) => b.count - a.count).slice(0, n)
    .map(c => ({ x: c.x / c.count, y: c.y / c.count, count: c.count }));
}

export default function MapHeatmap({ spatialData, currentMap, onSelectMap }) {
  const [layer, setLayer] = useState('deaths');
  const [side, setSide] = useState('both');

  // Draw on the map the positions came from; the backend falls back to another map when the requested one has no matches
  const activeMapKey = (spatialData?.active_map || currentMap || '').toLowerCase().trim();
  const mapConfig = MAP_CONFIG[activeMapKey];
  const availableMaps = (spatialData?.available_maps || []).map(m => m.toLowerCase()).filter(m => MAP_CONFIG[m]);
  const fellBack = spatialData && spatialData.requested_map_has_data === false && spatialData.requested_map;

  if (!mapConfig) {
    return <p className="text-secondary text-gray-400">{spatialData?.active_map ? `${spatialData.active_map} can't be drawn yet: this map isn't calibrated.` : 'No position data yet.'}</p>;
  }

  const bySide = e => side === 'both' || e.side === side;
  const deaths = (spatialData?.deaths || []).filter(bySide);
  const kills = (spatialData?.kills || []).filter(bySide);
  const events = layer === 'deaths' ? deaths : kills;
  const spots = topSpots(events);
  const matches = spatialData?.map_stats?.matches_count || 0;
  const dot = layer === 'deaths' ? 'bg-rose-500' : 'bg-emerald-400';

  const toggle = (value, current, set, label) => (
    <button key={value} onClick={() => set(value)} className={`text-secondary rounded-lg px-3 py-1.5 ${current === value ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
      <div className="md:col-span-3">
        <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-black/60 border border-white/10">
          <img src={mapConfig.icon} alt={`${mapConfig.name} minimap`} className="absolute inset-0 w-full h-full object-contain opacity-80 select-none pointer-events-none" />
          {events.map((e, i) => {
            const p = worldToMiniMap(e.x, e.y, activeMapKey);
            return p && <div key={i} className={`absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full ${dot} opacity-45`} style={{ left: `${p.left}%`, top: `${p.top}%` }} />;
          })}
          {spots.map((s, i) => {
            const p = worldToMiniMap(s.x, s.y, activeMapKey);
            return p && (
              <div key={`s${i}`} className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 border-white bg-black/70 grid place-items-center text-secondary font-bold text-white" style={{ left: `${p.left}%`, top: `${p.top}%` }}>{i + 1}</div>
            );
          })}
          {events.length === 0 && (
            <div className="absolute inset-0 grid place-items-center bg-black/60 text-secondary text-gray-300 p-6 text-center">No {layer} on {mapConfig.name} for this side yet.</div>
          )}
        </div>
      </div>

      <div className="md:col-span-2 space-y-4">
        <label className="block text-secondary text-gray-400">
          Map
          <select value={activeMapKey} onChange={e => onSelectMap && onSelectMap(e.target.value)} className="mt-1 block w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-body text-white">
            {(availableMaps.length ? availableMaps : [activeMapKey]).map(mk => <option key={mk} value={mk}>{MAP_CONFIG[mk].name}</option>)}
          </select>
        </label>
        {fellBack && <p className="text-secondary text-amber-300">No matches on {spatialData.requested_map} in your history, so this shows {mapConfig.name}.</p>}
        <div className="flex flex-wrap gap-1">
          {toggle('deaths', layer, setLayer, `Where you died (${deaths.length})`)}
          {toggle('kills', layer, setLayer, `Where you got kills (${kills.length})`)}
        </div>
        <div className="flex flex-wrap gap-1">
          {toggle('both', side, setSide, 'Both sides')}
          {toggle('attack', side, setSide, 'Attack')}
          {toggle('defense', side, setSide, 'Defense')}
        </div>
        <div className="space-y-1">
          <div className="text-body font-semibold text-white">{layer === 'deaths' ? 'Most common death spots' : 'Most common kill spots'}</div>
          {spots.length ? spots.map((s, i) => (
            <p key={i} className="text-secondary text-gray-300 tabular-nums">Spot {i + 1}: {s.count} {layer} ({Math.round((100 * s.count) / events.length)}% of this view)</p>
          )) : <p className="text-secondary text-gray-400">No spot repeats yet.</p>}
        </div>
        <p className="text-min text-gray-400">
          {matches} matches on {mapConfig.name}. Positions are recorded only at the moment of each kill, so this shows where fights ended, not your full path.
        </p>
      </div>
    </div>
  );
}
