import React, { useState } from 'react';
import axios from 'axios';
import { AlertCircle, Compass } from 'lucide-react';
import SearchHero from './components/SearchHero';
import Dashboard from './components/Dashboard';
import DevTelemetryLabeler from './components/DevTelemetryLabeler';

function App() {
  const [data, setData] = useState(null);
  const [activeParams, setActiveParams] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null); // first visit: background sync of match history
  const [isDevMode, setIsDevMode] = useState(() => window.location.search.includes('dev') || window.location.hash.includes('dev'));

  // The backend never fetches history inside a request: a new player gets 202 + progress, and we poll until synced
  const waitForSync = async (riotId) => {
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const { data: p } = await axios.get(`/api/ingest/progress/${encodeURIComponent(riotId)}`);
      setSyncProgress(p);
      if (p.status === 'completed') return;
      if (p.status === 'error') throw new Error(p.error || 'Sync failed. Check the Riot ID and region, then try again.');
    }
  };

  const handleSearch = async (region, name, tag) => {
    setIsLoading(true);
    setError(null);
    try {
      const url = `/api/coaching/${encodeURIComponent(region)}/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`;
      let response = await axios.get(url, { timeout: 60000 });
      if (response.status === 202) {
        setSyncProgress(response.data.progress);
        await waitForSync(`${name.trim()}#${tag.trim()}`.toLowerCase());
        response = await axios.get(url, { timeout: 60000 });
        if (response.status === 202) throw new Error('No supported matches found yet (competitive, unrated or premier).');
      }
      setData(response.data);
      setActiveParams({ 
        region, 
        name, 
        tag, 
        map: response.data.analysis?.context?.map || 'ascent', 
        role: response.data.analysis?.context?.role || 'Duelist' 
      });
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.message ||
        'Service temporarily unavailable. Please try again shortly.'
      );
    } finally {
      setIsLoading(false);
      setSyncProgress(null);
    }
  };

  const handleSwitchContext = async (newMap, newRole) => {
    if (!activeParams) return;
    const targetMap = newMap || activeParams.map;
    const targetRole = newRole || activeParams.role;
    
    setIsLoading(true);
    try {
      const response = await axios.get(
        `/api/coaching/${encodeURIComponent(activeParams.region)}/${encodeURIComponent(activeParams.name.trim())}/${encodeURIComponent(activeParams.tag.trim())}?map=${encodeURIComponent(targetMap)}&role=${encodeURIComponent(targetRole)}`
      );
      setData(response.data);
      setActiveParams(prev => ({ ...prev, map: targetMap, role: targetRole }));
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to update map/role debrief.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen font-sans bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-gray-900 via-valo-dark to-black text-white selection:bg-valo-red selection:text-white">
      
      {/* Navbar */}
      <nav className="p-4 sm:p-6 border-b border-white/5 bg-black/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex flex-wrap justify-between items-center gap-3">
          <div 
            onClick={() => { setData(null); setActiveParams(null); setError(null); setIsDevMode(false); }} 
            className="flex items-center gap-3 cursor-pointer group"
          >
            <div className="w-8 h-8 bg-valo-red rounded-sm transform rotate-45 group-hover:rotate-90 transition-transform duration-500 shadow-[0_0_12px_#ff4655]"></div>
            <span className="font-black text-section tracking-widest uppercase">ValoCoach</span>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Dev Labeler Toggle */}
            <button
              onClick={() => setIsDevMode(prev => !prev)}
              className={`text-min font-bold tracking-wider uppercase px-3.5 py-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 ${
                isDevMode
                  ? 'bg-valo-red/20 text-valo-red border-valo-red/50 shadow-[0_0_15px_#ff465530]'
                  : 'bg-white/10 text-gray-300 border-white/10 hover:text-white hover:bg-white/15'
              }`}
            >
              <span className="whitespace-nowrap">{isDevMode ? 'Back to report' : 'Round labeler'}</span>
            </button>

            {data && !isDevMode && (
              <button 
                onClick={() => { setData(null); setActiveParams(null); }}
                className="text-min font-bold tracking-widest uppercase px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/10 rounded-xl text-gray-300 hover:text-white transition-all cursor-pointer"
              >
                New search
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="py-6 px-4 relative z-10">
        {error && (
          <div className="max-w-xl mx-auto mb-6 animate-slide-up relative z-40">
            <div className="bg-red-950/95 border-2 border-red-500/60 text-red-200 p-4 rounded-2xl flex items-start justify-between gap-3 shadow-2xl backdrop-blur-md">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-valo-red shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-white text-secondary">System Notice</p>
                  <p className="text-red-300 leading-relaxed text-min mt-1">
                    {error.includes('502') || error.toLowerCase().includes('network error')
                      ? 'Temporary server connection timeout. Connectivity restored—please try searching again.'
                      : error}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setError(null)}
                className="text-gray-400 hover:text-white text-min font-bold px-2 py-1 rounded-lg hover:bg-white/10 transition-all cursor-pointer"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {isDevMode ? (
          <DevTelemetryLabeler onBackToDashboard={() => setIsDevMode(false)} />
        ) : !data ? (
          <>
            <SearchHero onSearch={handleSearch} isLoading={isLoading} />
            {syncProgress && (
              <div className="max-w-xl mx-auto mt-4 rounded-xl bg-gray-900/80 border border-white/10 p-4 text-body text-gray-200">
                <div>First visit: fetching your recent matches ({syncProgress.processed || 0} of {syncProgress.total || 50}). This takes about a minute.</div>
                <div className="mt-2 h-2 rounded bg-white/10 overflow-hidden"><div className="h-full bg-valo-red transition-all" style={{ width: `${syncProgress.percent || 0}%` }} /></div>
              </div>
            )}
          </>
        ) : (
          <Dashboard 
            data={data} 
            activeParams={activeParams}
            onSwitchContext={handleSwitchContext}
            isSwitching={isLoading}
          />
        )}
      </main>

    </div>
  );
}

export default App;
