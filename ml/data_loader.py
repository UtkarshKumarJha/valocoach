import os
import certifi
import pandas as pd
from pymongo import MongoClient
from dotenv import load_dotenv

# Load environment logic pointing to either an ml-specific .env or a shared one
if os.path.exists('.env'):
    load_dotenv('.env')
elif os.path.exists('../backend/.env'):
    load_dotenv('../backend/.env')
else:
    load_dotenv()

MONGO_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/valocoach")

class MongoLoader:
    def __init__(self):
        if "mongodb+srv" in MONGO_URI:
            self.client = MongoClient(MONGO_URI, tlsCAFile=certifi.where())
        else:
            self.client = MongoClient(MONGO_URI)
            
        # Extract DB name from URI or default to 'test' (Mongoose default)
        db_name = 'test'
        if MONGO_URI.rsplit('/', 1)[-1].split('?')[0]:
           possible_db = MONGO_URI.rsplit('/', 1)[-1].split('?')[0]
           if possible_db not in ('localhost:27017', ''):
               db_name = possible_db
               
        self.db = self.client[db_name]
        self.matches_col = self.db['matches']
        self.players_col = self.db['players']

    def fetch_player_history(self, riot_id: str) -> pd.DataFrame:
        """
        Fetches the complete match history for a given riot_id.
        """
        player = self.players_col.find_one({"riotId": riot_id.lower()})
        if not player:
            raise ValueError(f"Player {riot_id} not found in database.")

        cursor = self.matches_col.find({"player": player["_id"]}).sort("playedAt", 1)
        matches = list(cursor)
        
        if not matches:
            return pd.DataFrame()
            
        return pd.DataFrame(matches)

    def fetch_all_matches(self) -> pd.DataFrame:
        """
        Fetches all matches across all players. Useful for feature baselining.
        """
        cursor = self.matches_col.find()
        return pd.DataFrame(list(cursor))
