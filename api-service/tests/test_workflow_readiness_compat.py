import hashlib
import json

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


USER_ID = 7
PROJECT_ID = 8
AUTH = {"Authorization": "Bearer session-token"}


class WorkflowReadinessDatabase:
    def __init__(self):
        self.parsed_fingerprint = ""
        self.scenes = [{
            "id": 31, "episode_no": 1, "scene_no": 1,
            "title": "楼道", "summary": "夜间楼道", "content": "沈岚推开门。",
        }]
        self.characters = [{"id": 41}]
        self.nodes = [
            {"id": 51, "node_type": "character", "ref_id": 41, "group_key": "character:41", "label": "沈岚", "has_confirmed_image": 0},
            {"id": 52, "node_type": "scene", "ref_id": 31, "group_key": "scene:31", "label": "楼道", "has_confirmed_image": 0},
        ]

    def find_user_by_token(self, token):
        return {"id": USER_ID, "phone": "13900000000"} if token == "session-token" else None

    def get_project(self, project_id, user_id):
        return {"id": PROJECT_ID, "user_id": USER_ID, "name": "test"} if project_id == PROJECT_ID and user_id == USER_ID else None

    def get_project_workflow_readiness_context(self, project_id, user_id):
        return {
            "scenes": self.scenes,
            "parsed_fingerprint": self.parsed_fingerprint,
            "characters": self.characters,
            "asset_nodes": self.nodes,
        }

    def persist_parsed_script_fingerprint(self, project_id, user_id):
        if project_id != PROJECT_ID or user_id != USER_ID:
            return "not_found"
        if not self.scenes or any(not str(scene.get("content") or "").strip() for scene in self.scenes):
            return "script_incomplete"
        character_refs = {int(node["ref_id"]) for node in self.nodes if node["node_type"] == "character" and node.get("ref_id")}
        scene_refs = {int(node["ref_id"]) for node in self.nodes if node["node_type"] == "scene" and node.get("ref_id")}
        if any(int(character["id"]) not in character_refs for character in self.characters) or any(int(scene["id"]) not in scene_refs for scene in self.scenes):
            return "assets_incomplete"
        self.parsed_fingerprint = hashlib.sha256(json.dumps([{
            "id": scene["id"], "episodeNo": scene["episode_no"], "sceneNo": scene["scene_no"],
            "title": scene["title"].strip(), "summary": scene["summary"].strip(), "content": scene["content"].strip(),
        } for scene in self.scenes], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        return "saved"


def make_client(database=None):
    return TestClient(create_app(Settings(_env_file=None), database=database or WorkflowReadinessDatabase()), raise_server_exceptions=False)


def test_workflow_readiness_routes_require_authentication():
    client = make_client()
    assert client.get(f"/api/projects/{PROJECT_ID}/workflow-readiness").status_code == 401
    assert client.post(f"/api/projects/{PROJECT_ID}/workflow-readiness/parse-complete").status_code == 401


def test_parse_complete_persists_current_script_fingerprint_and_opens_asset_gate():
    database = WorkflowReadinessDatabase()
    client = make_client(database)

    response = client.post(f"/api/projects/{PROJECT_ID}/workflow-readiness/parse-complete", headers=AUTH)

    assert response.status_code == 200
    assert database.parsed_fingerprint == hashlib.sha256(json.dumps([{
        "id": 31, "episodeNo": 1, "sceneNo": 1,
        "title": "楼道", "summary": "夜间楼道", "content": "沈岚推开门。",
    }], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    gates = client.get(f"/api/projects/{PROJECT_ID}/workflow-readiness", headers=AUTH).json()["data"]
    assert gates["assets"]["allowed"] is True
    assert gates["storyboard"]["allowed"] is False


def test_parse_complete_rejects_incomplete_script_without_saving_fingerprint():
    database = WorkflowReadinessDatabase()
    database.scenes[0]["content"] = "  "
    client = make_client(database)

    response = client.post(f"/api/projects/{PROJECT_ID}/workflow-readiness/parse-complete", headers=AUTH)

    assert response.status_code == 409
    assert database.parsed_fingerprint == ""
