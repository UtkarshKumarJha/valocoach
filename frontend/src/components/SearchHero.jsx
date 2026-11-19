import React, { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';

export default function SearchHero({ onSearch, isLoading }) {
  const [riotId, setRiotId] = useState('');
  const [region, setRegion] = useState('ap');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (riotId.includes('#')) {
      const [name, tag] = riotId.split('#');
      onSearch(region, name, tag);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] max-w-2xl mx-auto text-center px-4 animate-fade-in">
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-valo-red/10 border border-valo-red/30 text-valo-red text-min font-black tracking-widest uppercase mb-6 animate-pulse">
        ✦ Habit coaching from your last 50 matches
      </div>

      <h1 className="text-title font-black italic tracking-tight mb-4 uppercase text-transparent bg-clip-text bg-gradient-to-r from-valo-light to-gray-400">
        AI Match <span className="text-valo-red">Coach</span>
      </h1>
      
      <p className="text-gray-400 mb-8 text-body max-w-lg">
        See the habits behind your rounds: where you die, whether you trade, how you buy, compared with players in your own lobbies.
      </p>

      <form onSubmit={handleSubmit} className="w-full space-y-4">
        {/* Riot ID & Region Search Input Container - Flex layout with ZERO overlap */}
        <div className="flex items-center bg-valo-gray/70 border-2 border-white/10 rounded-2xl p-2 focus-within:border-valo-red focus-within:shadow-[0_0_25px_#ff465530] transition-all shadow-2xl gap-2">
          {/* Region Pill */}
          <div className="shrink-0 bg-black/60 border border-white/10 rounded-xl px-3 py-2 flex items-center">
            <select 
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="bg-transparent text-gray-200 font-bold text-min sm:text-secondary outline-none cursor-pointer hover:text-white disabled:opacity-50"
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
            placeholder="Name#TAG"
            required
            disabled={isLoading}
            value={riotId}
            onChange={(e) => setRiotId(e.target.value)}
            className="flex-1 bg-transparent px-3 py-2 text-body font-medium text-white placeholder-gray-500 focus:outline-none disabled:opacity-50 min-w-0"
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

      </form>
    </div>
  );
}
