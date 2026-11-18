import pandas as pd
from models.rank_predictor import RankPredictor
from models.weakness_tagger import WeaknessTagger
from models.agent_recommender import AgentRecommender
import os

def main():
    print("=" * 50)
    print("VALORANT ML PIPELINE - FULL TRAINING SEQUENCE")
    print("=" * 50)
    
    all_success = True
    
    # 1. Rank Predictor (Requires building and saving xgboost tree from CSV)
    print("\n[1/3] Training Rank Predictor (XGBoost)...")
    try:
        if not os.path.exists('data/training_features.csv'):
            print("ERROR: data/training_features.csv not found!")
            all_success = False
        else:
            df = pd.read_csv('data/training_features.csv')
            print(f"Loaded {len(df)} rows from training_features.csv.")
            ranker = RankPredictor(model_path='data/rank_xgb.json')
            ranker.train(df)
    except Exception as e:
        print(f"Failed to train RankPredictor: {e}")
        all_success = False
        
    # 2. Weakness Tagger (Requires running heavy medians query on valorant.sqlite)
    print("\n[2/3] Training Weakness Tagger (SQLite DB Extraction)...")
    try:
        tagger = WeaknessTagger(meta_path='data/weakness_baseline.json')
        tagger.train(db_path='datasets/valorant.sqlite')
    except Exception as e:
        print(f"Failed to train WeaknessTagger: {e}")
        all_success = False
        
    # 3. Agent Recommender (Requires globbing thousands of VCT matches)
    print("\n[3/3] Training Agent Recommender (VCT CSV Aggregation)...")
    try:
        agent_rec = AgentRecommender(meta_path='data/agent_meta.json')
        agent_rec.train()
    except Exception as e:
        print(f"Failed to train Agent Recommender: {e}")
        all_success = False
        
    print("\n" + "=" * 50)
    if all_success:
        print("ALL MODELS PRE-TRAINED SUCCESSFULLY & READY!")
        print("You can safely boot the FastAPI server using:")
        print("uvicorn app:app --port 8000")
    else:
        print("PIPELINE FAILED: ONE OR MORE TRAINING TARGETS ENCOUNTERED ERRORS.")
        print("Please investigate the logs above before booting the server.")
    print("=" * 50)

if __name__ == '__main__':
    main()
