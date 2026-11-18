from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional

# Import local models
from models.rank_predictor import RankPredictor
from models.weakness_tagger import WeaknessTagger
from models.agent_recommender import AgentRecommender
from models.sequence_analyzer import SequenceAnalyzer
from feature_engineer import FeatureEngineer
import pandas as pd

app = FastAPI(title="ValoCoach ML Engine", version="1.0.0")

# Pre-load models into memory lazily
print("Loading ML models for FastAPI server...")
feature_engineer = FeatureEngineer()
rank_predictor = RankPredictor(model_path='data/rank_xgb.json')
weakness_tagger = WeaknessTagger(meta_path='data/weakness_baseline.json')
agent_recommender = AgentRecommender(meta_path='data/agent_meta.json')
sequence_analyzer = SequenceAnalyzer(model_path='data/valo_transformer.onnx')
print("Model loading complete.")

class PredictRequest(BaseModel):
    riot_id: str
    current_rank: str
    features: Dict[str, Any]
    map_name: Optional[str] = "ascent"
    preferred_role: Optional[str] = "Controller"

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "ValoCoach ML Engine"}

@app.post("/predict")
def predict_player_stats(req: PredictRequest):
    try:
        # 1. Predict Rank
        rank_res = rank_predictor.predict(req.features)
        
        # 2. Extract Weaknesses
        tags = weakness_tagger.tag_player(req.features, req.current_rank)
        
        # 3. Agent Recommendation
        agents = agent_recommender.recommend(req.map_name, req.preferred_role)

        # Assemble final structured payload
        return {
            "player": req.riot_id,
            "rank_estimate": rank_res.get('predicted_rank', 'Unknown'),
            "actual_rank": req.current_rank,
            "rank_gap_value": rank_res.get('prediction_value', 0), # Added raw value for Node to calculate tiers
            "weakness_tags": tags,
            "agent_recommendations": agents
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class AnalyzeMatchesRequest(BaseModel):
    riot_id: str
    current_rank: str
    matches: list
    map_name: Optional[str] = "ascent"
    preferred_role: Optional[str] = "Controller"

@app.post("/analyze_matches")
def analyze_matches(req: AnalyzeMatchesRequest):
    try:
        # Convert raw Match JSON list to DataFrame
        df = pd.DataFrame(req.matches)
        
        # Calculate engineered features
        features = feature_engineer.compute_features(df, req.riot_id)
        if not features:
            raise HTTPException(status_code=400, detail="Not enough valid matches to compute features")

        # 1. Predict Rank
        rank_res = rank_predictor.predict(features)
        
        # 2. Extract Weaknesses
        tags = weakness_tagger.tag_player(features, req.current_rank)
        
        # 3. Agent Recommendation
        agents = agent_recommender.recommend(req.map_name, req.preferred_role)

        # 4. Neural Sequence Analysis (Momentum Curve & Tilt Inflection)
        recent_rounds = req.matches[0].get('rounds', []) if (req.matches and isinstance(req.matches[0], dict)) else []
        sequence_res = sequence_analyzer.analyze(recent_rounds, player_riot_id=req.riot_id)

        return {
            "player": req.riot_id,
            "rank_estimate": rank_res.get('predicted_rank', 'Unknown'),
            "actual_rank": req.current_rank,
            "rank_gap_value": rank_res.get('prediction_value', 0),
            "weakness_tags": tags,
            "agent_recommendations": agents,
            "computed_features": features,
            "sequence_analytics": sequence_res
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

