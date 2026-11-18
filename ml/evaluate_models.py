import os
import sqlite3
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from models.rank_predictor import RankPredictor, TIER_MAPPING
from models.weakness_tagger import WeaknessTagger
from models.agent_recommender import AgentRecommender

def evaluate_rank_predictor():
    print("\n[1] Evaluating RankPredictor (XGBoost)...")
    if not os.path.exists('data/training_features.csv'):
        print("Missing training_features.csv")
        return
        
    df = pd.read_csv('data/training_features.csv')
    df_clean = df.dropna(subset=['target_rank']).copy()
    df_clean = df_clean[df_clean['target_rank'].isin(TIER_MAPPING.keys())]
    df_clean['ordinal_rank'] = df_clean['target_rank'].map(TIER_MAPPING)
    
    drop_cols = ['target_rank', 'riot_id', 'ordinal_rank']
    drop_cols = [c for c in drop_cols if c in df_clean.columns]
    
    X = df_clean.drop(columns=drop_cols).select_dtypes(include=['number']).fillna(0)
    y = df_clean['ordinal_rank']
    
    # Same exact split used in training
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    ranker = RankPredictor(model_path='data/rank_xgb.json')
    if not getattr(ranker, 'model', None):
        print("Model not loaded properly.")
        return
        
    preds = ranker.model.predict(X_test)
    
    mae = mean_absolute_error(y_test, preds)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    r2 = r2_score(y_test, preds)
    
    print("-" * 30)
    print(f"MAE (Sub-Rank Miss):  {mae:.3f} Ranks")
    print(f"RMSE (Severity Miss): {rmse:.3f} Ranks")
    print(f"R² (Variance Expl.):  {r2:.3f} ({(r2*100):.1f}%)")
    print("-" * 30)

def evaluate_weakness_tagger():
    print("\n[2] Evaluating WeaknessTagger (Heuristic Baseline)...")
    if not os.path.exists('datasets/valorant.sqlite'):
        print("Missing valorant.sqlite")
        return
        
    tagger = WeaknessTagger(meta_path='data/weakness_baseline.json')
    
    conn = sqlite3.connect('datasets/valorant.sqlite')
    query = """
    SELECT 
        s.ACS,
        CAST(REPLACE(s.HS_Percent, '%', '') AS FLOAT) as hs_pct,
        CAST(REPLACE(s.KAST_Percent, '%', '') AS FLOAT) as kast_pct,
        (CAST(s.FirstKills AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as FirstKillRate,
        (CAST(s.FirstDeaths AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as FirstDeathRate,
        (CAST(s.Assists AS FLOAT) / (g.Team1_TotalRounds + g.Team2_TotalRounds)) as AssistRate,
        s.Plants,
        s.Defuses
    FROM Game_Scoreboard s
    JOIN Games g ON s.GameID = g.GameID
    WHERE g.Team1_TotalRounds IS NOT NULL
    LIMIT 500;
    """
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    perfect_matches = 0
    total = len(df)
    
    for _, row in df.iterrows():
        # Extrapolate to 10 match API dict
        features = {
            'hs_pct_mean_10': row['hs_pct'],
            'first_death_rate_mean_10': row['FirstDeathRate'],
            'first_blood_rate_mean_10': row['FirstKillRate'],
            'acs_mean_10': row['ACS'],
            'dmg_delta_mean_10': 10, # assume pros win duels
            'plants_mean_10': row['Plants'],
            'defuses_mean_10': row['Defuses'],
            'survival_rate_mean_10': row['kast_pct'],
            'assists_mean_10': row['AssistRate'] * 21
        }
        
        tags = tagger.tag_player(features, "Radiant")
        # Check if the tagger identifies them as perfect
        if "Game Sense and Mechanics align robustly with professional benchmarks." in tags:
            perfect_matches += 1
            
    acc = (perfect_matches / total) * 100 if total > 0 else 0
    print("-" * 30)
    print(f"Total Pros Tested: {total}")
    print(f"Perfect Alignment: {perfect_matches}")
    print(f"Pro Alignment Accuracy: {acc:.1f}%")
    print("-" * 30)

def evaluate_agent_recommender():
    print("\n[3] Evaluating AgentRecommender (Meta Prediction)...")
    vct_26_path = 'datasets/vct_2026/agents/agents_pick_rates.csv'
    
    if not os.path.exists(vct_26_path):
        print(f"Missing holdout dataset {vct_26_path}")
        return
        
    recommender = AgentRecommender(meta_path='data/agent_meta.json')
    
    try:
        df = pd.read_csv(vct_26_path)
        df['Pick Rate'] = df['Pick Rate'].astype(str).str.replace('%', '', regex=False)
        df['Pick Rate'] = pd.to_numeric(df['Pick Rate'], errors='coerce') / 100.0
        df = df[df['Map'].str.lower() != 'all maps']
        
        # Determine actual Top 1 Agent per Map
        actual_top_agents = df.loc[df.groupby('Map')['Pick Rate'].idxmax()]
        
        total_tests = 0
        successful_predictions = 0
        
        for _, row in actual_top_agents.iterrows():
            m = row['Map'].lower()
            a = row['Agent'].lower()
            
            # Predict
            # Since we don't know the exact role the pro team needed, 
            # we check if our RECOMMENDER top agent for ANY role matches the absolute top picked agent.
            found_in_top_recs = False
            for role in ['Duelist', 'Controller', 'Initiator', 'Sentinel']:
                recs = recommender.recommend(m, role)
                if any(a.capitalize() in r for r in recs):
                    found_in_top_recs = True
                    break
                    
            if found_in_top_recs:
                successful_predictions += 1
            total_tests += 1
            
        acc = (successful_predictions / total_tests) * 100 if total_tests > 0 else 0
        print("-" * 30)
        print(f"Total Maps Evaluated (VCT 2026): {total_tests}")
        print(f"Accurate Top-Tier Recommendations: {successful_predictions}")
        print(f"Meta Predictive Accuracy: {acc:.1f}%")
        print("-" * 30)
        
    except Exception as e:
        print(f"Evaluation Failed: {e}")

def main():
    print("==================================================")
    print("VALORANT ML - EMPIRICAL EVALUATION SUITE")
    print("==================================================")
    evaluate_rank_predictor()
    evaluate_weakness_tagger()
    evaluate_agent_recommender()
    print("==================================================")

if __name__ == '__main__':
    main()
