import hashlib
import hmac
import json
import os
import time

import httpx

from dotenv import load_dotenv


load_dotenv()


BASE_URL = os.getenv("DEEPSWAP_BASE_URL")
ACCESS_KEY = os.getenv("DEEPSWAP_ACCESS_KEY")
SECRET_KEY = os.getenv("DEEPSWAP_SECRET_KEY")


def _sign(
    method: str,
    uri: str,
    body: dict | None = None,
    query: str = ""
):

    timestamp = str(
        int(time.time() * 1000)
    )

    method = method.upper()

    if body is None:

        payload = ""

        sign_input = (
            f"{timestamp}"
            f"{method}"
            f"{uri}"
            f"{query}"
        )

    else:

        payload = json.dumps(
            body,
            separators=(",", ":")
        )

        sign_input = (
            f"{timestamp}"
            f"{method}"
            f"{uri}"
            f"{query}"
            f"payload={payload}"
        )

    signature = hmac.new(
        SECRET_KEY.encode(),
        sign_input.encode(),
        hashlib.sha256
    ).hexdigest()

    headers = {
        "X_API_KEY": ACCESS_KEY,
        "X_API_TS": timestamp,
        "X_API_SIGN": signature,
        "Content-Type": "application/json"
    }

    return headers, payload


async def post(
    uri: str,
    body: dict
):
    headers, payload = _sign(
        "POST",
        uri,
        body
    )

    async with httpx.AsyncClient() as client:

        response = await client.post(
            f"{BASE_URL}{uri}",
            headers=headers,
            content=payload
        )

        print("POST", uri)
        print("Request:", payload)
        print("Response:", response.text)

        response.raise_for_status()

        return response.json()


async def get(
    uri: str,
    query: str = ""
):
    headers, _ = _sign(
        "GET",
        uri,
        query=query
    )

    async with httpx.AsyncClient() as client:

        response = await client.get(
            f"{BASE_URL}{uri}",
            headers=headers,
            params=query
        )

        print("===================================")
        print("GET:", f"{BASE_URL}{uri}")
        print("STATUS:", response.status_code)
        print("BODY:")
        print(response.text)
        print("===================================")

        response.raise_for_status()

        return response.json()


async def create_material(
    image_url: str
):

    return await post(
        "/openapi/v1/face-swap/materials",
        {
            "url": image_url
        }
    )


async def get_material(
    material_id: str
):

    return await get(
        f"/openapi/v1/face-swap/materials/{material_id}"
    )

async def create_task(
    material_id: str,
    source_face_id: str,
    target_face_url: str
):

    return await post(
        "/openapi/v1/face-swap/tasks",
        {
            "materialId": int(material_id),
            "model": "shapetransformer3.1-fs",
            "faceEnhance": True,
            "faceMappings": [
                {
                    "sourceFaceId": int(source_face_id),
                    "targetFaceUrl": target_face_url
                }
            ]
        }
    )


async def get_task(task_id: str):
    return await get(
        f"/openapi/v1/tasks/{task_id}"
    )


async def create_text_to_video_task(
    prompt: str,
    reference_image_url: str | None = None,
    duration: int = 5
):

    payload = {
        "model": "deepvid2.0-t2v",
        "prompt": prompt,
        "duration": duration,
        "outputAudio": True,
        "promptEnhance": True
    }

    if reference_image_url:

        payload["media"] = [
            {
                "type": "referenceImage",
                "url": reference_image_url
            }
        ]

    return await post(
        "/openapi/v1/aigc/video-generation/tasks",
        payload
    )


async def get_video_task(
    task_id: str
):

    
    return await get(
        f"/openapi/v1/tasks/{task_id}"
    )


async def create_image_to_video_task(
    image_url: str,
    prompt: str,
    duration: int
):

    payload = {
        "model": "deepvid2.0-i2v",
        "prompt": prompt,
        "duration": duration,
        "media": [
            {
                "type": "firstFrame",
                "url": image_url
            }
        ],
        "outputAudio": True,
        "promptEnhance": True
    }

    return await post(
        "/openapi/v1/aigc/video-generation/tasks",
        payload
    )


async def create_video_extend_task(
    source_task_id: str,
    prompt: str,
    duration: int
):

    payload = {
        "model": "deepvid2.0-video-extend",
        "prompt": prompt,
        "duration": duration,
        "sourceTaskId": int(source_task_id),
        "outputAudio": True,
        "partialAudio": False,
        "promptEnhance": True
    }

    return await post(
        "/openapi/v1/aigc/video-generation/tasks",
        payload
    )
    

async def create_reference_to_video_task(
    reference_url: str,
    prompt: str,
    duration: int
):

    payload = {
        "model": "deepecho1.0-r2v",
        "prompt": prompt,
        "duration": duration,
        "resolution": "720p",
        "ratio": "16:9",
        "media": [
            {
                "type": "referenceImage",
                "url": reference_url
            }
        ]
    }

    return await post(
        "/openapi/v1/aigc/video-generation/tasks",
        payload
    )



async def create_text_to_image_task(
    prompt: str
):

    payload = {
        "model": "neoreal-girl2.0",
        "prompt": prompt,
        "size": "768:1152",
        "resultCount": 1
    }

    return await post(
        "/openapi/v1/aigc/image-generation/tasks",
        payload
    )