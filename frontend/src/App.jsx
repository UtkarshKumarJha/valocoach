import React, { useState } from 'react';
import axios from 'axios';
import { AlertCircle } from 'lucide-react';
import SearchHero from './components/SearchHero';
import Dashboard from './components/Dashboard';

function App() {
  const [data, setData] = useState(null);
  const [activeParams, setActiveParams] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSearch = async (region, name, tag) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.get(
        `/api/coaching/${encodeURIComponent(region)}/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`
      );
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
      <nav className="p-6 border-b border-white/5 bg-black/40 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div 
            onClick={() => { setData(null); setActiveParams(null); setError(null); }} 
            className="flex items-center gap-3 cursor-pointer group"
          >
            <div className="w-8 h-8 bg-valo-red rounded-sm transform rotate-45 group-hover:rotate-90 transition-transform duration-500 shadow-[0_0_12px_#ff4655]"></div>
            <span className="font-black text-xl tracking-widest uppercase">ValoCoach</span>
          </div>
          {data && (
            <button 
              onClick={() => { setData(null); setActiveParams(null); }}
              className="text-xs font-bold tracking-widest uppercase px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg text-gray-300 hover:text-white transition-all cursor-pointer"
            >
              ← Search Another Player
            </button>
          )}
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="py-8 relative z-10">
        {error && (
          <div className="max-w-xl mx-auto mb-6 px-4 animate-slide-up">
            <div className="bg-red-950/90 border border-red-500/50 text-red-200 p-4 rounded-2xl flex items-start justify-between gap-3 shadow-2xl backdrop-blur-md">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-valo-red shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-white text-sm">System Notice</p>
                  <p className="text-red-300 leading-relaxed text-xs mt-0.5">{error}</p>
                </div>
              </div>
              <button 
                onClick={() => setError(null)}
                className="text-gray-400 hover:text-white text-xs font-bold px-2 py-1 rounded hover:bg-white/10 transition-all cursor-pointer"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {!data ? (
          <SearchHero onSearch={handleSearch} isLoading={isLoading} />
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
