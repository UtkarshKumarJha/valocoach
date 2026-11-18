# Rank Predictor (XGBoost)
import os
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import numpy as np

TIER_MAPPING = {
    'Iron 1': 0, 'Iron 2': 1, 'Iron 3': 2,
    'Bronze 1': 3, 'Bronze 2': 4, 'Bronze 3': 5,
    'Silver 1': 6, 'Silver 2': 7, 'Silver 3': 8,
    'Gold 1': 9, 'Gold 2': 10, 'Gold 3': 11,
    'Platinum 1': 12, 'Platinum 2': 13, 'Platinum 3': 14,
    'Diamond 1': 15, 'Diamond 2': 16, 'Diamond 3': 17,
    'Ascendant 1': 18, 'Ascendant 2': 19, 'Ascendant 3': 20,
    'Immortal 1': 21, 'Immortal 2': 22, 'Immortal 3': 23,
    'Radiant': 24
}

REVERSE_TIER = {v: k for k, v in TIER_MAPPING.items()}

class RankPredictor:
    def __init__(self, model_path='data/rank_xgb.json'):
        self.model_path = model_path
        self.model = xgb.XGBRegressor(
            objective='reg:squarederror', 
            n_estimators=100,
            learning_rate=0.05,
            max_depth=5
        )
        
        if os.path.exists(self.model_path):
            try:
                self.model.load_model(self.model_path)
            except Exception:
                pass

    def train(self, df: pd.DataFrame):
        """
        Trains the XGBoost Regressor to predict ordinal ranks.
        """
        print(f"Preparing {len(df)} rows for training...")
        
        # Clean data
        df_clean = df.dropna(subset=['target_rank']).copy()
        df_clean = df_clean[df_clean['target_rank'].isin(TIER_MAPPING.keys())]
        
        # Map targets to ordinal numerics
        df_clean['ordinal_rank'] = df_clean['target_rank'].map(TIER_MAPPING)
        
        # Drop identifiers and targets
        drop_cols = ['target_rank', 'riot_id', 'ordinal_rank']
        drop_cols = [c for c in drop_cols if c in df_clean.columns]
        
        X = df_clean.drop(columns=drop_cols)
        y = df_clean['ordinal_rank']
        
        # We need numeric features only
        X = X.select_dtypes(include=['number']).fillna(0)
        
        # 80% Train, 10% Validation, 10% Test
        X_temp, X_test, y_temp, y_test = train_test_split(X, y, test_size=0.1, random_state=42)
        X_train, X_val, y_train, y_val = train_test_split(X_temp, y_temp, test_size=0.111, random_state=42)
        
        # Reset the model completely here so we discard any previously loaded JSON tree structure
        # This prevents the 'expected 22, got 49' dimension mismatch errors.
        self.model = xgb.XGBRegressor(
            objective='reg:squarederror', 
            n_estimators=100,
            learning_rate=0.05,
            max_depth=5,
            early_stopping_rounds=10
        )
        
        if len(X_train) < 10:
            print("Not enough data to train yet. Returning early.")
            return

        print(f"Training on {len(X_train)} samples, Validating on {len(X_val)} samples...")
        self.model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False
        )
        
        # Evaluate exclusively on Blind Test Set
        preds = self.model.predict(X_test)
        mae = mean_absolute_error(y_test, preds)
        rmse = np.sqrt(mean_squared_error(y_test, preds))
        r2 = r2_score(y_test, preds)
        
        print("  -> BLIND TEST METRICS:")
        print(f"  -> MAE (Sub-Rank Miss):  {mae:.3f} Ranks")
        print(f"  -> RMSE (Severity Miss): {rmse:.3f} Ranks")
        print(f"  -> R² (Variance Expl.):  {r2:.3f}")
        
        # Ensure data directory exists
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        self.model.save_model(self.model_path)
        print(f"Model saved to {self.model_path}")
        
    def predict(self, features_dict: dict) -> dict:
        """
        Takes a single player's engineered features dictionary and returns 
        the predicted textual rank and the continuous float calculation.
        """
        df_single = pd.DataFrame([features_dict])
        
        # Ensure we have all columns the model was trained on
        expected_cols = getattr(self.model, 'feature_names_in_', [])
        if len(expected_cols) > 0:
            # Reindex to match the exact columns the model expects, fill missing with 0
            df_single = df_single.reindex(columns=expected_cols, fill_value=0)
        else:
            drop_cols = ['target_rank', 'riot_id']
            drop_cols = [c for c in drop_cols if c in df_single.columns]
            df_single = df_single.drop(columns=drop_cols).select_dtypes(include=['number']).fillna(0)
            
        X = df_single
        
        pred_val = self.model.predict(X)[0]
        
        # Clamp between 0 and 24
        pred_clamped = max(0.0, min(24.0, float(pred_val)))
        
        # Round to nearest integer to get textual rank
        pred_int = int(round(pred_clamped))
        predicted_rank = REVERSE_TIER.get(pred_int, "Unknown")
        
        return {
            "prediction_value": pred_clamped,
            "predicted_rank": predicted_rank
        }
