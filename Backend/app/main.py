from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.services import firebase

from app.routes.upload import router as upload_router
from app.routes.swap import router as swap_router
from app.routes.video import router as video_router
from app.routes.subscription import router as subscription_router

app = FastAPI(
    title="Xia API",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://xiaswap.netlify.app",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
app.include_router(subscription_router)