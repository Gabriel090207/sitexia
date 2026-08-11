import os

import httpx

from dotenv import load_dotenv

load_dotenv()

BROWSER_WORKER_URL = os.getenv(
    "BROWSER_WORKER_URL"
)

async def resolve_task(
    task_id: str
):

    async with httpx.AsyncClient(timeout=30) as client:

        response = await client.post(
            f"{BROWSER_WORKER_URL}/resolve",
            json={
                "task_id": task_id
            }
        )

        response.raise_for_status()

        return response.json()