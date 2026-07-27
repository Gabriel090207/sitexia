from fastapi import FastAPI

from app.services import firebase

from app.routes.upload import router as upload_router
from app.routes.swap import router as swap_router

from app.routes.video import router as video_router

app = FastAPI(
    title="Xia API",
    version="1.0.0"
)


@app.get("/")
async def root():

    return {
        "status": "online",
        "message": "Xia API está funcionando."
    }


app.include_router(upload_router)
app.include_router(swap_router)

app.include_router(video_router)