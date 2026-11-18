from models.agent_recommender import AgentRecommender

print("====== Testing Agent Recommender with Live VCT Data ======\n")

ar = AgentRecommender()

# Testing some map/role constraints
print("\n--- Ascent (Controller) ---")
for rec in ar.recommend('ascent', 'Controller'):
    print(f"  > {rec}")

print("\n--- Icebox (Initiator) ---")
for rec in ar.recommend('icebox', 'Initiator'):
    print(f"  > {rec}")
    
print("\n--- Bind (Duelist) ---")
for rec in ar.recommend('bind', 'Duelist'):
    print(f"  > {rec}")
