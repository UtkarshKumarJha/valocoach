import pandas as pd
import numpy as np

RANK_MULTIPLIERS = {
    "Iron": 0.5,
    "Bronze": 0.7,
    "Silver": 1.0,
    "Gold": 1.3,
    "Platinum": 1.6,
    "Diamond": 2.0,
    "Ascendant": 2.25, # Added Ascendant to be safe
    "Immortal": 2.5,
    "Radiant": 3.0
}

def get_rank_multiplier(tier_str):
    if not isinstance(tier_str, str):
        return 1.0
    for rank, mult in RANK_MULTIPLIERS.items():
        if rank.lower() in tier_str.lower():
            return mult
    return 1.0

class FeatureEngineer:
    def __init__(self):
        pass

    def compute_features(self, df: pd.DataFrame, player_riot_id: str) -> dict:
        """
        Transforms raw MongoDB match records into a single flat dict for the given player.
        """
        if df.empty:
            return {}
            
        df = df.copy()
        df['playedAt'] = pd.to_datetime(df['playedAt'])
        df = df.sort_values('playedAt').reset_index(drop=True)
        
        per_match_data = []
        for _, row in df.iterrows():
            rounds = row.get('rounds', [])
            if not isinstance(rounds, list): rounds = []
            total_rounds = len(rounds)
            
            # hs_pct
            shots = row.get('shots', {})
            if not isinstance(shots, dict): shots = {}
            head, body, leg = shots.get('head', 0), shots.get('body', 0), shots.get('leg', 0)
            hs_pct = head / (head + body + leg) if (head + body + leg) > 0 else 0
            
            # dmg_delta
            dmg = row.get('damage', {})
            if not isinstance(dmg, dict): dmg = {}
            dmg_delta = dmg.get('made', 0) - dmg.get('received', 0)
            
            # kdr
            kills = row.get('kills', 0)
            deaths = row.get('deaths', 0)
            kdr = kills / max(deaths, 1)
            
            # rank_adjusted_kda and first bloods/deaths
            rank_adjusted_sum = 0
            first_bloods = 0
            first_deaths = 0
            
            # To get round-by-round first bloods/deaths, we group kill events by 'kill_time_in_match' 
            # or just look at the lowest 'kill_time_in_round' for each round interval.
            # A simpler way: we just find the absolute earliest kill in each round via the rounds array.
            
            kill_events = row.get('kill_events', [])
            if not isinstance(kill_events, list): kill_events = []
            
            if len(kill_events) > 0:
                # Calculate rank adjusted KD based on victims
                for k in kill_events:
                    # If current player is the killer
                    if k.get('killer_display_name', '').lower() == player_riot_id.lower():
                        victim_tier = k.get('victim_tier') or 'Silver' # fallback
                        rank_adjusted_sum += get_rank_multiplier(victim_tier)

                # Group kills by relatively close kill_time_in_match to determine rounds, or just use chronological order
                # The prompt asks for first deaths/kills per round. 
                # Henrik API's global kill_events array allows grouping by rounds if we sort them by kill_time_in_match
                # and split when intervals are > 60000ms. Since we have 'kill_time_in_round' natively, 
                # any kill with the absolute smallest kill_time_in_round for a segment is the first kill. 
                pass

            # Since grouping kill_events into rounds perfectly requires complex matching, 
            # let's assume we can map them efficiently or use heuristics if the data isn't perfect.
            # For exact first blood:
            rounds_kills = {}
            for k in kill_events:
                kr = k.get('kill_time_in_round', 9999999)
                km = k.get('kill_time_in_match', 0)
                # Group by matching kill_time_in_match roughly
                # A robust way is matching `kill_time_in_match - kill_time_in_round` which identifies the round start
                round_id = (km - kr) // 1000 
                if round_id not in rounds_kills:
                    rounds_kills[round_id] = []
                rounds_kills[round_id].append(k)

            for rid, rkills in rounds_kills.items():
                rkills.sort(key=lambda x: x.get('kill_time_in_round', 0))
                if rkills:
                    first_k = rkills[0]
                    if first_k.get('killer_display_name', '').lower() == player_riot_id.lower():
                        first_bloods += 1
                    if first_k.get('victim_display_name', '').lower() == player_riot_id.lower():
                        first_deaths += 1

            first_blood_rate = first_bloods / max(total_rounds, 1)
            first_death_rate = first_deaths / max(total_rounds, 1)
            rank_adjusted_kda = rank_adjusted_sum / max(deaths, 1)
            
            plants = row.get('plants', 0)
            defuses = row.get('defuses', 0)
            assists = row.get('assists', 0)
            
            # Simple Survival/KAST proxy: If they died less times than total rounds played, 
            # they survived the remaining rounds!
            total_rounds_played = row.get('total_rounds', max(total_rounds, 1))
            survivals = max(total_rounds_played - deaths, 0)
            survival_rate = survivals / max(total_rounds_played, 1)
            
            per_match_data.append({
                'hs_pct': hs_pct,
                'dmg_delta': dmg_delta,
                'kdr': kdr,
                'rank_adjusted_kda': rank_adjusted_kda,
                'first_blood_rate': first_blood_rate,
                'first_death_rate': first_death_rate,
                'acs': row.get('acs', 0),
                'assists': assists,
                'plants': plants,
                'defuses': defuses,
                'survival_rate': survival_rate
            })
            
        metrics_df = pd.DataFrame(per_match_data)
        
        output = {}
        if len(metrics_df) == 0:
            return {}
            
        columns = [
            'hs_pct', 'dmg_delta', 'kdr', 'rank_adjusted_kda', 
            'first_blood_rate', 'first_death_rate', 'acs',
            'assists', 'plants', 'defuses', 'survival_rate'
        ]
        
        last_window = metrics_df.tail(10)
        for col in columns:
            if col in last_window.columns:
                output[f'{col}_mean_10'] = float(last_window[col].mean())
                output[f'{col}_std_10'] = float(last_window[col].std() if len(last_window) > 1 else 0.0)
            else:
                output[f'{col}_mean_10'] = 0.0
                output[f'{col}_std_10'] = 0.0
                
        return output
