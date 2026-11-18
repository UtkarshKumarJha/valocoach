import sqlite3
import pandas as pd
import json
import os

# Individual rank tier calibration scales (every rank tier scaled differently)
INDIVIDUAL_TIER_SCALES = {
    'iron 1': 0.40, 'iron 2': 0.44, 'iron 3': 0.48, 'iron': 0.44,
    'bronze 1': 0.52, 'bronze 2': 0.56, 'bronze 3': 0.60, 'bronze': 0.56,
    'silver 1': 0.64, 'silver 2': 0.68, 'silver 3': 0.72, 'silver': 0.68,
    'gold 1': 0.76, 'gold 2': 0.80, 'gold 3': 0.84, 'gold': 0.80,
    'platinum 1': 0.87, 'platinum 2': 0.90, 'platinum 3': 0.93, 'platinum': 0.90,
    'diamond 1': 0.95, 'diamond 2': 0.97, 'diamond 3': 0.99, 'diamond': 0.97,
    'ascendant 1': 1.01, 'ascendant 2': 1.03, 'ascendant 3': 1.05, 'ascendant': 1.03,
    'immortal 1': 1.07, 'immortal 2': 1.09, 'immortal 3': 1.11, 'immortal': 1.09,
    'radiant': 1.15
}

class WeaknessTagger:
    def __init__(self, meta_path='data/weakness_baseline.json'):
        self.meta_path = meta_path
        self.vct_baseline = {}
        
        if os.path.exists(self.meta_path):
            with open(self.meta_path, 'r') as f:
                self.vct_baseline = json.load(f)
        else:
            print(f"Warning: Baseline Meta {self.meta_path} not found. Ensure you run train_all.py")

    def get_tier_scale(self, rank_str: str) -> tuple[float, str]:
        """Resolves individual tier scale factor and canonical label."""
        r = (rank_str or "Silver 2").strip().lower()
        # Direct match first (e.g. 'iron 1', 'bronze 3')
        if r in INDIVIDUAL_TIER_SCALES:
            return INDIVIDUAL_TIER_SCALES[r], rank_str
        
        # Substring matching for variations like 'Silver 1 - 42 RR'
        for tier_key, scale in INDIVIDUAL_TIER_SCALES.items():
            if tier_key in r:
                return scale, tier_key.title()
                
        return 0.68, "Silver 2"

    def tag_player(self, player_features: dict, current_rank: str) -> list:
        """
        Calculates Game-Sense Anomaly Deviation calibrated to the player's exact individual rank tier.
        """
        tags = []
        if not self.vct_baseline:
            return ["Baseline data unavailable."]
            
        pro = self.vct_baseline
        scale, canonical_tier = self.get_tier_scale(current_rank)
        
        # 1. Extrapolate 10-Match Metrics
        hs_pct = player_features.get('hs_pct_mean_10', 0)
        f_death = player_features.get('first_death_rate_mean_10', 0)
        f_kill = player_features.get('first_blood_rate_mean_10', 0)
        acs = player_features.get('acs_mean_10', 0)
        dmg_delta = player_features.get('dmg_delta_mean_10', 0)
        
        plants = player_features.get('plants_mean_10', 0)
        defuses = player_features.get('defuses_mean_10', 0)
        kast = player_features.get('survival_rate_mean_10', 0)
        ast = player_features.get('assists_mean_10', 0)
        
        # Target thresholds calibrated individually for this specific rank tier
        target_hs = pro.get('hs_pct', 0.24) * scale
        target_fd = pro.get('fd_rate', 0.08) * (1.0 / scale)
        target_kast = pro.get('kast_pct', 0.70) * scale

        # Heuristic 1: Aim Discipline
        if hs_pct < target_hs * 0.8:
            tags.append(f"Subpar Headshot Accuracy ({hs_pct*100:.1f}% vs {canonical_tier} target {target_hs*100:.1f}%)")
            
        # Heuristic 2: Overpushing / Opening Discipline
        if f_death > (target_fd * 1.3) and kast < target_kast:
            tags.append(f"Opening Overextension (High First Deaths, Low Survival % in {canonical_tier})")
            
        # Heuristic 3: Passive Baiting / Objective Averse
        pro_plants = pro.get('plants', 1.0) * scale
        pro_def = pro.get('defuses', 1.0) * scale
        if plants < (pro_plants * 0.4) and defuses < (pro_def * 0.4) and f_kill < (pro.get('fk_rate', 0.08) * 0.25) and acs > 150:
            tags.append(f"Objective Averse / Passive Baiting (Low Spike interaction in {canonical_tier})")
            
        # Heuristic 4: Lone Wolf / Disconnected
        target_ast = (pro.get('ast_rate', 0.2) * 21) * scale
        if ast < (target_ast * 0.5):
            tags.append(f"Lone Wolf Spacing (Significantly lower trade/utility assists than {canonical_tier} peers)")
            
        # Heuristic 5: Empty Impact
        if dmg_delta < 0 and acs > (pro.get('acs', 200) * scale):
            tags.append("Empty Impact / High Score but Negative Damage Delta (Losing Critical Duels)")
            
        # Exceptional Entry
        if f_kill > (pro.get('fk_rate', 0.08) * 1.3) and f_death < target_fd:
             tags.append(f"Elite Opening Duel Success Rate for {canonical_tier}")
            
        if not tags:
            tags.append(f"Game Sense and Mechanics align solidly with {canonical_tier} benchmarks.")
            
        return tags

    def train(self, db_path='datasets/valorant.sqlite'):
        """
        Connects to the VCT Pro SQLite database ONCE during training to establish 
        the ultimate baseline of mechanical perfection. Saves to JSON.
        """
        print("Calculating Medians from VCT SQLite Database for Weakness Tagger...")
        if not os.path.exists(db_path):
            print(f"ERROR: Pro DB {db_path} not found. Cannot train.")
            return
            
        try:
            conn = sqlite3.connect(db_path)
            query = """
            SELECT 
                s.ACS,
                s.ADR,
                CAST(REPLACE(s.HS_Percent, '%', '') AS FLOAT) as hs_pct,
                CAST(REPLACE(s.KAST_Percent, '%', '') AS FLOAT) as kast_pct,
                (CAST(s.FirstKills AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as FirstKillRate,
                (CAST(s.FirstDeaths AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as FirstDeathRate,
                (CAST(s.Assists AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as AssistRate,
                s.Plants,
                s.Defuses
            FROM Game_Scoreboard s
            JOIN Games g ON s.GameID = g.GameID
            WHERE g.Team1_TotalRounds IS NOT NULL;
            """
            df = pd.read_sql_query(query, conn)
            conn.close()
            
            from sklearn.model_selection import train_test_split
            df_train, df_test = train_test_split(df, test_size=0.2, random_state=42)
            
            baseline = {
                'acs': float(df_train['ACS'].median() if not df_train['ACS'].empty else 200),
                'hs_pct': float(df_train['hs_pct'].median() if not df_train['hs_pct'].empty else 0.24),
                'kast_pct': float(df_train['kast_pct'].median() if not df_train['kast_pct'].empty else 0.70),
                'fk_rate': float(df_train['FirstKillRate'].median() if not df_train['FirstKillRate'].empty else 0.08),
                'fd_rate': float(df_train['FirstDeathRate'].median() if not df_train['FirstDeathRate'].empty else 0.08),
                'ast_rate': float(df_train['AssistRate'].median() if not df_train['AssistRate'].empty else 0.2),
                'plants': float(df_train['Plants'].median() if not df_train['Plants'].empty else 1.0),
                'defuses': float(df_train['Defuses'].median() if not df_train['Defuses'].empty else 1.0)
            }
            
            os.makedirs(os.path.dirname(self.meta_path), exist_ok=True)
            with open(self.meta_path, 'w') as f:
                json.dump(baseline, f, indent=4)
                
            print(f"Weakness Tagger baseline calculated! Saved to {self.meta_path}.")
            self.vct_baseline = baseline
            
            # BLIND TEST METRICS
            perfect_matches = 0
            for _, row in df_test.iterrows():
                features = {
                    'hs_pct_mean_10': row['hs_pct'],
                    'first_death_rate_mean_10': row['FirstDeathRate'],
                    'first_blood_rate_mean_10': row['FirstKillRate'],
                    'acs_mean_10': row['ACS'],
                    'dmg_delta_mean_10': 10,
                    'plants_mean_10': row['Plants'],
                    'defuses_mean_10': row['Defuses'],
                    'survival_rate_mean_10': row['kast_pct'],
                    'assists_mean_10': row['AssistRate'] * 21
                }
                tags = self.tag_player(features, "Radiant")
                if tags and "Game Sense and Mechanics align robustly" in tags[0]:
                    perfect_matches += 1
            
            acc = (perfect_matches / len(df_test)) * 100 if len(df_test) > 0 else 0
            print("  -> BLIND TEST METRICS:")
            print(f"  -> Total Unseen Pros Tested: {len(df_test)}")
            print(f"  -> Pro Alignment Accuracy: {acc:.1f}%")
            
        except Exception as e:
            print(f"Error building VCT baseline: {e}")
