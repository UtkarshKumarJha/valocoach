import pandas as pd
from models.rank_predictor import RankPredictor

def main():
    print("Loading training dataset...")
    df = pd.read_csv('data/training_features.csv')
    print(f"Loaded {len(df)} rows from training_features.csv.")
    
    predictor = RankPredictor(model_path='data/rank_xgb.json')
    predictor.train(df)
    
if __name__ == '__main__':
    main()
