import os
import time
import requests
import urllib.parse
import pandas as pd
from dotenv import load_dotenv

from feature_engineer import FeatureEngineer

load_dotenv()

class ValorantScraper:
    def __init__(self, region='ap'):
        self.region = region
        self.seen_players = set()
        self.local_snowball_queue = []
        self.engineer = FeatureEngineer()
        self.queue_file = "data/unprocessed_players.txt"
        
        # Hydrate seen_players from existing CSV to prevent duplication across script restarts
        csv_path = "data/training_features.csv"
        if os.path.exists(csv_path):
            try:
                existing_df = pd.read_csv(csv_path)
                if 'riot_id' in existing_df.columns:
                    for rid in existing_df['riot_id'].dropna():
                        self.seen_players.add(str(rid).lower())
            except Exception as e:
                print(f"Warning: Could not load previous CSV for deduplication: {e}")
                
        # Hydrate unprocessed list so we don't lose queue on crash
        if os.path.exists(self.queue_file):
            try:
                with open(self.queue_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        parts = line.strip().split('#')
                        if len(parts) == 3:
                            self.local_snowball_queue.append({'name': parts[0], 'tag': parts[1], 'region': parts[2]})
                        elif len(parts) == 2:
                            self.local_snowball_queue.append({'name': parts[0], 'tag': parts[1], 'region': self.region})
            except Exception as e:
                pass
        
        # Load API key purely locally
        self.api_key = os.getenv("HENRIK_API_KEY")
        if not self.api_key and os.path.exists("../backend/.env"):
            import re
            with open("../backend/.env", "r") as f:
                match = re.search(r'HENRIK_API_KEY=(.*)', f.read())
                if match: self.api_key = match.group(1).strip()
                
    def get_headers(self):
        headers = {}
        if self.api_key:
            headers['Authorization'] = self.api_key
        return headers

    def get_seed_players_from_leaderboard(self):
        print("Fetching leaderboard for seeds...")
        try:
            res = requests.get(f"https://api.henrikdev.xyz/valorant/v2/leaderboard/{self.region}", headers=self.get_headers(), timeout=15)
            if res.status_code == 200:
                print("Players fetched successfully")
                players = res.json().get('data', [])
                return [{'name': p['gameName'], 'tag': p['tagLine'], 'region': self.region} for p in players if p.get('gameName') and p.get('tagLine')]
        except Exception as e:
            print("Error fetching leaderboard:", e)
        return []

    def _parse_henrik_matches_to_df(self, matches_list, riot_id):
        rows = []
        for m in matches_list:
            if not m or not m.get('metadata'):
                continue
                
            all_players = m.get('players', {}).get('all_players', [])
            player_stats = None
            for p in all_players:
                if f"{p.get('name')}#{p.get('tag')}".lower() == riot_id:
                    player_stats = p
                    break
                    
            if not player_stats:
                continue
                
            stats = player_stats.get('stats', {})
            damage_made = player_stats.get('damage_made', 0)
            damage_received = player_stats.get('damage_received', 0)
            rounds_played = m.get('metadata', {}).get('rounds_played', 1)
            acs = stats.get('score', 0) / max(rounds_played, 1)
            
            behavior = player_stats.get('behavior', {})
            plants = behavior.get('plants', 0)
            defuses = behavior.get('defuses', 0)
            if 'plants' in stats: plants = stats.get('plants', plants)
            if 'defuses' in stats: defuses = stats.get('defuses', defuses)

            row = {
                'matchId': m['metadata']['matchid'],
                'playedAt': m['metadata']['game_start'],
                'kills': stats.get('kills', 0),
                'deaths': stats.get('deaths', 0),
                'assists': stats.get('assists', 0),
                'plants': plants,
                'defuses': defuses,
                'total_rounds': max(rounds_played, 1),
                'acs': acs,
                'damage': {'made': damage_made, 'received': damage_received},
                'shots': {
                    'head': stats.get('headshots', 0),
                    'body': stats.get('bodyshots', 0),
                    'leg': stats.get('legshots', 0)
                },
                'rounds': m.get('rounds', []),
                'kill_events': []
            }
            
            for k in m.get('kills', []):
                killer_name = k.get('killer_display_name', '')
                victim_name = k.get('victim_display_name', '')
                
                v_profile = next((p for p in all_players if f"{p.get('name')}#{p.get('tag')}".lower() == victim_name.lower()), None)
                v_tier = v_profile.get('currenttier_patched', 'Silver') if v_profile else 'Silver'
                
                row['kill_events'].append({
                    'kill_time_in_round': k.get('kill_time_in_round', 9999999),
                    'kill_time_in_match': k.get('kill_time_in_match', 0),
                    'killer_display_name': killer_name,
                    'victim_display_name': victim_name,
                    'victim_tier': v_tier
                })
                
            # Safely append completely unseen teammates directly to persistent Queue logs
            match_region = m.get('metadata', {}).get('region', self.region)
            for p in all_players:
                pn, pt = p.get('name'), p.get('tag')
                if pn and pt:
                    pid = f"{pn}#{pt}".lower()
                    # Only append if they aren't completely analyzed, preventing file bloat
                    if pid not in self.seen_players:
                        self.local_snowball_queue.append({'name': pn, 'tag': pt, 'region': match_region})
                        with open(self.queue_file, "a", encoding='utf-8') as f:
                            f.write(f"{pn}#{pt}#{match_region}\n")
                
            rows.append(row)
            
        if not rows:
            return pd.DataFrame()
            
        df = pd.DataFrame(rows)
        # Convert unix timestamp to datetime (pandas native)
        df['playedAt'] = pd.to_datetime(df['playedAt'], unit='s')
        return df

    def process_player(self, name, tag, region=None):
        active_region = region if region else self.region
        riot_id = f"{name}#{tag}".lower()
        print(f"\nProcessing {riot_id} ({active_region})...")
        
        encoded_name = urllib.parse.quote(name)
        encoded_tag = urllib.parse.quote(tag)
        headers = self.get_headers()
        
        # 1. Fetch MMR
        mmr_url = f"https://api.henrikdev.xyz/valorant/v2/mmr/{active_region}/{encoded_name}/{encoded_tag}"
        try:
            res = requests.get(mmr_url, headers=headers, timeout=15)
        except Exception as e:
            print(f"  [-] Connection dropped on MMR API. {e}")
            return False
            
        if res.status_code == 429:
            print("  [!] API Rate Limit Hit (429) on MMR. Backing off for 60s...")
            time.sleep(60)
            return "RATE_LIMIT"
        elif res.status_code != 200:
            print(f"  [-] Failed MMR API: {res.status_code} - {res.text}")
            return False
            
        mmr_data = res.json().get('data', {})
        current_rank = mmr_data.get('current_data', {}).get('currenttierpatched', 'Unranked')
        if current_rank in ['Unranked', None, '']:
            print("  [!] Player is Unranked. Skipping training label.")
            return True
            
        # 2. Fetch Matches
        matches_url = f"https://api.henrikdev.xyz/valorant/v3/matches/{active_region}/{encoded_name}/{encoded_tag}?mode=competitive&size=20"
        try:
            res_matches = requests.get(matches_url, headers=headers, timeout=20)
        except Exception as e:
            print(f"  [-] Connection dropped on Matches API. {e}")
            return False
            
        if res_matches.status_code == 429:
            print("  [!] API Rate Limit Hit (429) on Matches. Backing off for 60s...")
            time.sleep(20)
            return "RATE_LIMIT"
        elif res_matches.status_code != 200:
             print(f"  [-] Failed Matches API: {res_matches.status_code} - {res_matches.text}")
             return False
             
        print("  [+] Matches fetched directly into memory.")
             
        # 3. Parse into DataFrame and Snowball
        matches_list = res_matches.json().get('data', [])
        df = self._parse_henrik_matches_to_df(matches_list, riot_id)
        if len(df) < 10: # Rigid enforcement strictly at 10 (maximum API payload)
            print(f"  [!] Not enough competitive matches ({len(df)}/10). Skipping.")
            return True

        # 4. Compute Feature Vector
        try:
            features = self.engineer.compute_features(df, riot_id)
            if not features:
                return True
                
            features['target_rank'] = current_rank
            features['riot_id'] = riot_id
            
            csv_path = "data/training_features.csv"
            os.makedirs(os.path.dirname(csv_path), exist_ok=True)
            
            df_features = pd.DataFrame([features])
            write_header = not os.path.exists(csv_path)
            df_features.to_csv(csv_path, mode='a', index=False, header=write_header)
            
            print(f"  [+] Feature Vector saved to CSV! ({current_rank})")
            
        except Exception as e:
            print(f"  [-] Feature Engineering crashed: {e}")

        return True

    def run_crawler(self, limit=1000):
        print("====== Pure Python Valorant Scraper Started ======")
        queue = []
        
        # Pull any dynamic seeds queued from recent runs
        queue.extend(self.local_snowball_queue)
        self.local_snowball_queue = []
        
        if len(queue) < 10:
            queue.extend(self.get_seed_players_from_leaderboard())
            
        unique_queue = []
        for p in queue:
            pid = f"{p['name']}#{p['tag']}".lower()
            if pid not in self.seen_players:
                self.seen_players.add(pid)
                unique_queue.append(p)
                
        # CRITICAL FIX: Rewrite the unique queue safely back to the cache file.
        # This guarantees that if you press Ctrl+C, the remaining un-crawled 
        # players are securely saved to the queue file for the next boot!
        try:
            with open(self.queue_file, "w", encoding='utf-8') as f:
                for u in unique_queue:
                    f.write(f"{u['name']}#{u['tag']}#{u.get('region', 'ap')}\n")
        except Exception as e:
            print(f"Warning: Failed to rewrite cache queue -> {e}")
            
        print(f"Found {len(unique_queue)} potential players to scrape in this block.")
        
        count = 0
        for p in unique_queue:
            if count >= limit:
                break
                
            success = False
            retries = 0
            while not success and retries < 3:
                result = self.process_player(p['name'], p['tag'], p.get('region', 'ap'))
                if result == "RATE_LIMIT":
                    retries += 1
                    print(f"  [↻] Retrying {p['name']}#{p['tag']} ({retries}/3)...")
                else:
                    success = True
                    
            count += 1
            # Rate limit is 30 req/min. We do 2 requests per player. 
            # 5 seconds sleep ensures about 12 players/min (24 req/min).
            time.sleep(5) 

        print("\n====== Scraping Block Complete ======")

if __name__ == "__main__":
    scraper = ValorantScraper(region='ap')
    while True:
        scraper.run_crawler(limit=1000)
