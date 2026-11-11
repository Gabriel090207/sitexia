"""Explicit demo-only Admin SDK proof, run inside emulators:exec (not discovery)."""
import os
from uuid import uuid4

PROJECT = "demo-xiaswap-financial-rules"
if (os.environ.get("GCLOUD_PROJECT") != PROJECT
        or os.environ.get("FIRESTORE_EMULATOR_HOST") != "127.0.0.1:9498"):
    raise RuntimeError("Requires dedicated demo Firestore Emulator")

import firebase_admin
from firebase_admin import credentials, firestore
from google.auth.credentials import AnonymousCredentials


class EmulatorCredentials(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


app = firebase_admin.initialize_app(EmulatorCredentials(), {"projectId": PROJECT}, name="rules-admin-proof")
db = firestore.client(app)
uid = "synthetic-admin-" + uuid4().hex
user = db.collection("users").document(uid)
generation = db.collection("generations").document(uid)
payment = db.collection("topups").document(uid)
try:
    user.set({"uid": uid, "credits": 10, "reservedCredits": 2})
    user.update({"credits": 9, "reservedCredits": 0})
    generation.set({"userId": uid, "creditStatus": "charged", "cost": 1})
    payment.set({"uid": uid, "status": "approved", "creditsApplied": True})
    assert user.get().to_dict()["credits"] == 9
    assert user.get().to_dict()["reservedCredits"] == 0
    assert generation.get().to_dict()["creditStatus"] == "charged"
    assert payment.get().to_dict()["creditsApplied"] is True
    print("PASS: real Admin SDK emulator writes bypass client rules; four assertions passed")
finally:
    for reference in (user, generation, payment):
        reference.delete()
    db.close()
    firebase_admin.delete_app(app)
