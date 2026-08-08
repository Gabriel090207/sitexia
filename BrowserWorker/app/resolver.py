import httpx


async def resolve_task(task_id: str, auth: dict):

    headers = {
        "Authorization": auth["access_token"],
        "X-Device-Id": auth["x-device-id"],
        "Accept": "application/json",
        "Origin": "https://www.deepswap.ai",
        "Referer": "https://www.deepswap.ai/",
    }

    async with httpx.AsyncClient(timeout=30) as client:

        response = await client.get(
            f"https://api.deepswap.net/fs/web/users/me/tasks/{task_id}?locale=en",
            headers=headers,
        )

        response.raise_for_status()

        data = response.json()["data"]

        return {
            "success": True,
            "task_id": data["id"],
            "status": data["status"],
            "file_url": data["fileUrl"],
            "cover_url": data["cover"]["url"],
            "material_id": data["materialId"],
        }