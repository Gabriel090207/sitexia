from fastapi import FastAPI
from pydantic import BaseModel

from playwright.async_api import async_playwright

from app.browser import get_auth_data
from app.config import settings
from app.resolver import resolve_task


class ResolveRequest(BaseModel):
    task_id: str


app = FastAPI()


@app.get("/")
async def root():
    return {
        "service": "BrowserWorker",
        "status": "online"
    }


@app.post("/resolve")
async def resolve(request: ResolveRequest):

    async with async_playwright() as playwright:

        browser = await playwright.chromium.connect_over_cdp(
            settings.chrome_debug_url
        )

        try:

            auth = await get_auth_data(browser)

            result = await resolve_task(
                request.task_id,
                auth
            )

            return result

        finally:

            await browser.close()