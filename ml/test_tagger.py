import pandas as pd
from models.weakness_tagger import WeaknessTagger

print("====== Testing Weakness Tagger with Live CSV Data ======\n")

df = pd.read_csv('data/training_features.csv')
wt = WeaknessTagger()

# We randomly sample 3 players from your live dataset
samples = df.sample(3)

for _, row in samples.iterrows():
    riot_id = row['riot_id']
    current_rank = row['target_rank']
    
    print(f"--- Player: {riot_id} (Currently: {current_rank}) ---")
    
    # We pass the player's stats dictionary directly into the tagger!
    tags = wt.tag_player(row.to_dict(), current_rank)
    
    for tag in tags:
        print(f"  > {tag}")
    print("\n")
