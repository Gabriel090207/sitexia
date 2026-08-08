from playwright.async_api import Browser, Page


async def get_deepswap_page(browser: Browser) -> Page:

    for context in browser.contexts:

        for page in context.pages:

            if (
                "deepswap.ai" in page.url
                and "face-swap" in page.url
            ):
                return page

    raise Exception("Nenhuma aba do DeepSwap foi encontrada.")


async def get_auth_data(browser: Browser) -> dict:

    cookies = await browser.contexts[0].cookies()

    auth = {}

    for cookie in cookies:

        if cookie["name"] == "access_token":
            auth["access_token"] = cookie["value"]

        elif cookie["name"] == "x-device-id":
            auth["x-device-id"] = cookie["value"]

    return auth