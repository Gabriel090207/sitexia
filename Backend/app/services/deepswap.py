import hashlib
import hmac
import json
import logging
from contextvars import ContextVar
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


logger = logging.getLogger(__name__)
_transport_private = ContextVar("deepswap_private_logging", default=False)


class _PrivateTransportLogs(logging.Filter):
    def filter(self, record):
        # httpx INFO includes the full URL; httpcore DEBUG can include headers.
        # Only suppress transport diagnostics in this async request context.
        return not _transport_private.get()


for _name in ("httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2",
              "httpcore.proxy", "httpcore.socks"):
    logging.getLogger(_name).addFilter(_PrivateTransportLogs())


def _operation(uri):
    # Never log caller-supplied paths, query strings, task IDs or model names.
    if uri == "/openapi/v1/aigc/image-generation/tasks":
        return "image_creation"
    if uri == "/openapi/v1/aigc/video-generation/tasks":
        return "video_creation"
    if uri == "/openapi/v1/face-swap/tasks":
        return "face_swap_creation"
    if uri == "/openapi/v1/face-swap/materials":
        return "material_creation"
    if uri.startswith("/openapi/v1/face-swap/materials/"):
        return "material_status"
    if uri.startswith("/openapi/v1/tasks/"):
        return "task_status"
    return "provider_request"


def _safe_exception(error):
    # Preserve the HTTP classification and response for existing callers, but
    # never let the default exception text print a URL or provider body.
    if isinstance(error, httpx.HTTPStatusError):
        return httpx.HTTPStatusError("DeepSwap HTTP failure.", request=error.request, response=error.response)
    if isinstance(error, httpx.RequestError):
        return type(error)("DeepSwap transport failure.", request=error.request)
    if isinstance(error, json.JSONDecodeError):
        return json.JSONDecodeError("Invalid DeepSwap JSON response", "", 0)
    if isinstance(error, ValueError):
        return ValueError("Invalid DeepSwap response.")
    return RuntimeError("DeepSwap request failed.")


async def _request(method, uri, body=None, query=""):
    started = time.monotonic()
    operation = _operation(uri)
    code = None
    context = _transport_private.set(True)
    try:
        headers, payload = _sign(method, uri, body, query)
        async with httpx.AsyncClient() as client:
            if method == "POST":
                response = await client.post(f"{BASE_URL}{uri}", headers=headers, content=payload)
            else:
                response = await client.get(f"{BASE_URL}{uri}", headers=headers, params=query)
            code = response.status_code
            response.raise_for_status()
            result = response.json()
        status = result.get("taskStatus", result.get("status")) if isinstance(result, dict) else None
        status = status if isinstance(status, str) and status in {"PENDING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"} else "UNSPECIFIED"
        logger.info("DeepSwap operation=%s method=%s http_status=%s task_status=%s duration_ms=%d",
                    operation, method, code, status, (time.monotonic() - started) * 1000)
        return result
    except Exception as error:
        category = ("http" if isinstance(error, httpx.HTTPStatusError) else
                    "timeout" if isinstance(error, httpx.TimeoutException) else
                    "network" if isinstance(error, httpx.RequestError) else
                    "invalid_response" if isinstance(error, (ValueError, json.JSONDecodeError)) else "unexpected")
        logger.warning("DeepSwap operation=%s method=%s http_status=%s error_category=%s duration_ms=%d",
                       operation, method, code, category, (time.monotonic() - started) * 1000)
        raise _safe_exception(error) from None
    finally:
        _transport_private.reset(context)


async def post(uri: str, body: dict):
    return await _request("POST", uri, body)


async def get(uri: str, query: str = "", *, log_response: bool = True):
    # Keep the legacy argument for callers; response bodies are never logged.
    return await _request("GET", uri, query=query)


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
        f"/openapi/v1/face-swap/materials/{material_id}",
        log_response=False,
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
    task_id: str,
    *,
    log_response: bool = False,
):

    
    return await get(
        f"/openapi/v1/tasks/{task_id}",
        log_response=log_response,
    )


async def create_image_to_video_task(
    image_url: str,
    prompt: str,
    duration: int
):

    payload = {
        "model": "deepvid3.0-i2v",
        "prompt": prompt,
        "duration": duration,
        "media": [
            {
                "type": "firstFrame",
                "url": image_url
            }
        ],
        "outputAudio": True
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
    prompt: str,
    model: str,
    size: str,
    result_count: int
):

    payload = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "resultCount": result_count
    }

    return await post(
        "/openapi/v1/aigc/image-generation/tasks",
        payload
    )
