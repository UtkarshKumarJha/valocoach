import json
import pandas as pd
import os
import glob

AGENT_ROLES = {
    'jett': 'Duelist', 'reyna': 'Duelist', 'raze': 'Duelist', 'phoenix': 'Duelist', 'yoru': 'Duelist', 'neon': 'Duelist', 'iso': 'Duelist',
    'omen': 'Controller', 'viper': 'Controller', 'brimstone': 'Controller', 'astra': 'Controller', 'harbor': 'Controller', 'clove': 'Controller',
    'sova': 'Initiator', 'breach': 'Initiator', 'skye': 'Initiator', 'kayo': 'Initiator', 'fade': 'Initiator', 'gekko': 'Initiator',
    'killjoy': 'Sentinel', 'cypher': 'Sentinel', 'sage': 'Sentinel', 'chamber': 'Sentinel', 'deadlock': 'Sentinel', 'vyse': 'Sentinel'
}

class AgentRecommender:
    def __init__(self, meta_path='data/agent_meta.json'):
        self.meta_path = meta_path
        self.map_meta = {}
        
        if os.path.exists(self.meta_path):
            with open(self.meta_path, 'r') as f:
                self.map_meta = json.load(f)
        else:
            print(f"Warning: Pro Meta {self.meta_path} not found. Ensure you run train_all.py")

    def train(self):
        """
        Preprocesses all 6 years of VCT data (vct_2021 to vct_2026) natively using CSV sources.
        Aggregates thousands of pro matches into incredibly precise Agent Pick Rate medians per map.
        Calculates role dominance.
        Saves resulting tiny dictionary to JSON.
        """
        print("Crunching VCT CSV Data for Agent Recommender...")
        
        # We find agent_pick_rates.csv anywhere inside datasets/vct_*/agents/ 
        # (This accommodates vct_2021...vct_2026)
        csv_files = glob.glob(os.path.join("datasets", "vct_*", "agents", "agents_pick_rates.csv"))
        if not csv_files:
            print("ERROR: No VCT pick rate files found. Please ensure VCT folders exist.")
            return

        df_list = []
        for file in csv_files:
            try:
                df = pd.read_csv(file)
                if all(col in df.columns for col in ['Map', 'Agent', 'Pick Rate']):
                    df['Pick Rate'] = df['Pick Rate'].astype(str).str.replace('%', '', regex=False)
                    df['Pick Rate'] = pd.to_numeric(df['Pick Rate'], errors='coerce') / 100.0
                    df_list.append(df)
            except Exception as e:
                print(f"Failed to read {file}: {e}")

        if not df_list:
            print("No valid datasets parsed.")
            return

        combined = pd.concat(df_list, ignore_index=True)
        combined = combined.dropna(subset=['Pick Rate'])
        
        # Filter out generic 'All Maps' reporting
        combined = combined[combined['Map'].str.lower() != 'all maps']
        combined['Map'] = combined['Map'].str.lower().str.strip()
        combined['Agent'] = combined['Agent'].str.lower().str.strip()

        # Group globally to get definitive cross-year VCT average pick rates
        aggs = combined.groupby(['Map', 'Agent'])['Pick Rate'].mean().reset_index()

        self.map_meta = {}
        for m in aggs['Map'].unique():
            self.map_meta[m] = {'Duelist': [], 'Controller': [], 'Initiator': [], 'Sentinel': []}

        for _, row in aggs.iterrows():
            m = row['Map']
            a = row['Agent']
            pr = row['Pick Rate']
            role = AGENT_ROLES.get(a)
            if role and m in self.map_meta:
                self.map_meta[m][role].append((a, pr))

        # Sort all lists by descending pick rate
        for m in self.map_meta:
            for role in self.map_meta[m]:
                self.map_meta[m][role].sort(key=lambda x: x[1], reverse=True)

        os.makedirs(os.path.dirname(self.meta_path), exist_ok=True)
        with open(self.meta_path, 'w') as f:
            json.dump(self.map_meta, f, indent=4)
            
        print(f"Agent Recommender trained! Meta dictionary saved to {self.meta_path}.")

    def recommend(self, map_name: str, preferred_role: str) -> list:
        """
        Recommends the strongest Agent for a specific map and role based on fast JSON dictionary lookup.
        """
        if not self.map_meta:
            return ["No meta data available. (Is the model trained?)"]
            
        m = map_name.lower().strip()
        if m not in self.map_meta:
            return [f"We do not have sufficient professional data for {map_name.capitalize()} yet."]
            
        role_meta = self.map_meta[m].get(preferred_role, [])
        if not role_meta:
            return [f"No highly-viable {preferred_role} found on {map_name.capitalize()} in pro play."]
            
        # Top 2 recommendations
        recs = [f"Pick {agent.capitalize()} (VCT Average Pick Rate: {pr*100:.1f}%)" for agent, pr in role_meta[:2]]
        return recs
