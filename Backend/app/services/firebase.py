import json
import os

import firebase_admin

from dotenv import load_dotenv
from firebase_admin import credentials
from firebase_admin import storage
from firebase_admin import firestore


load_dotenv()


if not firebase_admin._apps:

    if os.getenv("RENDER"):

        credentials_json = os.getenv(
            "FIREBASE_CREDENTIALS_JSON"
        )

        if not credentials_json:

            raise ValueError(
                "FIREBASE_CREDENTIALS_JSON não configurada."
            )

        cred = credentials.Certificate(
            json.loads(credentials_json)
        )

    else:

        cred = credentials.Certificate(
            "credentials/firebase-admin.json"
        )

    firebase_admin.initialize_app(
        cred,
        {
            "storageBucket": os.getenv(
                "FIREBASE_STORAGE_BUCKET"
            )
        }
    )


bucket = storage.bucket()
db = firestore.client()